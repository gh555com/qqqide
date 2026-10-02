// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// syspy-report.ts — 系统解释器失败采样机（本地报告 + ping 搭车诊断，2026-10-02）
//
// 定位:「做系统 Node/Python 解释器」（shell/ipc-syspy.ts）失败数据的唯一本地真理源 +
//   远程暴露载荷生成器——客户机器上一次失败，回传三件事：卡在哪级（via）、系统最终把
//   .js/.py 解析成了什么（aq）、进程里被吞掉的真实报错（err/PSERR）。
//
//   ① recordSyspyEvent(): 每次 check/apply/remove 结束即滚动落盘（失败环 ≤8 条 + 每目标最近结果）
//      → {dataDir}/alphal/syspy-report.json（tmp+rename 原子写；一切异常静默，绝不影响主流程）
//   ② 任何失败 → pending 旗标 → wq-ping 下次 ping 自动搭车 upd_diag（ipc-syspy 触发即时补发；
//      服务端 qqqide_upd_health.upd_diag 落列已部署，零服务端改动）
//   ③ buildSpyTokens(): 紧凑 token 段（spyn/spyp=目标op:码:阶梯级:计数:龄 / spye=环境 /
//      spyaq=系统最终解析 / spyuc=UserChoice 终态 / spyr=错误尾）——buildDiag 置于首位防截断
//   ④ 本地查看 = 升级诊断查看器第 10 件（shell/update-health.ts）；远程消费 = gaea 升级救援台.py
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { APP_VERSION } from './version';

export interface SyspyEnv {
    eng?: number;        // engines 根目录存在
    man?: number;        // engines/manifest.json 存在
    py?: number;         // python 组件二进制存在
    fac?: number;        // 本目标可执行（node=门面 / python=内置解释器）存在
    facPath?: string;    // 本目标解析出的绝对路径（本地报告留档，不进 diag token）
}

export interface SyspyEvent {
    tg: 'python' | 'node';
    op: 'check' | 'apply' | 'remove';
    ok: boolean;
    code?: string;       // 失败码（no-node / verify-failed / uac-cancelled / denied / timeout ...）
    via?: string;        // apply 阶梯级（v1 / v0 / nouc / fex / hklm ...）
    err?: string;        // PSERR / stderr 尾（真实报错）
    aq?: string;         // 系统最终解析（AssocQueryString 结果原文）
    aqRc?: number;       // AQ 查询返回码
    uc?: string;         // UserChoice 终态 ProgId
    exeOk?: boolean;     // check 用：目标二进制在位
    env?: SyspyEnv;      // 失败时的环境快照
}

interface SyspyLast {
    op: string;
    ok: boolean;
    code: string;
    via?: string;
    t: number;
}

interface SyspyFailEntry {
    tg: string;
    op: string;
    code: string;
    via?: string;
    aqRc?: number;
    aq?: string;
    err?: string;
    uc?: string;
    env?: SyspyEnv;
    n: number;           // 同码重复计数（去重窗内合并）
    t: number;           // 最近一次发生时间（ms）
}

export interface SyspyReport {
    v: 1;
    ver: string;
    platform: string;
    os: string;
    pending: boolean;    // 有未上报失败 → wq-ping 下次 ping 搭车 upd_diag
    last: Record<string, SyspyLast>;
    fails: SyspyFailEntry[];
}

const FAIL_CAP = 8;                  // 失败环容量（滚动）
const DEDUP_MS = 20 * 60 * 1000;     // 同码去重窗：窗内重复只加计数（防静默复查刷屏）

function fileOf(dataDir: string): string {
    return path.join(dataDir, 'alphal', 'syspy-report.json');
}

export function readSyspyReport(dataDir: string): SyspyReport | null {
    try {
        const j = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
        if (j && typeof j === 'object') return j as SyspyReport;
    } catch { /* 无报告/损坏 → null */ }
    return null;
}

function save(dataDir: string, r: SyspyReport): void {
    try {
        const p = fileOf(dataDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(r), 'utf8');
        fs.renameSync(tmp, p);
    } catch { /* 遥测落盘失败静默 */ }
}

/** 记录一次 check/apply/remove 结果（成功只刷 last；失败进环 + pending）。 */
export function recordSyspyEvent(dataDir: string, evt: SyspyEvent): void {
    if (!dataDir || !evt || !evt.tg) return;
    try {
        const now = Date.now();
        let r = readSyspyReport(dataDir);
        if (!r || r.v !== 1 || !r.last || !Array.isArray(r.fails)) {
            r = { v: 1, ver: APP_VERSION, platform: process.platform, os: os.release().slice(0, 30), pending: false, last: {}, fails: [] };
        }
        r.ver = APP_VERSION;
        const code = String(evt.code || '').slice(0, 40);
        r.last[evt.tg] = { op: evt.op, ok: !!evt.ok, code, via: String(evt.via || '').slice(0, 24), t: now };
        if (!evt.ok) {
            r.pending = true;
            const entry: SyspyFailEntry = {
                tg: evt.tg, op: evt.op, code,
                via: evt.via ? String(evt.via).slice(0, 24) : undefined,
                aqRc: (typeof evt.aqRc === 'number' && Number.isFinite(evt.aqRc)) ? evt.aqRc : undefined,
                aq: evt.aq ? String(evt.aq).slice(0, 200) : undefined,
                err: evt.err ? String(evt.err).slice(0, 220) : undefined,
                uc: evt.uc ? String(evt.uc).slice(0, 60) : undefined,
                env: evt.env,
                n: 1, t: now,
            };
            const lastE = r.fails[r.fails.length - 1];
            if (lastE && lastE.tg === entry.tg && lastE.op === entry.op && lastE.code === entry.code &&
                (lastE.via || '') === (entry.via || '') && lastE.aqRc === entry.aqRc &&
                (lastE.aq || '') === (entry.aq || '') && (now - lastE.t) < DEDUP_MS) {
                lastE.n = (lastE.n || 1) + 1;
                lastE.t = now;
                if (entry.err) lastE.err = entry.err;       // 刷新最近一次真实报错
                if (entry.env) lastE.env = entry.env;
            } else {
                r.fails.push(entry);
                if (r.fails.length > FAIL_CAP) r.fails = r.fails.slice(-FAIL_CAP);
            }
        }
        save(dataDir, r);
    } catch { /* 遥测绝不影响主流程 */ }
}

/** 是否有未上报失败（wq-ping 组 ping 时查询）。 */
export function syspyPendingWanted(dataDir: string): boolean {
    try {
        const r = readSyspyReport(dataDir);
        return !!(r && r.pending);
    } catch { return false; }
}

/** 服务端确认诊断已入账后清 pending。 */
export function clearSyspyPending(dataDir: string): void {
    try {
        const r = readSyspyReport(dataDir);
        if (r && r.pending) { r.pending = false; save(dataDir, r); }
    } catch { /* ignore */ }
}

function san(s: string, cap: number): string {
    return String(s || '').replace(/[\s\u0000-\u001f]+/g, '_').slice(0, cap);
}

function ageStr(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
}

/** 紧凑诊断 token 段（buildDiag 置首位；无失败记录 → ''）。 */
export function buildSpyTokens(dataDir: string): string {
    try {
        const r = readSyspyReport(dataDir);
        if (!r || !Array.isArray(r.fails) || r.fails.length === 0) return '';
        const now = Date.now();
        const byTg: Record<string, SyspyFailEntry> = {};
        for (let i = r.fails.length - 1; i >= 0; i--) {          // 后进 = 更新 → 倒序取每目标最新
            const f = r.fails[i];
            if (f && f.tg && !byTg[f.tg]) byTg[f.tg] = f;
        }
        const list = Object.keys(byTg).map(k => byTg[k]).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 2);
        const toks: string[] = [];
        for (let i = 0; i < list.length; i++) {
            const f = list[i];
            const key = (f.tg === 'node') ? 'spyn' : 'spyp';
            let v = String(f.op || '') + ':' + String(f.code || '');
            if (f.via) v += ':via' + san(f.via, 14);
            if (typeof f.aqRc === 'number' && f.aqRc !== 0 && f.aqRc !== -1) v += ':rc' + f.aqRc;
            v += ':x' + (f.n || 1) + ':' + ageStr(now - (f.t || now));
            toks.push(key + '=' + san(v, 64));
            if (i === 0) {                                        // 详情 token 只给最新一条（控体积）
                if (f.env) {
                    toks.push('spye=eng' + (f.env.eng ? 1 : 0) + ',man' + (f.env.man ? 1 : 0) +
                        ',py' + (f.env.py ? 1 : 0) + ',fac' + (f.env.fac ? 1 : 0));
                }
                if (f.aq) toks.push('spyaq=' + san(f.aq, 64));
                if (f.uc) toks.push('spyuc=' + san(f.uc, 40));
                if (f.err) toks.push('spyr=' + san(f.err, 80));
            }
        }
        return toks.join(' ');
    } catch { return ''; }
}
