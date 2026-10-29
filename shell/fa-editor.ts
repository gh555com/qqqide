// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-editor.ts — 文本/代码文件关联（编辑器域）机器（2026-10-07 q422 定案）
//   ① 候选注册（A+ 恒开）：把 ~72 类文本/代码格式填进系统「打开方式」候选面——
//      Windows：ProgID(qqqide.editor) + 每扩展 OpenWithProgids + Capabilities/RegisteredApplications
//      + Applications\<exe>\SupportedTypes（应用级命令 = --qqqide-open，按扩展分流编辑器/播放器）；
//      mac：打包期 Info.plist CFBundleDocumentTypes 声明（LSHandlerRank=Alternate）+ 运行期 LSRegisterURL；
//      Linux：~/.local/share/applications/qqqide-editor.desktop（MimeType 全量声明）+ update-desktop-database。
//   ② 设为默认：设置面板行〔设为默认〕→ 参与族夺默认（Win UserChoice hash 强写 /
//      mac LSSetDefaultRoleHandlerForContentType / Linux xdg-mime default）。
//   ★ `1 by 1` 明细（设置行右上角同音量）：五组 72 类逐扩展勾选 = 参与 / 不参与本族。
//      不参与清单唯一持有者 = 本模块（OS 级共享目录 fa-editor-prefs.json）；变更 → faEditorReconcile
//      立即归还掉队者 + 按参与族重注册（禁「关掉了又被启动自愈注册回来」）。
//   ★ 族内退出（归还）：状态清单比对 → 掉队者一律 faEditorRelease（撤候选面 + 把默认槽位改回原主——
//      html 族找回已装浏览器，其余删 UserChoice 交系统）；app 级 ProgId（Applications\<exe>）也算我方。
//      ★ 解释器族跳过（2026-10-10 用户定案）：.py/.pyw（Python 族）与 .js/.mjs/.cjs（Node 族）已被
//      系统解释器接管时整族跳过不夺——skip 由渲染层实时 sysPy.check 逐族判定后传入 apply；
//      register（A+ 自愈）恒全量（只碰候选面不碰默认）。冲突槽位契约详 arch/编辑器与粘贴 §11。
//   ③ 启动自愈：每次启动后台静默重注册（状态键内容未变 → 纯读快路径零写入）——
//      绿色包搬家/换盘/换 exe 后路径失效自动修复；与 `1 by 1` 变更共用 faEditorReconcile 一条链。
//   ★ 双击链另一端 = main.ts 的 --qqqide-open 入口：冷启 argv → 就绪后投编辑器窗；
//      热态 second-instance 转发；mac open-file 按扩展分流（文本→本域 / 媒体→播放器域）。
//   ★ 媒体 37 类归播放器域（ipc-fileassoc.ts ★ 钮）——两域各自独立 ProgID / 桌面条目，互不接手。
// ============================================================================
import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { runPs, b64d } from './ipc-syspy';
import { FA_PS } from './fa-ps';
import { faMacApply, faMacRegister } from './fa-mac';
import { faLinuxApply } from './fa-linux';
import { MEDIA_ASSOC_EXTS, faSerial } from './ipc-fileassoc';
import { getDataDir, getOsBaseDir } from './portable-paths';
import { EDITOR_PROGID, EDITOR_DESKTOP_ID, EDITOR_OPEN_MARK } from './fa-ids';

// 「文本/代码」族（72 类；五组）。排除：可执行（.exe/.bat/.cmd/.lnk）、二进制文档
// （.docx/.pdf——打开=乱码）、媒体 37 类（归播放器域）、浏览器族网页（.html/.htm——系统默认归属
// 是浏览器，夺来 = 用户上不了网；曾经入族，已整族退出并由启动自愈归还）。.ts 归此（TypeScript；播放器域已刻意排除）。
// ★ 分组唯一真理源：`1 by 1` 明细面板按此五组渲染；平铺清单由它派生（禁两处各写一份）。
export const EDITOR_ASSOC_GROUPS: { id: string; exts: string[] }[] = [
    // 文本 / 标记
    { id: 'text', exts: ['.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.org', '.tex', '.adoc', '.log'] },
    // 配置 / 数据
    { id: 'config', exts: ['.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.csv', '.tsv', '.xml'] },
    // Web（.html/.htm 不在此族——浏览器归属，详文件头）
    { id: 'web', exts: ['.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.php'] },
    // 编程语言
    { id: 'lang', exts: ['.py', '.pyw', '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.cs', '.java', '.kt', '.kts', '.swift', '.m', '.dart', '.lua', '.rb', '.pl', '.r', '.jl', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.psm1'] },
    // 查询 / 构建 / 其他
    { id: 'misc', exts: ['.sql', '.graphql', '.gql', '.proto', '.tf', '.svg'] },
];
/** 全族平铺清单（= 五组派生，顺序恒 = 组序）——注册 / 夺默认 / 自愈 / 目录四处唯一消费面 */
export const EDITOR_ASSOC_EXTS: string[] = EDITOR_ASSOC_GROUPS.reduce((a: string[], g) => a.concat(g.exts), [] as string[]);

// 域标识（ProgID / 桌面条目 ID / 打开标记）= shell/fa-ids.ts 唯一真理源
// Capabilities 子键名：与播放器域分开持有（两域共用一个块 = ApplicationName 互相覆盖，
//   系统设置里两条条目显示同一个名字）。扩展名两域零交集，各自一张 FileAssociations 表。
const EDITOR_CAP_NAME = 'EditorCapabilities';
const APP_NAME = 'qd (qqqide) 编辑器';
const APP_DESC = 'qd (qqqide) 文本/代码编辑器 — 双击用 qd 打开文本与代码文件';

const _MEDIA_SET = new Set(MEDIA_ASSOC_EXTS.map((e) => e.toLowerCase()));
const _EDITOR_SET = new Set(EDITOR_ASSOC_EXTS.map((e) => e.toLowerCase()));

// ── 参与偏好（`1 by 1` 明细的唯一写入口）：不参与本族的扩展名清单 ──
//   语义：off 里的扩展名 = 不注册候选面 + 不夺默认 + 已是 qd 默认的立即归还（faEditorRelease）。
//   壳层持有唯一真相（{OS 级共享目录}/fa-editor-prefs.json，原子写）：apply / register / 自愈 / 目录四处必须
//   消费同一份——放渲染层就会出现「设置里关了、启动自愈又给注册回来」的第二真相源。
//   ★ 存放位置 = OS 级共享目录（getOsBaseDir()/qqqide），不是实例 Data：文件关联是 HKCU 系统级资源，
//     偏好必须与实例无关。放实例 Data 会分裂成两份真值——dev 实例起身时读不到绿色包里「不参与」的勾选，
//     于是把用户已经关掉的类型重新注册回候选面（同一台机器双实例并存的真实路径）。
//     旧位置（{数据目录}/Data）一次性迁移，迁移失败不影响正确性：丢状态只会多跑一次全链重注册（幂等）。
const PREFS_V = 1;
let _faStoreCache: string | null = null;
function _faStoreDir(): string {
    if (_faStoreCache) { return _faStoreCache; }
    let d = '';
    try { d = path.join(getOsBaseDir(), 'qqqide'); } catch { d = ''; }
    if (!d) { try { d = getDataDir(); } catch { d = process.cwd(); } }
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
    _faStoreCache = d;
    _faMigrateOnce();
    return d;
}
let _faMigrated = false;
function _faMigrateOnce(): void {
    if (_faMigrated) { return; }
    _faMigrated = true;
    const dstDir = _faStoreCache || '';
    let srcDir = '';
    try { srcDir = getDataDir(); } catch { return; }
    if (!dstDir || !srcDir || path.resolve(dstDir) === path.resolve(srcDir)) { return; }
    for (const name of ['fa-editor-prefs.json', 'fa-editor-state.json']) {
        try {
            const dst = path.join(dstDir, name);
            const src = path.join(srcDir, name);
            if (fs.existsSync(dst) || !fs.existsSync(src)) { continue; }
            fs.copyFileSync(src, dst);
            fs.unlinkSync(src);
        } catch { /* ignore */ }
    }
}
function _prefsFile(): string { return path.join(_faStoreDir(), 'fa-editor-prefs.json'); }
function _normOff(list: any): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const arr = Array.isArray(list) ? list : [];
    for (const s of arr) {
        const e = String(s || '').trim().toLowerCase();
        if (!e || !_EDITOR_SET.has(e) || seen.has(e)) { continue; }
        seen.add(e);
        out.push(e);
    }
    return out;
}
let _faOffCache: string[] | null = null;
/** 不参与清单（纯读；解析失败 = 空清单——宁全参与，也不静默禁用整族） */
export function readFaEditorOff(): string[] {
    if (_faOffCache) { return _faOffCache.slice(); }
    let list: string[] = [];
    try {
        const j = JSON.parse(fs.readFileSync(_prefsFile(), 'utf8'));
        list = _normOff(j && j.off);
    } catch { list = []; }
    _faOffCache = list;
    return list.slice();
}
function _writeFaEditorOff(off: string[]): boolean {
    const list = _normOff(off);
    const f = _prefsFile();
    try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = f + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: PREFS_V, off: list, ts: Date.now() }), 'utf8');
        fs.renameSync(tmp, f);
        _faOffCache = list;
        return true;
    } catch (e: any) {
        console.warn('[fa-editor] prefs write fail: ' + ((e && e.message) || e));
        return false;
    }
}
/** 参与族 = 全族 − 不参与清单（注册 / 夺默认 / 自愈 / 目录四处唯一入口） */
function _activeExts(): string[] {
    const off = new Set(readFaEditorOff());
    return EDITOR_ASSOC_EXTS.filter((e) => !off.has(e.toLowerCase()));
}

function _extOf(p: string): string {
    const s = String(p || '');
    const i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i).toLowerCase();
}

/** 外部「打开文件」按域分流：媒体扩展 → 播放器域；其余（含未知）→ 编辑器域。 */
export function classifyExternalFiles(files: string[]): { text: string[]; media: string[] } {
    const text: string[] = [];
    const media: string[] = [];
    for (const f of files || []) {
        if (!f || typeof f !== 'string') { continue; }
        const e = _extOf(f);
        if (e && _MEDIA_SET.has(e) && !_EDITOR_SET.has(e)) { media.push(f); }
        else { text.push(f); }
    }
    return { text, media };
}

/** 结果形状（win / mac / linux 同形——UI 零分叉） */
export interface FaEditorResult { ok: boolean; code?: string; total: number; taken: number; fails: string[]; skipped?: string[]; err?: string; detail?: string[] }

/** 打开命令 = 当前进程 exe（绿色包 = gh555.com\joker.exe；dev = electron.exe + 项目根）。 */
function _exeInfo(): { cmd: string; icon: string; appExe: string } {
    const exe = process.execPath;
    const appArg = app.isPackaged ? '' : ('"' + app.getAppPath() + '" ');
    return {
        cmd: '"' + exe + '" ' + appArg + EDITOR_OPEN_MARK + ' "%1"',
        icon: '"' + exe + '",0',
        appExe: path.basename(exe),
    };
}

/** A+ 注册 / B 夺默认 唯一入口（mode: register = 仅候选面；apply = 候选面 + 夺默认）。
 *  opts.skip = 解释器族剔除清单（apply 专用；渲染层实时判定；仅收本族合法扩展——其余一律忽略）。 */
export async function faEditorApply(mode: 'register' | 'apply', opts?: { skip?: string[] }): Promise<FaEditorResult> {
    const active = _activeExts();
    let exts = active;
    let skipped: string[] = [];
    if (mode === 'apply' && opts && Array.isArray(opts.skip) && opts.skip.length > 0) {
        const set = new Set<string>();
        for (const s of opts.skip) {
            const e = String(s || '').trim().toLowerCase();
            if (_EDITOR_SET.has(e)) { set.add(e); }
        }
        if (set.size > 0) {
            skipped = active.filter((e) => set.has(e.toLowerCase()));
            exts = active.filter((e) => !set.has(e.toLowerCase()));
        }
    }
    // 参与族为空（`1 by 1` 全不选）= 合法的「全归还」终态：零扩展可注册/可夺，如实报空成功
    //   （禁把它当失败——否则用户取消全部勾选时面板会报「保存失败」而实际已归还完毕）
    if (exts.length === 0) { return { ok: true, code: 'empty', total: 0, taken: 0, fails: [], skipped }; }
    if (process.platform === 'darwin') {
        const r = (mode === 'apply') ? await faMacApply(exts) : await faMacRegister();
        return { ok: !!r.ok, code: r.ok ? undefined : (r.code || 'apply-failed'), total: r.total || 0, taken: r.taken || 0, fails: r.fails || [], skipped, err: r.err };
    }
    if (process.platform === 'linux') {
        const r = await faLinuxApply(exts, {
            setDefault: mode === 'apply',
            desktopId: EDITOR_DESKTOP_ID,
            name: APP_NAME,
            desc: APP_DESC,
            marker: EDITOR_OPEN_MARK,
            // 编辑域白名单：text/plain 正是本族目标（播放器域才是灾难）；仅护二进制与空文件
            neverTake: ['application/octet-stream', 'application/x-zerosize'],
            categories: 'Utility;TextEditor;Development;',
        });
        return { ok: !!r.ok, code: r.ok ? undefined : (r.code || 'apply-failed'), total: r.total || 0, taken: r.taken || 0, fails: r.fails || [], skipped, err: r.err };
    }
    if (process.platform !== 'win32') { return { ok: false, code: 'unsupported', total: 0, taken: 0, fails: [], skipped }; }
    try {
        const x = _exeInfo();
        const r = await runPs(FA_PS, {
            QQQIDE_FA_MODE: mode,
            QQQIDE_FA_PROGID: EDITOR_PROGID,
            QQQIDE_FA_EXTS: exts.join(';'),
            QQQIDE_FA_CMD: x.cmd,
            QQQIDE_FA_ICON: x.icon,
            QQQIDE_FA_NAME: APP_NAME,
            QQQIDE_FA_DESC: APP_DESC,
            QQQIDE_FA_MARK: EDITOR_OPEN_MARK,
            QQQIDE_FA_APPEXE: x.appExe,
            QQQIDE_FA_APPCMD: x.cmd,
            QQQIDE_FA_APPFRIEND: 'qd (qqqide)',
            QQQIDE_FA_APPTYPES: active.concat(MEDIA_ASSOC_EXTS).join(';'),
            QQQIDE_FA_CAPNAME: EDITOR_CAP_NAME,
        }, mode === 'apply' ? 300000 : 180000, 'QQQIDE_FA_');
        const out: FaEditorResult = {
            ok: r.fields.OK === '1',
            code: r.fields.CODE || 'apply-failed',
            total: parseInt(r.fields.TOTAL || '0', 10) || 0,
            taken: parseInt(r.fields.TAKEN || '0', 10) || 0,
            fails: b64d(r.fields.FAILS).split(';').filter((s) => s),
            skipped,
            err: (b64d(r.fields.PSERR) || '').slice(0, 300),
        };
        if (!out.ok) { console.warn('[fa-editor] ' + mode + ' fail: ' + out.code + ' ' + (out.err || '')); }
        return out;
    } catch (e: any) {
        console.warn('[fa-editor] ' + mode + ' err: ' + ((e && e.message) || e));
        return { ok: false, code: 'apply-failed', total: 0, taken: 0, fails: [], skipped };
    }
}

// ── 族内退出归返（弃养的扩展名必须交回系统——禁残留「我们仍是人家的默认」）──
//   触发面 = 启动自愈（本族清单收缩）；入参 = 已不在本族的扩展名清单。
//   Windows：撤候选面（OpenWithProgids / Capabilities / SupportedTypes）+ 默认槽位若非我方则动也不动——
//   若是我方：网页族（.html/.htm/.xhtml/.shtml/.mht/.mhtml）找回已装浏览器 ProgID 回写；
//   其余删 UserChoice（交系统重新裁定，绝不替用户随便指一个）。
//   mac：Info.plist 为打包期声明，运行期无逐扩展槽位可交（无动作）；Linux：desktop 条目 MimeType
//   全量重写（紧随的 register 已用收缩后的清单覆盖），无需单独动作。
export async function faEditorRelease(exts: string[]): Promise<FaEditorResult> {
    const list: string[] = [];
    for (const s of (exts || [])) {
        const e = String(s || '').trim().toLowerCase();
        if (e && list.indexOf(e) < 0) { list.push(e); }
    }
    if (!list.length) { return { ok: true, total: 0, taken: 0, fails: [], detail: [] }; }
    if (process.platform !== 'win32') { return { ok: true, total: 0, taken: 0, fails: [], detail: [] }; }
    try {
        const x = _exeInfo();
        const r = await runPs(FA_PS, {
            QQQIDE_FA_MODE: 'release',
            QQQIDE_FA_PROGID: EDITOR_PROGID,
            QQQIDE_FA_EXTS: list.join(';'),
            QQQIDE_FA_CMD: x.cmd,
            QQQIDE_FA_ICON: x.icon,
            QQQIDE_FA_NAME: APP_NAME,
            QQQIDE_FA_DESC: APP_DESC,
            QQQIDE_FA_MARK: EDITOR_OPEN_MARK,
            QQQIDE_FA_APPEXE: x.appExe,
            QQQIDE_FA_CAPNAME: EDITOR_CAP_NAME,
        }, 180000, 'QQQIDE_FA_');
        const out: FaEditorResult = {
            ok: r.fields.OK === '1',
            code: r.fields.CODE || 'release-failed',
            total: parseInt(r.fields.TOTAL || '0', 10) || 0,
            taken: parseInt(r.fields.TAKEN || '0', 10) || 0,
            fails: b64d(r.fields.FAILS).split(';').filter((s) => s),
            detail: b64d(r.fields.DETAIL).split(';').filter((s) => s),
            err: (b64d(r.fields.PSERR) || '').slice(0, 300),
        };
        if (!out.ok) { console.warn('[fa-editor] release fail: ' + out.code + ' ' + (out.err || '')); }
        return out;
    } catch (e: any) {
        console.warn('[fa-editor] release err: ' + ((e && e.message) || e));
        return { ok: false, code: 'release-failed', total: list.length, taken: 0, fails: list, detail: [] };
    }
}

/** 清理历史开发态应用块：Applications\<exe> 的 open 命令带本域标记且指向 electron → 删除整个块。
 *  这类块会让「打开方式」列表里出现重复的 qd 条目（当前 exe 永不动；非 electron 的块也不动）。 */
async function _cleanupForeignAppBlocks(): Promise<string[]> {
    if (process.platform !== 'win32') { return []; }
    try {
        const x = _exeInfo();
        const r = await runPs(FA_PS, {
            QQQIDE_FA_MODE: 'cleanup',
            QQQIDE_FA_PROGID: EDITOR_PROGID,
            QQQIDE_FA_MARK: EDITOR_OPEN_MARK,
            QQQIDE_FA_APPEXE: x.appExe,
        }, 120000, 'QQQIDE_FA_');
        const removed = b64d(r.fields.DETAIL).split(';').filter((s) => s);
        if (removed.length) { console.log('[fa-editor] cleaned stale app blocks: ' + removed.join(',')); }
        return removed;
    } catch { return []; }
}

// ── 归返/注册总闸（`1 by 1` 勾选变更 + 启动自愈共用同一条链）──
//   序：参与族 = 全族 − 不参与清单 → 上一次状态清单减出掉队者（已不参与/已退族）→ 归还 → 按参与族重注册候选面
//   → 落状态键。幂等：无变化 → code='unchanged' 零进程零写入。
//   归还失败不写状态（下次重试）——禁假成功。
export interface FaEditorSyncResult { ok: boolean; code?: string; released: string[]; releasedOk: boolean; total: number; taken: number; fails: string[]; detail?: string[] }

export async function faEditorReconcile(): Promise<FaEditorSyncResult> {
    const stateFile = path.join(_faStoreDir(), 'fa-editor-state.json');
    const active = _activeExts();
    const key = _stateKey(active);
    let prevExts: string[] = [];
    let hasState = false;
    try {
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (cur && cur.v === 1 && cur.key === key) {
            return { ok: true, code: 'unchanged', released: [], releasedOk: true, total: 0, taken: 0, fails: [] };
        }
        prevExts = _stateExts(cur);
        hasState = !!(cur && typeof cur === 'object');
    } catch { /* 无状态/损坏 → 走全链 */ }
    // 无状态记录（首装 / 状态文件被清）→ 按「历史曾注册全族」兜底：不参与的项也必须确认不再持有
    //   （否则「设置里关了、系统里仍是本产品打开」会永久僵在那里）。非我方槽位归还恒零动作，无副作用。
    if (!hasState) { prevExts = EDITOR_ASSOC_EXTS.slice(); }
    const activeSet = new Set(active.map((e) => e.toLowerCase()));
    const dropped = prevExts.filter((e) => !!e && !activeSet.has(String(e).toLowerCase()));
    let releasedOk = true;
    let detail: string[] = [];
    if (dropped.length) {
        const rel = await faEditorRelease(dropped);
        releasedOk = !!rel.ok;
        detail = rel.detail || [];
        console.log('[fa-editor] released: ' + dropped.join(',') + ' ok=' + rel.ok + ' :: ' + detail.join(' '));
    }
    // 打包态顺带抹掉历史开发态应用块（Applications\<electron.exe> 命令含本域标记 = 「打开方式」重复条目）
    if (app.isPackaged) { try { await _cleanupForeignAppBlocks(); } catch { /* ignore */ } }
    const r = await faEditorApply('register');
    const out: FaEditorSyncResult = { ok: !!r.ok && releasedOk, code: r.code, released: dropped, releasedOk, total: r.total, taken: r.taken, fails: r.fails || [], detail };
    if (out.ok) {
        try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            const tmp = stateFile + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ v: 1, key, exts: active, ts: Date.now() }), 'utf8');
            fs.renameSync(tmp, stateFile);
        } catch { /* 下次启动重试 */ }
    } else {
        console.warn('[fa-editor] sync incomplete: ' + (r.code || '') + ' ' + r.taken + '/' + r.total + ' releasedOk=' + releasedOk);
    }
    return out;
}

// ── 启动自愈（A+ 恒开）：状态键未变 → 纯读快路径零写入零进程；变了/缺失 → 先归还掉队者再静默重注册 ──
let _healStarted = false;
function _stateKey(active: string[]): string {
    return ['v1', process.execPath, app.isPackaged ? 'p' : ('d:' + app.getAppPath()), active.join(',')].join('|');
}
/** IDE 域「UI 就绪」后调用（冒烟/开发态/未知平台自跳过；幂等）——后台静默执行，绝不阻塞启动。
 *  ★ 开发态（非打包）不自动自愈：自愈会把 ProgID 命令重写成 electron.exe + 项目根，
 *    等于把用户系统里的 .txt/.md 指向一个带控制台的开发实例。手动操作（〔设为默认〕/ 1 by 1）照旧生效——
 *    那是用户显式意图。 */
export function startEditorAssocHeal(): void {
    if (_healStarted) { return; }
    _healStarted = true;
    if (!app.isPackaged) { return; }
    if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') { return; }
    setTimeout(() => { void _heal().catch(() => { /* ignore */ }); }, 2500);
}
function _stateExts(cur: any): string[] {
    if (!cur) { return []; }
    if (Array.isArray(cur.exts)) { return cur.exts.map((s: any) => String(s)); }
    if (typeof cur.key === 'string') {            // 旧状态（清单未单列）：状态键第 4 段即清单
        const parts = cur.key.split('|');
        if (parts.length >= 4) { return parts[3].split(',').filter((s: string) => !!s); }
    }
    return [];
}
async function _heal(): Promise<void> {
    await faEditorReconcile();
}

// ── 逐扩展真实归属（只读；`1 by 1` 明细的角标真相） ──
//   taken = 当前真的是 qd 打开（有效关联命令带本域标记）/ cand = 仅列在「打开方式」候选面 / free = 无关。
//   仅 Windows 有逐扩展默认槽位可读；mac/Linux 无（返回 unsupported——面板如实不画角标，禁猜）。
export interface FaEditorStateResult { ok: boolean; code?: string; states: Record<string, string>; err?: string }
export async function faEditorState(): Promise<FaEditorStateResult> {
    if (process.platform !== 'win32') { return { ok: false, code: 'unsupported', states: {} }; }
    try {
        const x = _exeInfo();
        const r = await runPs(FA_PS, {
            QQQIDE_FA_MODE: 'state',
            QQQIDE_FA_PROGID: EDITOR_PROGID,
            QQQIDE_FA_EXTS: EDITOR_ASSOC_EXTS.join(';'),
            QQQIDE_FA_CMD: x.cmd,
            QQQIDE_FA_ICON: x.icon,
            QQQIDE_FA_NAME: APP_NAME,
            QQQIDE_FA_DESC: APP_DESC,
            QQQIDE_FA_MARK: EDITOR_OPEN_MARK,
            QQQIDE_FA_APPEXE: x.appExe,
            QQQIDE_FA_CAPNAME: EDITOR_CAP_NAME,
        }, 180000, 'QQQIDE_FA_');
        const states: Record<string, string> = {};
        for (const seg of b64d(r.fields.DETAIL).split(';')) {
            const i = seg.indexOf('=');
            if (i > 0) { states[String(seg.slice(0, i)).trim().toLowerCase()] = String(seg.slice(i + 1)).trim(); }
        }
        const ok = r.fields.OK === '1';
        return { ok, code: ok ? undefined : (r.fields.CODE || 'state-failed'), states, err: (b64d(r.fields.PSERR) || '').slice(0, 300) };
    } catch (e: any) {
        console.warn('[fa-editor] state err: ' + ((e && e.message) || e));
        return { ok: false, code: 'state-failed', states: {} };
    }
}

// ── IPC：设置面板高级 tab「文件关联（文本/代码）」──
//   editor-catalog = 五组明细 + 参与清单（纯读，不拉进程）
//   editor-state   = 逐扩展真实归属（Windows PS 只读）
//   set-editor-off = `1 by 1` 勾选变更唯一写入口：落盘偏好 → 立即归还掉队者 + 重注册参与族
//   apply-editor   = 〔设为默认〕整族夺默认（skip = 解释器族剔除清单，渲染层实时判定传入）
export function registerEditorFileAssocIpc(): void {
    // 目录 = 纯内存快照（不拉进程、不写盘）→ 禁进 faSerial 队列：注册进行中时也必须秒回，
    //   否则设置面板展开明细会卡在「加载中…」直到整链跑完。
    ipcMain.handle('qqqide:fileassoc:editor-catalog', () => ({
        groups: EDITOR_ASSOC_GROUPS.map((g) => ({ id: g.id, exts: g.exts.slice() })),
        exts: EDITOR_ASSOC_EXTS.slice(),
        off: readFaEditorOff(),
        platform: process.platform,
    }));
    ipcMain.handle('qqqide:fileassoc:editor-state', () => faSerial(async () => faEditorState()));
    ipcMain.handle('qqqide:fileassoc:set-editor-off', (_e: any, off?: string[]) => faSerial(async () => {
        const prev = readFaEditorOff();
        const next = _normOff(off);
        if (!_writeFaEditorOff(next)) { return { ok: false, code: 'prefs-write-failed', off: prev }; }
        const r = await faEditorReconcile();
        return { ok: r.ok, code: r.code, off: next, released: r.released, releasedOk: r.releasedOk, total: r.total, taken: r.taken, fails: (r.fails || []).slice(0, 20) };
    }));
    ipcMain.handle('qqqide:fileassoc:apply-editor', (_e: any, skip?: string[]) => faSerial(async () => {
        const r = await faEditorApply('apply', { skip });
        return {
            ok: !!r.ok,
            code: r.ok ? undefined : (r.code || 'apply-failed'),
            total: r.total,
            taken: r.taken,
            fails: (r.fails || []).slice(0, 20),
            skipped: r.skipped || [],
            err: r.err,
        };
    }));
}
