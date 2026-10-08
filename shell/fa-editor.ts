// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-editor.ts — 文本/代码文件关联（编辑器域）机器（2026-10-07 q422 定案）
//   ① 候选注册（A+ 恒开）：把 ~74 类文本/代码格式填进系统「打开方式」候选面——
//      Windows：ProgID(qqqide.editor) + 每扩展 OpenWithProgids + Capabilities/RegisteredApplications
//      + Applications\<exe>\SupportedTypes（应用级命令 = --qqqide-open，按扩展分流编辑器/播放器）；
//      mac：打包期 Info.plist CFBundleDocumentTypes 声明（LSHandlerRank=Alternate）+ 运行期 LSRegisterURL；
//      Linux：~/.local/share/applications/qqqide-editor.desktop（MimeType 全量声明）+ update-desktop-database。
//   ② 设为默认（B 一键）：设置面板行〔设为默认〕→ 整族夺默认（Win UserChoice hash 强写 /
//      mac LSSetDefaultRoleHandlerForContentType / Linux xdg-mime default）——单向可反复，无解除逻辑。
//   ③ 启动自愈：每次启动后台静默重注册（状态键内容未变 → 纯读快路径零写入）——
//      绿色包搬家/换盘/换 exe 后路径失效自动修复。
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
import { getDataDir } from './portable-paths';

// 「文本/代码」族（74 类；五组）。排除：可执行（.exe/.bat/.cmd/.lnk）、二进制文档
// （.docx/.pdf——打开=乱码）、媒体 37 类（归播放器域）。.ts 归此（TypeScript；播放器域已刻意排除）。
export const EDITOR_ASSOC_EXTS: string[] = [
    // 文本 / 标记
    '.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.org', '.tex', '.adoc', '.log',
    // 配置 / 数据
    '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.csv', '.tsv', '.xml',
    // Web
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.php',
    // 编程语言
    '.py', '.pyw', '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.cs', '.java', '.kt', '.kts', '.swift', '.m', '.dart', '.lua', '.rb', '.pl', '.r', '.jl', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.psm1',
    // 查询 / 构建 / 其他
    '.sql', '.graphql', '.gql', '.proto', '.tf', '.svg',
];

const PROG_ID = 'qqqide.editor';
const MARK = '--qqqide-open';
const APP_NAME = 'qd (qqqide) 编辑器';
const APP_DESC = 'qd (qqqide) 文本/代码编辑器 — 双击用 qd 打开文本与代码文件';
const DESKTOP_ID = 'qqqide-editor.desktop';

const _MEDIA_SET = new Set(MEDIA_ASSOC_EXTS.map((e) => e.toLowerCase()));
const _EDITOR_SET = new Set(EDITOR_ASSOC_EXTS.map((e) => e.toLowerCase()));

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
export interface FaEditorResult { ok: boolean; code?: string; total: number; taken: number; fails: string[]; err?: string }

/** 打开命令 = 当前进程 exe（绿色包 = gh555.com\joker.exe；dev = electron.exe + 项目根）。 */
function _exeInfo(): { cmd: string; icon: string; appExe: string } {
    const exe = process.execPath;
    const appArg = app.isPackaged ? '' : ('"' + app.getAppPath() + '" ');
    return {
        cmd: '"' + exe + '" ' + appArg + MARK + ' "%1"',
        icon: '"' + exe + '",0',
        appExe: path.basename(exe),
    };
}

/** A+ 注册 / B 夺默认 唯一入口（mode: register = 仅候选面；apply = 候选面 + 夺默认）。 */
export async function faEditorApply(mode: 'register' | 'apply'): Promise<FaEditorResult> {
    if (process.platform === 'darwin') {
        const r = (mode === 'apply') ? await faMacApply(EDITOR_ASSOC_EXTS) : await faMacRegister();
        return { ok: !!r.ok, code: r.ok ? undefined : (r.code || 'apply-failed'), total: r.total || 0, taken: r.taken || 0, fails: r.fails || [], err: r.err };
    }
    if (process.platform === 'linux') {
        const r = await faLinuxApply(EDITOR_ASSOC_EXTS, {
            setDefault: mode === 'apply',
            desktopId: DESKTOP_ID,
            name: APP_NAME,
            desc: APP_DESC,
            marker: MARK,
            // 编辑域白名单：text/plain 正是本族目标（播放器域才是灾难）；仅护二进制与空文件
            neverTake: ['application/octet-stream', 'application/x-zerosize'],
            categories: 'Utility;TextEditor;Development;',
        });
        return { ok: !!r.ok, code: r.ok ? undefined : (r.code || 'apply-failed'), total: r.total || 0, taken: r.taken || 0, fails: r.fails || [], err: r.err };
    }
    if (process.platform !== 'win32') { return { ok: false, code: 'unsupported', total: 0, taken: 0, fails: [] }; }
    try {
        const x = _exeInfo();
        const r = await runPs(FA_PS, {
            QQQIDE_FA_MODE: mode,
            QQQIDE_FA_PROGID: PROG_ID,
            QQQIDE_FA_EXTS: EDITOR_ASSOC_EXTS.join(';'),
            QQQIDE_FA_CMD: x.cmd,
            QQQIDE_FA_ICON: x.icon,
            QQQIDE_FA_NAME: APP_NAME,
            QQQIDE_FA_DESC: APP_DESC,
            QQQIDE_FA_MARK: MARK,
            QQQIDE_FA_APPEXE: x.appExe,
            QQQIDE_FA_APPCMD: x.cmd,
            QQQIDE_FA_APPFRIEND: 'qd (qqqide)',
            QQQIDE_FA_APPTYPES: EDITOR_ASSOC_EXTS.concat(MEDIA_ASSOC_EXTS).join(';'),
        }, mode === 'apply' ? 300000 : 180000, 'QQQIDE_FA_');
        const out: FaEditorResult = {
            ok: r.fields.OK === '1',
            code: r.fields.CODE || 'apply-failed',
            total: parseInt(r.fields.TOTAL || '0', 10) || 0,
            taken: parseInt(r.fields.TAKEN || '0', 10) || 0,
            fails: b64d(r.fields.FAILS).split(';').filter((s) => s),
            err: (b64d(r.fields.PSERR) || '').slice(0, 300),
        };
        if (!out.ok) { console.warn('[fa-editor] ' + mode + ' fail: ' + out.code + ' ' + (out.err || '')); }
        return out;
    } catch (e: any) {
        console.warn('[fa-editor] ' + mode + ' err: ' + ((e && e.message) || e));
        return { ok: false, code: 'apply-failed', total: 0, taken: 0, fails: [] };
    }
}

// ── 启动自愈（A+ 恒开）：状态键未变 → 纯读快路径零写入零进程；变了/缺失 → 静默重注册 ──
let _healStarted = false;
function _stateKey(): string {
    return ['v1', process.execPath, app.isPackaged ? 'p' : ('d:' + app.getAppPath()), EDITOR_ASSOC_EXTS.join(',')].join('|');
}
/** IDE 域「UI 就绪」后调用（冒烟/未知平台自跳过；幂等）——后台静默执行，绝不阻塞启动。 */
export function startEditorAssocHeal(): void {
    if (_healStarted) { return; }
    _healStarted = true;
    if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') { return; }
    setTimeout(() => { void _heal().catch(() => { /* ignore */ }); }, 2500);
}
async function _heal(): Promise<void> {
    const stateFile = path.join(getDataDir(), 'fa-editor-state.json');
    const key = _stateKey();
    try {
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (cur && cur.v === 1 && cur.key === key) { return; }   // 快路径：内容未变 → 零写入
    } catch { /* 无状态/损坏 → 走重注册 */ }
    const r = await faEditorApply('register');
    if (r.ok && (r.total === 0 || r.taken === r.total)) {
        try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            const tmp = stateFile + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ v: 1, key, ts: Date.now() }), 'utf8');
            fs.renameSync(tmp, stateFile);
        } catch { /* 下次启动重试 */ }
    } else {
        console.warn('[fa-editor] heal incomplete: ' + (r.code || '') + ' ' + r.taken + '/' + r.total);
    }
}

// ── IPC：设置面板行〔设为默认〕（B 一键；单向可反复——无 check/remove）──
export function registerEditorFileAssocIpc(): void {
    ipcMain.handle('qqqide:fileassoc:apply-editor', () => faSerial(async () => {
        const r = await faEditorApply('apply');
        return {
            ok: !!r.ok,
            code: r.ok ? undefined : (r.code || 'apply-failed'),
            total: r.total,
            taken: r.taken,
            fails: (r.fails || []).slice(0, 20),
            err: r.err,
        };
    }));
}
