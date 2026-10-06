// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// tmp-machine.ts — {项目}/_qqq/tmp 轮转唯一真理源
// 哲学：tmp 默认可弃；「它很重要」的唯一表达 = 改它（mtime 续期）或钉它（.pin）。
// 恒等：① 空间有界（除钉子）② 时间有界（永不阻塞，最坏多跑几轮）③ 认知有界（账本可查）。
//
// 判决三线（水位 → 宽限 → 逐条判决；纯函数 planSweep 可单测）：
//   ① 熔断  单文件 >1GB 且落定 ≥1h → 直删（无视年龄；大转储事故的保险丝）
//   ② 年龄  ≥30 天 → 清（≤64MB 进 .trash 隔离区再活 7 天，可捞回）
//   ③ 水压  超软线 2GB / 2 万件 → 最老优先清到回落线 1.2GB / 1.5 万；宽限随水位压缩：
//           静水与软压 7d → 超硬线 5GB 缩 24h → 超极压 10GB 缩 6h
// 钉子两型（全程豁免 + 占用如实上报）：根 .pin（_qqq/tmp/.pin，每行一个相对 glob）
//   与目录内 .pin（空文件即可，钉整棵子树）。
//
// 节奏：UI 就绪后 60s 首扫 + 每 6h；未回落 30min 补扫 ≤3 连；手动 IPC（qqqide:tmp:sweep）。
// 统一收敛（覆盖极端边界）：任何单项失败 → 重试 3×200ms → 跳过 + 入账，绝不阻塞绝不冒险；
//   无事务幂等（每项独立，下轮全量重扫）；符号链接/junction 一概不跟随；realpath + 前缀
//   双断言（防跑飞）；单飞（内存 + per-root 锁，10min 陈旧接管）；符号链接 tmp 根拒绝运行；
//   仅隔离区不可建立时降级直删；lstat 快照 + 删时失败重试覆盖 TOCTOU；纯 Node API
//   （Win7~11 / mac / Linux 同源，Unicode 安全，不碰 cmd / PowerShell）。
// 账本：{root}/_qqq/new_log/tmp-machine.json（环 500，原子写）——删了什么永久可查。
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain, BrowserWindow } from 'electron';

// ── 常量（本文件为唯一定义源；调参只动这里）──
export const TMP = {
    GRACE_MS: 7 * 864e5,               // 宽限（静水/软压档）
    AGE_MS: 30 * 864e5,                // 年龄线（静水期唯一清理线）
    SOFT: 2 * 1024 ** 3, SOFT_TO: 1.2 * 1024 ** 3,   // 软压线 → 回落线
    HARD: 5 * 1024 ** 3, PANIC: 10 * 1024 ** 3,      // 硬压线 / 极压线
    HARD_GRACE_MS: 864e5, PANIC_GRACE_MS: 6 * 36e5,  // 宽限压缩档（24h / 6h）
    FILE_FUSE: 1024 ** 3, FUSE_AFTER_MS: 36e5,       // 单文件熔断（>1GB 且落定 ≥1h）
    COUNT_FUSE: 20000, COUNT_TO: 15000,              // 数量熔断（>2 万件清到 1.5 万）
    TRASH: '.trash', TRASH_ITEM_MAX: 64 * 1024 ** 2, // 隔离区：≤64MB/件
    TRASH_TTL_MS: 7 * 864e5, TRASH_CAP: 512 * 1024 ** 2,  // 7 天 / 512MB 双限自轮转
    PERIOD_MS: 6 * 36e5, START_DELAY_MS: 60000,      // 周期 / 首扫延迟
    RESCAN_MS: 18e5, RESCAN_MAX: 3,                  // 未回落补扫：30min，≤3 连
    LEDGER_CAP: 500,                                 // 账本环
    LOCK_STALE_MS: 6e5,                              // 锁陈旧（10min 接管）
    NOTIFY_GAP_MS: 6 * 36e5,                         // qoast 节流（自动档每 6h ≤1 条）
    MANUAL_GAP_MS: 60000,                            // 手动触发硬限（60s 防连点）
    MAX_ENTRIES: 200000, MAX_DEPTH: 64, YIELD_EVERY: 64,  // 扫描防线 / 分片让出
    SAMPLE_MIN: 1024 * 1024,                         // 账本样本门槛（≥1MB 的删除/隔离逐项留名）
} as const;

export type SweepMode = 'auto' | 'manual' | 'rescan';
export type WaterLevel = 'calm' | 'soft' | 'hard' | 'panic';

export interface TmpFileInfo { rel: string; abs: string; size: number; mtimeMs: number; }
export interface TmpDirInfo { rel: string; abs: string; mtimeMs: number; }

export interface SweepPlan {
    level: WaterLevel;
    levelAfter: WaterLevel;
    graceMs: number;
    deleteList: TmpFileInfo[];      // 直删（熔断 / >64MB / 隔离不可用降级）
    quarantineList: TmpFileInfo[];  // ≤64MB → .trash
    rmdirList: TmpDirInfo[];        // 空目录候选（执行时 readdir 空才删）
}

export interface ScanOut {
    files: TmpFileInfo[];       // 非钉文件（候选）
    dirs: TmpDirInfo[];         // 非钉目录
    trash: { abs: string; size: number; ts: number; isDir: boolean }[];
    totalSize: number; totalCount: number;
    pinCount: number; pinSize: number;
    symlinks: number; errors: number; truncated: boolean;
}

export interface LedgerRec {
    time: string; mode: SweepMode; tookMs: number;
    before: { mb: number; files: number };
    freedMb: number; deleted: number; quarantined: number; trashed: number;
    failed: number; failedPaths: string[];
    pinned: { count: number; mb: number };
    removedSample: { rel: string; mb: number }[];
    symlinks: number; truncated: boolean;
    level: WaterLevel; levelAfter: WaterLevel;
}

export interface SweepOut {
    ok: boolean; busy?: boolean; mode: SweepMode;
    roots: number; deleted: number; quarantined: number; failed: number;
    freedMb: number; pinMb: number; overAfter: boolean;
    levelAfter: WaterLevel | null; tookMs: number;
}

// ═══ 纯函数（单测主战场） ═══

/** 水位分档：按总大小与件数取最严档 */
export function waterline(totalSize: number, count: number): WaterLevel {
    if (totalSize >= TMP.PANIC) { return 'panic'; }
    if (totalSize >= TMP.HARD) { return 'hard'; }
    if (totalSize >= TMP.SOFT || count > TMP.COUNT_FUSE) { return 'soft'; }
    return 'calm';
}

/** 有效宽限：水位越高宽限越短（保护项目整体的最后手段） */
export function effGraceMs(level: WaterLevel): number {
    if (level === 'panic') { return TMP.PANIC_GRACE_MS; }
    if (level === 'hard') { return TMP.HARD_GRACE_MS; }
    return TMP.GRACE_MS;
}

const _LEVEL_RANK: Record<WaterLevel, number> = { calm: 0, soft: 1, hard: 2, panic: 3 };

/** 水位比较（取更严者） */
function _worse(a: WaterLevel, b: WaterLevel): WaterLevel { return _LEVEL_RANK[a] >= _LEVEL_RANK[b] ? a : b; }

/** mini-glob → RegExp：'*' 段内任意、'**' 跨段、'?' 单字符；其余原样转义 */
export function globToRe(pat: string): RegExp {
    let out = '^';
    for (let i = 0; i < pat.length; i++) {
        const c = pat[i];
        if (c === '*') {
            if (pat[i + 1] === '*') { out += '.*'; i++; if (pat[i + 1] === '/') { i++; } }
            else { out += '[^/]*'; }
        } else if (c === '?') { out += '[^/]'; }
        else if ('.+^${}()|[]\\'.indexOf(c) >= 0) { out += '\\' + c; }
        else { out += c; }
    }
    return new RegExp(out + '$');
}

/** .trash 文件名前缀 {base36 ts}~{原名} → 隔离时刻（无效 → null） */
export function parseTrashTs(name: string): number | null {
    const i = name.indexOf('~');
    if (i <= 0) { return null; }
    const v = parseInt(name.slice(0, i), 36);
    return Number.isFinite(v) && v > 1e12 ? v : null;   // 合理毫秒下界（≈2001 年）
}

/** 三线判决（纯函数）：熔断 → 年龄 → 水压；返回直删/隔离/空目录候选 */
export function planSweep(
    files: TmpFileInfo[], dirs: TmpDirInfo[],
    totalSize: number, totalCount: number, now: number,
): SweepPlan {
    const level = waterline(totalSize, totalCount);
    const graceMs = effGraceMs(level);
    const sorted = files.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);   // 最老先
    const deleteList: TmpFileInfo[] = [];
    const quarantineList: TmpFileInfo[] = [];
    const taken = new Set<string>();
    let sizeLeft = totalSize;
    let countLeft = totalCount;

    const pick = (f: TmpFileInfo) => {
        taken.add(f.rel);
        (f.size > TMP.TRASH_ITEM_MAX ? deleteList : quarantineList).push(f);
        sizeLeft -= f.size;
        countLeft--;
    };

    // ①熔断 + ②年龄（无条件线）
    for (const f of sorted) {
        const age = Math.max(0, now - f.mtimeMs);
        if (f.size > TMP.FILE_FUSE && age >= TMP.FUSE_AFTER_MS) { taken.add(f.rel); deleteList.push(f); sizeLeft -= f.size; countLeft--; continue; }
        if (age >= TMP.AGE_MS) { pick(f); }
    }
    // ③水压（宽限内不动；超量直到回落线）
    if (sizeLeft > TMP.SOFT_TO || countLeft > TMP.COUNT_TO) {
        for (const f of sorted) {
            if (sizeLeft <= TMP.SOFT_TO && countLeft <= TMP.COUNT_TO) { break; }
            if (taken.has(f.rel)) { continue; }
            if (Math.max(0, now - f.mtimeMs) < graceMs) { continue; }
            pick(f);
        }
    }

    const levelAfter = waterline(Math.max(0, sizeLeft), Math.max(0, countLeft));
    const rmdirList = dirs.filter((d) => Math.max(0, now - d.mtimeMs) >= graceMs);
    return { level: level, levelAfter, graceMs, deleteList, quarantineList, rmdirList };
}

// ═══ IO 层 ═══

const _sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const _yield = () => new Promise<void>((r) => setImmediate(r));

/** 安全 tmp 根：realpath 断言 + 非符号链接/junction + 非盘根/家目录（不符拒绝运行） */
async function safeTmpRoot(root: string): Promise<string | null> {
    try {
        const abs = path.resolve(root, '_qqq', 'tmp');
        if (abs === path.parse(abs).root) { return null; }
        const st = await fs.promises.lstat(abs);
        if (!st.isDirectory() || st.isSymbolicLink()) { return null; }   // 链接/junction 一律不跟随
        const real = path.resolve(await fs.promises.realpath(abs));
        if (real === path.resolve(os.homedir()) || real === path.parse(real).root) { return null; }
        return real;
    } catch { return null; }
}

/** 根 .pin → glob 列表（# 注释 / 空行忽略） */
async function loadPinGlobs(tmpRoot: string): Promise<RegExp[]> {
    try {
        const raw = await fs.promises.readFile(path.join(tmpRoot, '.pin'), 'utf8');
        const res: RegExp[] = [];
        for (const line of String(raw).slice(0, 64 * 1024).split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s[0] === '#') { continue; }
            try { res.push(globToRe(s)); } catch { /* 坏 pattern 忽略 */ }
        }
        return res;
    } catch { return []; }
}

/** 全树扫描（迭代栈 + 分片让出；只读，绝不改盘）——导出供干跑/诊断 */
export async function scanRoot(tmpRoot: string): Promise<ScanOut> {
    const out: ScanOut = {
        files: [], dirs: [], trash: [],
        totalSize: 0, totalCount: 0, pinCount: 0, pinSize: 0,
        symlinks: 0, errors: 0, truncated: false,
    };
    const pinRes = await loadPinGlobs(tmpRoot);
    const stack: { abs: string; rel: string; depth: number; pinned: boolean }[] = [
        { abs: tmpRoot, rel: '', depth: 0, pinned: false },
    ];
    let ticks = 0;
    while (stack.length > 0) {
        if (out.totalCount + out.pinCount >= TMP.MAX_ENTRIES) { out.truncated = true; break; }
        const cur = stack.pop() as { abs: string; rel: string; depth: number; pinned: boolean };
        let ents: fs.Dirent[];
        try { ents = await fs.promises.readdir(cur.abs, { withFileTypes: true }); }
        catch { out.errors++; continue; }
        let pinned = cur.pinned;
        if (!pinned && cur.rel !== '') {   // 根 .pin = glob 名单（loadPinGlobs），整树钉只认子目录内 .pin
            for (const e of ents) { if (e.name === '.pin') { pinned = true; break; } }
        }
        for (const e of ents) {
            if (e.name === '.pin') { continue; }
            const rel = cur.rel ? cur.rel + '/' + e.name : e.name;
            if (cur.rel === '' && e.name === TMP.TRASH) { await _scanTrash(path.join(cur.abs, e.name), out); continue; }
            if (e.isSymbolicLink()) { out.symlinks++; continue; }
            const abs2 = path.join(cur.abs, e.name);
            let hit = pinned;
            if (!hit) {
                for (const re of pinRes) {
                    if (re.test(rel) || (e.isDirectory() && re.test(rel + '/'))) { hit = true; break; }
                }
            }
            if (e.isDirectory()) {
                if (cur.depth < TMP.MAX_DEPTH) { stack.push({ abs: abs2, rel: rel, depth: cur.depth + 1, pinned: hit }); }
                else { out.truncated = true; }
                if (!hit) { out.dirs.push({ rel: rel, abs: abs2, mtimeMs: 0 }); }   // mtime 下面补
                continue;
            }
            if (!e.isFile()) { continue; }   // socket/设备等一律不碰
            let st: fs.Stats;
            try { st = await fs.promises.lstat(abs2); }
            catch { out.errors++; continue; }
            if (hit) { out.pinCount++; out.pinSize += st.size; continue; }
            out.files.push({ rel: rel, abs: abs2, size: st.size, mtimeMs: st.mtimeMs });
            out.totalSize += st.size; out.totalCount++;
        }
        if ((++ticks % TMP.YIELD_EVERY) === 0) { await _yield(); }
    }
    // 目录 mtime 补采（只对非钉目录——量小，单独一批）
    for (const d of out.dirs) {
        try { d.mtimeMs = (await fs.promises.lstat(d.abs)).mtimeMs; } catch { d.mtimeMs = 0; }
    }
    return out;
}

async function _scanTrash(dir: string, out: ScanOut): Promise<void> {
    let st: fs.Stats;
    try { st = await fs.promises.lstat(dir); } catch { return; }
    if (!st.isDirectory() || st.isSymbolicLink()) { return; }   // 异常形态 → 不碰
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
        const abs2 = path.join(dir, e.name);
        let st2: fs.Stats;
        try { st2 = await fs.promises.lstat(abs2); } catch { continue; }
        const isDir = e.isDirectory() && !e.isSymbolicLink();
        out.trash.push({
            abs: abs2, size: st2.size,
            ts: parseTrashTs(e.name) ?? st2.mtimeMs,
            isDir: isDir,
        });
    }
}

/** unlink 重试：只读属性清一次再试；3×200ms；ENOENT 视为已达成 */
async function unlinkRetry(abs: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
        try { await fs.promises.unlink(abs); return true; }
        catch (e: any) {
            if (e && e.code === 'ENOENT') { return true; }
            if (i === 0 && e && (e.code === 'EPERM' || e.code === 'EACCES')) {
                try { await fs.promises.chmod(abs, 0o666); } catch { /* ignore */ }
            }
            if (i < 2) { await _sleep(200); }
        }
    }
    return false;
}

// ═══ 执行层 ═══

interface ExecOut {
    deleted: number; quarantined: number; freed: number; trashed: number;
    failed: number; failedPaths: string[]; removedSample: { rel: string; mb: number }[];
}

async function executePlan(tmpRoot: string, plan: SweepPlan, scan: ScanOut, now: number): Promise<ExecOut> {
    const out: ExecOut = { deleted: 0, quarantined: 0, freed: 0, trashed: 0, failed: 0, failedPaths: [], removedSample: [] };
    const trashDir = path.join(tmpRoot, TMP.TRASH);
    let canTrash = false;
    try { await fs.promises.mkdir(trashDir, { recursive: true }); canTrash = true; }
    catch { canTrash = false; }   // 隔离区不可建 → 小文件降级直删（如实仍按隔离语义计数）

    const guard = (abs: string) => abs === tmpRoot || abs.startsWith(tmpRoot + path.sep);
    const sample = (rel: string, size: number) => {
        if (size >= TMP.SAMPLE_MIN && out.removedSample.length < 50) {
            out.removedSample.push({ rel: rel, mb: Math.round(size / 1048576) });
        }
    };

    // ① 直删（熔断 / 大件）
    for (const f of plan.deleteList) {
        if (!guard(f.abs)) { out.failed++; continue; }
        if (await unlinkRetry(f.abs)) { out.deleted++; out.freed += f.size; sample(f.rel, f.size); }
        else { out.failed++; if (out.failedPaths.length < 20) { out.failedPaths.push(f.rel); } }
    }
    // ② 隔离（≤64MB）；无法隔离 → 直删降级
    for (const f of plan.quarantineList) {
        if (!guard(f.abs)) { out.failed++; continue; }
        let done = false;
        if (canTrash) {
            const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '~' + path.basename(f.abs);
            try { await fs.promises.rename(f.abs, path.join(trashDir, name)); done = true; }
            catch { done = false; }   // 占用/权限 → 计失败（保守：不剥夺捞回机会）
        } else {
            done = await unlinkRetry(f.abs);
        }
        if (done) { out.quarantined++; out.freed += f.size; sample(f.rel, f.size); }
        else { out.failed++; if (out.failedPaths.length < 20) { out.failedPaths.push(f.rel); } }
    }
    // ③ 空目录收盘（readdir 空才删；失败=非空，跳过）
    for (const d of plan.rmdirList) {
        if (!guard(d.abs)) { continue; }
        try { await fs.promises.rmdir(d.abs); } catch { /* 非空/占用 → 留待下轮 */ }
    }
    // ④ 隔离区自轮转（TTL + FIFO 双限）
    out.trashed = await _rotateTrash(scan.trash, now);
    return out;
}

async function _rotateTrash(items: ScanOut['trash'], now: number): Promise<number> {
    let freed = 0;
    const sorted = items.slice().sort((a, b) => a.ts - b.ts);   // 最老先
    let total = 0;
    for (const it of items) { total += it.size; }
    for (const it of sorted) {
        const expired = now - it.ts >= TMP.TRASH_TTL_MS;
        const overCap = total > TMP.TRASH_CAP;
        if (!expired && !overCap) { break; }
        let ok = false;
        if (it.isDir) { try { await fs.promises.rmdir(it.abs); ok = true; } catch { ok = false; } }
        else { ok = await unlinkRetry(it.abs); }
        if (ok) { total -= it.size; freed++; }
    }
    return freed;
}

// ═══ 锁 / 账本 ═══

async function acquireRootLock(lockPath: string): Promise<boolean> {
    const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
    try { await fs.promises.writeFile(lockPath, payload, { flag: 'wx' }); return true; }
    catch (e: any) {
        if (e && e.code === 'ENOENT') {
            try {
                await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
                await fs.promises.writeFile(lockPath, payload, { flag: 'wx' });
                return true;
            } catch { return false; }
        }
        if (!(e && e.code === 'EEXIST')) { return false; }
    }
    try {
        const j = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        if (Date.now() - ((j && j.ts) || 0) > TMP.LOCK_STALE_MS) {
            await fs.promises.writeFile(lockPath, payload);
            return true;
        }
    } catch {
        try { await fs.promises.writeFile(lockPath, payload); return true; } catch { /* ignore */ }
    }
    return false;
}

function ledgerPath(root: string): string {
    return path.join(root, '_qqq', 'new_log', 'tmp-machine.json');
}

async function readLedger(root: string): Promise<{ runs: LedgerRec[] } | null> {
    try {
        const j = JSON.parse(await fs.promises.readFile(ledgerPath(root), 'utf8'));
        if (j && Array.isArray(j.runs)) { return j; }
    } catch { /* 无账本/坏账本 → 从头记 */ }
    return null;
}

async function appendLedger(root: string, rec: LedgerRec): Promise<void> {
    const p = ledgerPath(root);
    const led = (await readLedger(root)) || { runs: [] };
    led.runs.push(rec);
    if (led.runs.length > TMP.LEDGER_CAP) { led.runs.splice(0, led.runs.length - TMP.LEDGER_CAP); }
    const tmp = p + '.tmp';
    try {
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(led, null, 1), 'utf8');
        await fs.promises.rename(tmp, p);   // 原子换入
    } catch { try { await fs.promises.unlink(tmp); } catch { /* ignore */ } }
}

// ═══ 单 root 轮次 ═══

async function sweepRoot(root: string, mode: SweepMode): Promise<LedgerRec | null> {
    const tmpRoot = await safeTmpRoot(root);
    if (!tmpRoot) { return null; }
    const lockPath = path.join(root, '_qqq', 'new_log', 'tmp-machine.lock');
    if (!(await acquireRootLock(lockPath))) { return null; }
    const t0 = Date.now();
    try {
        const scan = await scanRoot(tmpRoot);
        const plan = planSweep(scan.files, scan.dirs, scan.totalSize, scan.totalCount, Date.now());
        const exec = await executePlan(tmpRoot, plan, scan, Date.now());
        const rec: LedgerRec = {
            time: new Date().toISOString(), mode: mode, tookMs: Date.now() - t0,
            before: { mb: Math.round(scan.totalSize / 1048576), files: scan.totalCount },
            freedMb: Math.round(exec.freed / 1048576), deleted: exec.deleted, quarantined: exec.quarantined,
            trashed: exec.trashed, failed: exec.failed, failedPaths: exec.failedPaths,
            pinned: { count: scan.pinCount, mb: Math.round(scan.pinSize / 1048576) },
            removedSample: exec.removedSample, symlinks: scan.symlinks, truncated: scan.truncated,
            level: plan.level, levelAfter: plan.levelAfter,
        };
        await appendLedger(root, rec);
        return rec;
    } catch (e: any) {
        try { console.warn('[tmp-machine] root failed:', root, (e && e.message) || e); } catch { /* ignore */ }
        return null;   // 单 root 失败：不影响其余 root；下轮重扫（失败可见）
    } finally {
        try { await fs.promises.unlink(lockPath); } catch { /* ignore */ }
    }
}

// ═══ 轮次编排 ═══

let _running = false;
let _started = false;
let _lastNotifyAt = 0;
let _lastManualAt = 0;
let _rescanLeft = 0;
let _store: any = null;

/** roots = 用户开过的全部主项目（recent_folders，vig 同源）+ 本实例 cwd 兜底；只取存在 _qqq/tmp 者 */
async function resolveRoots(store: any): Promise<string[]> {
    const out: string[] = [];
    const push = (p: any) => {
        if (typeof p === 'string' && p) { const n = p.replace(/[\\/]+$/, ''); if (n && out.indexOf(n) < 0) { out.push(n); } }
    };
    push(process.cwd());
    try {
        const raw = store ? await store.get('qqqide', 'recent_folders') : null;
        if (Array.isArray(raw)) { for (const r of raw) { push(r && (r.path || r)); } }
    } catch { /* ignore */ }
    const ok: string[] = [];
    for (const root of out.slice(0, 120)) {
        try {
            const st = await fs.promises.stat(path.join(root, '_qqq', 'tmp'));
            if (st.isDirectory()) { ok.push(root); }
        } catch { /* 无 tmp → 跳过 */ }
    }
    return ok;
}

export async function runSweep(mode: SweepMode): Promise<SweepOut> {
    const busy: SweepOut = { ok: false, busy: true, mode: mode, roots: 0, deleted: 0, quarantined: 0, failed: 0, freedMb: 0, pinMb: 0, overAfter: false, levelAfter: null, tookMs: 0 };
    if (mode === 'manual') {
        if (Date.now() - _lastManualAt < TMP.MANUAL_GAP_MS) { return busy; }
        _lastManualAt = Date.now();
    }
    if (_running) { return busy; }
    _running = true;
    const t0 = Date.now();
    try {
        const roots = await resolveRoots(_store);
        const recs: LedgerRec[] = [];
        for (const root of roots) {
            const r = await sweepRoot(root, mode);
            if (r) { recs.push(r); }
        }
        // 汇总
        let deleted = 0, quarantined = 0, failed = 0, freedMb = 0, pinMb = 0;
        let worstAfter: WaterLevel = 'calm';
        for (const r of recs) {
            deleted += r.deleted; quarantined += r.quarantined; failed += r.failed;
            freedMb += r.freedMb; pinMb += r.pinned.mb;
            worstAfter = _worse(worstAfter, r.levelAfter);
        }
        const overAfter = (worstAfter === 'hard' || worstAfter === 'panic');
        const res: SweepOut = {
            ok: true, mode: mode, roots: recs.length,
            deleted: deleted, quarantined: quarantined, failed: failed,
            freedMb: freedMb, pinMb: pinMb, overAfter: overAfter,
            levelAfter: recs.length ? worstAfter : null, tookMs: Date.now() - t0,
        };
        // qoast 通知（自动档每 6h ≤1 条；手动必答不节流；无删且未超硬线 = 零声）
        if ((deleted + quarantined + failed > 0 || overAfter) && recs.length > 0) {
            const skip = mode !== 'manual' && (Date.now() - _lastNotifyAt < TMP.NOTIFY_GAP_MS);
            if (!skip) { _lastNotifyAt = Date.now(); _notify(res); }
        }
        // 未回落补扫（≤3 连；回落且无失败 → 计数归零）
        if (mode !== 'manual' && (overAfter || failed > 0) && _rescanLeft < TMP.RESCAN_MAX) {
            _rescanLeft++;
            setTimeout(() => { void runSweep('rescan').catch(() => { /* ignore */ }); }, TMP.RESCAN_MS);
        } else if (!overAfter && failed === 0) {
            _rescanLeft = 0;
        }
        return res;
    } catch (e: any) {
        try { console.warn('[tmp-machine] sweep failed:', (e && e.message) || e); } catch { /* ignore */ }
        return { ok: false, mode: mode, roots: 0, deleted: 0, quarantined: 0, failed: 0, freedMb: 0, pinMb: 0, overAfter: false, levelAfter: null, tookMs: Date.now() - t0 };
    } finally {
        _running = false;
    }
}

function _notify(res: SweepOut): void {
    try {
        const all = BrowserWindow.getAllWindows();
        const main = all.filter((w) => !w.isDestroyed() && (w as any).__qqqMainWindow);
        const target = main[0] || all.find((w) => !w.isDestroyed());
        if (!target || target.webContents.isDestroyed()) { return; }
        target.webContents.send('qqqide:tmp:swept', {
            mode: res.mode, deleted: res.deleted, quarantined: res.quarantined,
            failed: res.failed, freedMb: res.freedMb, pinMb: res.pinMb,
            overAfter: res.overAfter, levelAfter: res.levelAfter, roots: res.roots,
        });
    } catch { /* ignore */ }
}

// ═══ 对外入口 ═══

/** 启动调度：UI 就绪后 60s 首扫 + 每 6h（由 main.ts 在 onUiReady 内调用） */
export function startTmpMachine(store: any): void {
    if (_started) { return; }
    _started = true;
    _store = store;
    const loop = (delay: number) => {
        setTimeout(async () => {
            try { await runSweep('auto'); } catch { /* ignore */ }
            loop(TMP.PERIOD_MS);
        }, delay);
    };
    loop(TMP.START_DELAY_MS);
}

/** IPC：手动轮转 + 状态快照（渲染层 bridge.tmpMachine） */
export function registerTmpMachineIpc(store: any): void {
    _store = store;
    try {
        ipcMain.handle('qqqide:tmp:sweep', async () => {
            try { return await runSweep('manual'); }
            catch (e: any) { return { ok: false, error: String((e && e.message) || e) }; }
        });
        ipcMain.handle('qqqide:tmp:status', async () => {
            try {
                const roots = await resolveRoots(store);
                const items: any[] = [];
                for (const root of roots) {
                    const led = await readLedger(root);
                    const last = led && led.runs.length ? led.runs[led.runs.length - 1] : null;
                    items.push({
                        path: root, name: path.basename(root),
                        last: last ? {
                            time: last.time, mode: last.mode,
                            beforeMb: last.before.mb, beforeFiles: last.before.files,
                            freedMb: last.freedMb, deleted: last.deleted, quarantined: last.quarantined,
                            failed: last.failed, pinnedMb: last.pinned.mb, levelAfter: last.levelAfter,
                        } : null,
                    });
                }
                return { running: _running, roots: items };
            } catch (e: any) { return { ok: false, error: String((e && e.message) || e) }; }
        });
    } catch { /* 重复注册（热重载）防抖 */ }
}
