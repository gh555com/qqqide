// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// remote-cmd.ts — 设备级指令执行机（壳层通道，2026-09-28）
//
// 定位: ping 响应携带的 per-device 定向指令（运维台「点名救援」）在本机的执行器 +
//   回执机。与启动器通道（launcher.c 的 dev/{device_id}.json）互补——
//   - 壳层通道: 链没坏、状态卡（增量状态损坏 / 失败计数残留 / 启动器未换）→ 热修复
//   - 启动器通道: 壳层死而启动器活 → 启动器自己全量自愈（其 ack 由本机收割回报）
//
// 协议（与 handlers_wq.go / launcher.c 三处同契）:
//   下行: ping 响应 commands: [{id, action, args}]（≤5 条/次；at-least-once 直到 ack）
//   上行: 下次 ping 请求 cmd_acks: [{id, ok, detail, src, t}]（≤32 条队列，成功发出即清）
//   状态: {Data}/alphal/remote-cmd.json（done 去重 / acks 队列 / diag 旗标，跨重启）
//   启动器回执: {Data}/launcher-cmd-ack.json（读后即删，并入 acks 队列）
//
// 动作（白名单；未知动作回 nack 不回执成功）:
//   force_full    清增量状态（Data/units.json）+ 跳过增量直走全量 r（重下+验签+staged）
//   clear_fails   清零 .apply-fails（启动窗红行 / 应急门槛的失败计数）
//   heal_launcher 根启动器热修复重放（live 直供 + 根替换）
//   diag          下次 ping 携带扩展诊断（upd_diag）
//
// 安全: 指令只能触发本机已有能力（全量自愈链 = 签名校验不变），无法注入任意代码；
//   重放由 done 去重（持久化）；执行串行单飞；一切失败静默落 ack，绝不影响主链路。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';

type ExecResult = { ok: boolean; detail: string };
type Executor = (args: unknown) => ExecResult | Promise<ExecResult>;

export interface RemoteCmdAck { id: string; ok: boolean; detail: string; src: string; t: number; }

const ALLOWED = new Set(['force_full', 'clear_fails', 'heal_launcher', 'diag']);
const DONE_CAP = 64;          // 去重清单容量（LRU）
const ACK_CAP = 32;           // 回执队列容量（LRU）
const MAX_PER_PING = 5;       // 单次执行上限（服务端也限 5）

const _executors: Record<string, Executor> = {};
export function registerRemoteExecutor(action: string, fn: Executor): void { _executors[action] = fn; }

let _dataDir = '';
let _done: string[] = [];
let _acks: RemoteCmdAck[] = [];
let _wantDiag = false;
const _inflight = new Set<string>();
let _chain: Promise<boolean> = Promise.resolve(false);

function statePath(): string { return path.join(_dataDir, 'alphal', 'remote-cmd.json'); }
function launcherAckPath(): string { return path.join(_dataDir, 'launcher-cmd-ack.json'); }

// ── 状态持久化（tmp+rename 原子；一切失败静默）────────────────────────────
function loadState(): void {
    try {
        const j = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        if (j && Array.isArray(j.done)) _done = j.done.filter((x: unknown) => typeof x === 'string').slice(-DONE_CAP);
        if (j && Array.isArray(j.acks)) {
            _acks = j.acks.filter((a: any) => a && typeof a.id === 'string').slice(-ACK_CAP);
        }
        if (j && typeof j.wantDiag === 'boolean') _wantDiag = j.wantDiag;
    } catch { /* 无状态/损坏 → 空态 */ }
}

function saveState(): void {
    if (!_dataDir) return;
    try {
        const p = statePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ done: _done, acks: _acks, wantDiag: _wantDiag }), 'utf8');
        fs.renameSync(tmp, p);
    } catch { /* ignore */ }
}

/** 注入数据目录（wq-ping 启动时调用；= {包}/gh555.com/Data 或 dev 同层） */
export function remoteCmdConfigure(dataDir: string): void {
    _dataDir = dataDir || '';
    if (!_dataDir) return;
    loadState();
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) : s; }

// ── 启动器通道回执收割（launcher-cmd-ack.json → acks 队列，读后即删）──────
function harvestLauncherAck(): void {
    if (!_dataDir) return;
    const p = launcherAckPath();
    try {
        if (!fs.existsSync(p)) return;
        const raw = fs.readFileSync(p, 'utf8');
        const j = JSON.parse(raw);
        fs.unlinkSync(p);
        if (!j || typeof j.id !== 'string' || !j.id) return;
        if (_done.includes(j.id) || _acks.some(a => a.id === j.id)) return;
        const state = typeof j.state === 'string' && j.state ? j.state : 'invoked';
        _acks.push({
            id: j.id,
            ok: state !== 'invoked-noop',
            detail: 'launcher: ' + truncate(state, 64),
            src: 'launcher',
            t: Math.floor(Date.now() / 1000),
        });
        if (_acks.length > ACK_CAP) _acks = _acks.slice(-ACK_CAP);
        saveState();
    } catch {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
}

/** ping 组装用: 当前待回执（≤10/次；顺带收割启动器回执） */
export function collectAckPayload(): RemoteCmdAck[] | null {
    harvestLauncherAck();
    if (!_acks.length) return null;
    return _acks.slice(0, 10);
}

/** ping 成功且服务端确认入账（cmd_acks_ok）: 清掉已发出的回执 */
export function markAcksSent(sentIds: string[]): void {
    if (!_dataDir || !sentIds || !sentIds.length) return;
    const set = new Set(sentIds);
    _acks = _acks.filter(a => !set.has(a.id));
    saveState();
}

export function isDiagWanted(): boolean { harvestLauncherAck(); return _wantDiag; }
export function clearDiagWantSent(): void { if (_wantDiag) { _wantDiag = false; saveState(); } }

// diag 执行器（自包含——只置旗标，数据由 wq-ping collectUpdHealth 附加）
registerRemoteExecutor('diag', () => {
    _wantDiag = true;
    saveState();
    return { ok: true, detail: 'diag flag set (next ping carries upd_diag)' };
});

// ── 指令执行（串行链；返回「是否有指令被处理」——用于加速回执 ping）──────────
const TIMEOUT_ACTIONS = new Set(['clear_fails', 'heal_launcher', 'diag']);   // 快动作 30s 超时；force_full 由更新器自身超时管辖

export function handleIncomingCommands(cmds: unknown): Promise<boolean> {
    if (!Array.isArray(cmds) || cmds.length === 0) return Promise.resolve(false);
    const batch = cmds.slice(0, MAX_PER_PING).filter(
        (c): c is { id: string; action?: unknown; args?: unknown } =>
            !!c && typeof (c as any).id === 'string',
    );
    if (batch.length === 0) return Promise.resolve(false);

    _chain = _chain.then(async () => {
        let processed = false;
        for (const raw of batch) {
            const id = String(raw.id);
            const action = String((raw as any).action || '');
            if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) continue;
            if (_done.includes(id) || _inflight.has(id)) continue;
            _inflight.add(id);
            let res: ExecResult = { ok: false, detail: 'unknown action: ' + truncate(action, 32) };
            if (ALLOWED.has(action)) {
                const fn = _executors[action];
                if (!fn) {
                    res = { ok: false, detail: 'no executor for ' + action };
                } else {
                    try {
                        const p = Promise.resolve(fn((raw as any).args));
                        if (TIMEOUT_ACTIONS.has(action)) {
                            res = await Promise.race([
                                p,
                                new Promise<ExecResult>((resolve) => {
                                    setTimeout(() => resolve({ ok: false, detail: 'timeout (30s)' }), 30_000);
                                }),
                            ]);
                        } else {
                            res = await p;
                        }
                    } catch (e: any) {
                        res = { ok: false, detail: 'exception: ' + truncate(String((e && e.message) || e), 100) };
                    }
                }
            }
            _inflight.delete(id);
            _done.push(id);
            if (_done.length > DONE_CAP) _done = _done.slice(-DONE_CAP);
            _acks.push({
                id,
                ok: !!res.ok,
                detail: truncate(String(res.detail || ''), 140),
                src: 'shell',
                t: Math.floor(Date.now() / 1000),
            });
            if (_acks.length > ACK_CAP) _acks = _acks.slice(-ACK_CAP);
            processed = true;
            saveState();
        }
        return processed;
    }).catch(() => false);
    return _chain;
}
