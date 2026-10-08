// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-linux.ts — 文件关联机器（Linux 实现：freedesktop 桌面条目 + xdg-mime）
//   语义与 Windows（fa-ps.ts）/ macOS（fa-mac.ts）逐项对齐：setDefault=true（缺省）= 一次点击
//   = 全量接管那一族格式的默认打开方式；setDefault=false = 仅候选注册（写桌面条目 + 刷新缓存，
//   不碰 xdg-mime default —— 编辑器域 A+ 启动自愈路径）。两域各自独立桌面条目/名称/标记。
//   本平台无系统保护拦截概念 → 预期一次全量通过；结果恒报 {total, taken}。
//   机制：
//     ① 写 ~/.local/share/applications/qqqide-player.desktop（Exec = <exe> --qqqide-play %F）
//     ② 扩展名 → MIME（xdg-mime query filetype 探针文件；freedesktop 无静态映射表，实测解析）
//     ③ 逐 MIME 设默认（xdg-mime default；落 ~/.config/mimeapps.list [Default Applications]）
//     ④ update-desktop-database 刷新缓存 + xdg-mime query default 逐项回读验证
//   双击链另一端 = main.ts 的 --qqqide-play 宿主域（player-host，跨平台既有链路）。
// ============================================================================
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

const APP_NAME = 'qd (qqqide) 播放器';
const APP_DESC = 'qd (qqqide) 内置媒体播放器 — 视频/音频全格式（转码兜底）';
const DESKTOP_ID = 'qqqide-player.desktop';

/** 参数化（缺省 = 播放器域旧值零回归）：候选注册/夺默认共用同一实现，编辑器域经 opts 换条目。 */
export interface FaLinuxOpts {
    setDefault?: boolean;        // false = 仅候选注册（桌面条目声明 MimeType + 刷缓存；不碰默认）
    desktopId?: string;
    name?: string;
    desc?: string;
    marker?: string;             // Exec 标记（缺省 --qqqide-play）
    neverTake?: string[];        // 探针解析到这 MIME 一律跳过（护不劫持）
    categories?: string;
}

// ★ glib 内容判定规则（2026-10-05 VM 实测）：探针内容必须是纯文本（→ 按扩展名解析）；
//   空文件 → x-zerosize、二进制垃圾 → octet-stream（两者都会把 37 个扩展全吞成同一 MIME）。
const PROBE_CONTENT = 'qqqide-probe\n';
// ★ 禁接管清单：这三类一旦设默认 = 全系统文本/未知二进制都会被播放器劫持（灾难级）——
//   探针解析到它们一律视为失败（跳过该扩展）。
const NEVER_TAKE = ['text/plain', 'application/octet-stream', 'application/x-zerosize'];
// 探针解析不到时的定点兜底（实际文件按内容嗅探仍会命中该 MIME）
const MIME_FALLBACK: Record<string, string> = { '.weba': 'audio/webm' };

/** 打开命令 = 当前进程 exe（打包 = 容器根 qqqide；dev = electron + 项目根）。 */
function _cmd(): { exe: string; appArg: string } {
    return { exe: process.execPath, appArg: app.isPackaged ? '' : app.getAppPath() };
}

/** desktop 文件 Exec 参数转义（双引号包裹 + 内部 \ " 反斜杠转义）。 */
function _q(s: string): string {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function _run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (code: number, out: string) => { if (!done) { done = true; resolve({ code, out }); } };
        try {
            const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (e: any, stdout: any) => {
                finish(e ? (typeof e.code === 'number' ? e.code : 1) : 0, String(stdout || ''));
            });
            child.on('error', () => finish(-1, ''));
        } catch { finish(-1, ''); }
    });
}

export async function faLinuxApply(exts: string[], opts?: FaLinuxOpts): Promise<{ ok: boolean; code?: string; total: number; taken: number; fails: string[]; err?: string }> {
    const o = opts || {};
    const setDefault = (o.setDefault === undefined) ? true : !!o.setDefault;
    const desktopId = o.desktopId || DESKTOP_ID;
    const appName = o.name || APP_NAME;
    const appDesc = o.desc || APP_DESC;
    const marker = o.marker || '--qqqide-play';
    const neverTake = o.neverTake || NEVER_TAKE;
    const categories = o.categories || 'AudioVideo;Player;Video;Audio;';
    const list = (exts || []).filter((e) => /^\.[a-z0-9]+$/i.test(e));
    if (list.length === 0) { return { ok: false, code: 'no-exts', total: 0, taken: 0, fails: [] }; }
    const home = os.homedir();
    const appsDir = path.join(home, '.local', 'share', 'applications');
    try { fs.mkdirSync(appsDir, { recursive: true }); } catch { /* ignore */ }

    // ① 探针目录（xdg-mime query filetype 需要真实文件路径）
    const probeDir = path.join(os.tmpdir(), 'qqqide-fa-lnx');
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(probeDir, { recursive: true }); } catch { /* ignore */ }
    for (const e of list) { try { fs.writeFileSync(path.join(probeDir, 'probe' + e), PROBE_CONTENT); } catch { /* ignore */ } }

    // ② 扩展名 → MIME（并行解析）
    const results = await Promise.all(list.map((e) => _run('xdg-mime', ['query', 'filetype', path.join(probeDir, 'probe' + e)], 8000)));
    const mimeOf: Record<string, string> = {};
    for (let i = 0; i < list.length; i++) {
        const mime = String(results[i].out || '').trim().split('\n')[0].trim();
        if (results[i].code === 0 && mime.indexOf('/') > 0 && neverTake.indexOf(mime) < 0) { mimeOf[list[i]] = mime; }
        else if (MIME_FALLBACK[list[i]]) { mimeOf[list[i]] = MIME_FALLBACK[list[i]]; }   // 探针弱解析 → 定点兜底
    }
    const mimes = Array.from(new Set(Object.keys(mimeOf).map((e) => mimeOf[e])));
    if (mimes.length === 0) { return { ok: false, code: 'mime-unknown', total: list.length, taken: 0, fails: list.slice() }; }

    // ③ desktop 条目（MimeType 全量声明 → 同时出现在「打开方式」列表）
    const c = _cmd();
    const execParts = [_q(c.exe)];
    if (c.appArg) { execParts.push(_q(c.appArg)); }
    execParts.push(marker, '%F');
    const desktop = [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=' + appName,
        'Comment=' + appDesc,
        'Exec=' + execParts.join(' '),
        'Icon=qqqide',
        'Terminal=false',
        'Categories=' + categories,
        'MimeType=' + mimes.join(';') + ';',
        '',
    ].join('\n');
    const desktopPath = path.join(appsDir, desktopId);
    // ★ 内容比对（自愈快路径）：与磁盘一致 → 不重写（仅在 setDefault 时仍走默认设置/校验链）
    let prevDesktop: string | null = null;
    try { prevDesktop = fs.readFileSync(desktopPath, 'utf8'); } catch { prevDesktop = null; }
    const changed = (prevDesktop !== desktop);
    if (changed) {
        try { fs.writeFileSync(desktopPath, desktop, { encoding: 'utf8', mode: 0o644 }); }
        catch (e: any) { return { ok: false, code: 'write-failed', total: list.length, taken: 0, fails: [], err: (e && e.message) || String(e) }; }
    }

    // ③b 仅候选注册（setDefault=false）：不碰默认——写盘成功 + 刷缓存（变了才刷）即完成
    if (!setDefault) {
        if (changed) { await _run('update-desktop-database', [appsDir], 8000); }
        let okFile = false;
        try { okFile = fs.readFileSync(desktopPath, 'utf8') === desktop; } catch { okFile = false; }
        try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return { ok: okFile, code: okFile ? undefined : 'write-failed', total: list.length, taken: okFile ? list.length : 0, fails: okFile ? [] : list.slice() };
    }

    // ④ 设默认（单次调用承载全部 MIME）+ 刷新桌面条目缓存
    const setRes = await _run('xdg-mime', ['default', desktopId].concat(mimes), 30000);
    await _run('update-desktop-database', [appsDir], 8000);

    // ④b 清理陈旧条目（换过扩展集/历史版本可能遗下非目标 MIME 的默认项——只动命中本域条目的行）
    try {
        const mp = path.join(home, '.config', 'mimeapps.list');
        const raw = fs.readFileSync(mp, 'utf8');
        const keep = new Set(mimes);
        const escId = desktopId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reOwn = new RegExp('^([^[][^=]*)=' + escId + ';?\\s*$');
        const out = raw.split('\n').filter((line) => {
            const m = reOwn.exec(line.trim());
            if (!m) { return true; }
            return keep.has(m[1].trim());
        }).join('\n');
        if (out !== raw) { fs.writeFileSync(mp, out, 'utf8'); }
    } catch { /* ignore */ }
    if (setRes.code !== 0) {
        return { ok: false, code: 'set-failed', total: list.length, taken: 0, fails: list.slice() };
    }

    // ⑤ 逐 MIME 回读验证（双击的真实答案；并行）
    const verify = await Promise.all(mimes.map((m) => _run('xdg-mime', ['query', 'default', m], 8000)));
    const takenMime: Record<string, boolean> = {};
    for (let i = 0; i < mimes.length; i++) {
        takenMime[mimes[i]] = verify[i].code === 0 && String(verify[i].out || '').trim() === desktopId;
    }
    let taken = 0;
    const fails: string[] = [];
    for (const e of list) {
        const m = mimeOf[e];
        if (m && takenMime[m]) { taken++; } else { fails.push(e); }
    }
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: taken > 0, code: taken === list.length ? undefined : 'partial', total: list.length, taken, fails };
}
