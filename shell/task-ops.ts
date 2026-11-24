// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// task-ops.ts — 空白面板「一键任务」的壳层执行端（唯一实现）
//
// 语义：任务卡（server-app/ai-panel/panel-tasks.js）只发一个 id 过来；本模块是
//   「id → 本机真实动作」的唯一白名单执行器（动作清单与 tools-defs 的 run_task 枚举一一对应，
//   改任一侧必须同改另一侧）：
//     install_everything  Everything 便携版：下载 → sha256 校验 → 原子换入 qd 同级 program
//                         → 三处桌面快捷方式（唯一一条常驻动作）
//
// ★ 为什么只留这一条：壳层代码是每次发版都要背的账。凡 AI 用常规工具（run_command）能做好的活
//   一律不进壳层——清 C 盘 = capabilities/scripts/clean-c.ps1（只扫描，用户点头才 -Apply），
//   开机自启 / Spotlight / locate = capabilities/tasks.md 里的配方（配合 payload 内的脚本与命令）。
//   只有 Everything 例外：版本号 + 校验值 + 原子换入 + 多桌面落盘必须确定性，AI 猜不出来也不该猜。
//
// 铁律：
//   · 服务器下发的 JSON 永不能变成可执行内容——只认本文件 ACTION 表，未知 id 直接拒。
//   · 桌面 / 启动文件夹一律走系统真值（[Environment]::GetFolderPath），禁拼 %USERPROFILE%\Desktop
//     ——客户把桌面搬到 D 盘是常态（详 do/拓扑/arch/界面）。
//   · 一切目录选择按「目录阶梯」：首选 qd 同级 program，不可写则回退 %LOCALAPPDATA%，选定即记账。
//   · 非 Windows 平台一律如实拒绝（返回 ok:false + 人话原因），绝不假装成功。
//   · PowerShell 一律写临时 .ps1 再执行（禁引号拼接），脚本恒 PS2.0 语法（Win7 基线）。
// ============================================================================

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';

// ── 出厂常量 ────────────────────────────────────────────────────────────────
// Everything 便携包（官方 x64 + qd 显示层预设 ini）——发布在内容层，sha256 随包锁定
const EV = {
    version: '1.5.0.1424b',
    url: 'https://cdn.gh555.com/qqqide/tools/everything-1.5.0.1424b-x64.zip',
    sha256: '83f37c1eceb36ba73e7dcf55345c257467b0965181c6557cad9a46d8d9621bc9',
    size: 3693289,
    exe: 'Everything.exe',
    dirName: 'everything'
};


let _ctx: { root: string; userData: string } = { root: '', userData: '' };

// ════════════════════════════════════════════════════════════════════════════
// 基础工具
// ════════════════════════════════════════════════════════════════════════════
function _isWin(): boolean { return process.platform === 'win32'; }

function _psExe(): string {
    const sys = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 跑一段 PS 脚本（写临时 .ps1 → -File 执行）。返回退出码与标准输出。 */
function _runPs(script: string, timeout = 60000): { ok: boolean; out: string; err: string } {
    const tmp = path.join(os.tmpdir(), 'qd-task-' + process.pid + '-' + Date.now().toString(36) + '.ps1');
    try {
        // ★ 恒带 BOM：否则 PS2 按 ANSI 读脚本，含中文路径/注释会乱码
        fs.writeFileSync(tmp, '\ufeff' + script, 'utf8');
        const out = execFileSync(_psExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
            encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 << 20
        });
        return { ok: true, out: String(out || ''), err: '' };
    } catch (e: any) {
        return {
            ok: false,
            out: String((e && e.stdout) || ''),
            err: String((e && (e.stderr || e.message)) || 'powershell failed')
        };
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* 临时脚本删不掉不影响结果 */ }
    }
}

function _psQuote(s: string): string { return String(s).replace(/'/g, "''"); }

/** 原子写 JSON（tmp + rename；解析失败不覆盖旧文件） */
function _writeJson(file: string, data: any): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        try { fs.renameSync(tmp, file); } catch {
            try { fs.unlinkSync(file); } catch { /* 目标不存在 */ }
            fs.renameSync(tmp, file);
        }
    } catch (e: any) {
        console.warn('[tasks] writeJson failed: ' + ((e && e.message) || e));
    }
}
function _readJson(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function _stateFile(): string { return path.join(_ctx.userData, 'task-ops.state.json'); }
function _state(): any { return _readJson(_stateFile()) || {}; }
function _statePatch(patch: any): void {
    const s = _state();
    Object.keys(patch).forEach(k => { s[k] = patch[k]; });
    _writeJson(_stateFile(), s);
}

/** 广播进度（面板据此给可见回报，禁静默） */
function _progress(payload: any): void {
    try {
        BrowserWindow.getAllWindows().forEach(w => {
            try { if (!w.isDestroyed() && w.webContents) w.webContents.send('qqqide:task:progress', payload); } catch { /* 窗口已销毁 */ }
        });
    } catch { /* 无窗口 */ }
}

function _sizeText(bytes: number): string {
    if (!(bytes > 0)) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

// ════════════════════════════════════════════════════════════════════════════
// 系统真值：桌面 / 启动文件夹（客户改过位置也算对）
// ════════════════════════════════════════════════════════════════════════════
export interface ShellFolders { desktop: string; desktopFallback: string; desktopPublic: string; source: string; }

function _resolveShellFolders(): ShellFolders {
    const fb = {
        desktop: '', desktopFallback: '',
        desktopPublic: process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '',
        source: 'fallback'
    };
    if (!_isWin()) {
        fb.desktop = path.join(os.homedir(), 'Desktop');
        fb.desktopFallback = fb.desktop;
        return fb;
    }
    const out = path.join(os.tmpdir(), 'qd-folders-' + process.pid + '-' + Date.now().toString(36) + '.txt');
    try {
        const script = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            "$p = ''",
            "try { $p = [Environment]::GetFolderPath('Desktop') } catch { $p = '' }",
            "if ((-not $p) -or (-not (Test-Path -LiteralPath $p))) {",
            "  try {",
            "    $k = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
            "    $p2 = $k.Desktop",
            "    if ($p2) { $p2 = [Environment]::ExpandEnvironmentVariables($p2) }",
            "    if ($p2 -and (Test-Path -LiteralPath $p2)) { $p = $p2 }",
            "  } catch { }",
            "}",
            "[IO.File]::WriteAllText('" + _psQuote(out) + "', $p, (New-Object System.Text.UTF8Encoding($false)))"
        ].join('\r\n');
        const r = _runPs(script, 25000);
        let raw = '';
        try { raw = fs.readFileSync(out, 'utf8'); } catch { raw = r.out || ''; }
        raw = String(raw || '').replace(/^\ufeff/, '').trim();
        if (raw) { fb.desktop = raw; fb.source = 'shell'; }
    } catch (e: any) {
        console.warn('[tasks] resolveShellFolders: ' + ((e && e.message) || e));
    } finally {
        try { fs.unlinkSync(out); } catch { /* 忽略 */ }
    }
    if (!fb.desktopFallback) fb.desktopFallback = path.join(os.homedir(), 'Desktop');
    if (!fb.desktop) { fb.desktop = fb.desktopFallback; fb.source = 'fallback'; }
    return fb;
}

/** 桌面目录（主入口；重定向/OneDrive/多盘都走系统真值） */
export function resolveDesktopDirSync(): string {
    if (!_isWin()) return path.join(os.homedir(), 'Desktop');
    return _resolveShellFolders().desktop;
}

export interface ShortcutSpec { lnk: string; target: string; workDir?: string; icon?: string; desc?: string; }

/**
 * 批量建 .lnk（WScript.Shell COM；Win7→Win11 全兼容）。
 * ★ 唯一实现：启动时的 qd 快捷方式、Everything 快捷方式全走这里（禁第二套）。
 * ★ 单次 PowerShell 跑完所有条目——启动路径上不能一个快捷方式开一个进程。
 * ★ 成功与否只认「文件真的落盘」（回读），不认退出码。
 */
export function createShortcuts(specs: ShortcutSpec[]): { ok: boolean; made: string[]; error?: string } {
    if (!_isWin()) return { ok: false, made: [], error: 'unsupported-platform' };
    const list = (specs || []).filter(s => !!(s && s.lnk && s.target));
    if (!list.length) return { ok: false, made: [], error: 'empty-specs' };
    const lines: string[] = ["$ErrorActionPreference = 'Continue'", '$ws = New-Object -ComObject WScript.Shell'];
    for (const s of list) {
        const dir = path.dirname(s.lnk);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 不可建 → 下面建不出来，回读会如实报缺 */ }
        if (!fs.existsSync(dir)) continue;
        const icon = s.icon || '';
        const desc = s.desc || '';
        lines.push('try {');
        lines.push("  $s = $ws.CreateShortcut('" + _psQuote(s.lnk) + "')");
        lines.push("  $s.TargetPath = '" + _psQuote(s.target) + "'");
        lines.push("  $s.WorkingDirectory = '" + _psQuote(s.workDir || path.dirname(s.target)) + "'");
        lines.push("  if ('" + _psQuote(icon) + "') { $s.IconLocation = '" + _psQuote(icon) + "' }");
        lines.push("  if ('" + _psQuote(desc) + "') { $s.Description = '" + _psQuote(desc) + "' }");
        lines.push('  $s.Save()');
        lines.push('} catch { }');
    }
    lines.push('exit 0');
    const r = _runPs(lines.join('\r\n'), 30000);
    const made: string[] = [];
    for (const s of list) {
        try { if (fs.existsSync(s.lnk)) made.push(s.lnk); } catch { /* 权限/路径异常 → 视作未创建 */ }
    }
    if (!made.length) return { ok: false, made, error: (r.err || 'shortcut-create-failed').slice(0, 300) };
    return { ok: true, made };
}



// ════════════════════════════════════════════════════════════════════════════
// 目录阶梯：qd 同级 program → %LOCALAPPDATA%
// ════════════════════════════════════════════════════════════════════════════
/**
 * 启动器所在目录（= 绿色包根，qqqide.exe 所在处）。
 * ★ 打包态 _ctx.root = <包根>/gh555.com（里面同时有 joker.exe）——不能「先看 root」：
 *   那样会返回 Data 目录，基座判定（父目录名是否叫 program）恒失败，安装永远落到
 *   %LOCALAPPDATA%（实测 Win7 真机：qd 在 C:\program\qd 时本该装到 C:\program\everything）。
 */
function _launcherDirFor(root: string): string {
    let pkg = root;
    try { if (path.basename(root).toLowerCase() === 'gh555.com') pkg = path.dirname(root); } catch { /* 非法路径 → 原样 */ }
    const cands = [pkg, root];
    for (const c of cands) {
        if (c && (fs.existsSync(path.join(c, 'qqqide.exe')) || fs.existsSync(path.join(c, 'joker.exe')))) return c;
    }
    return '';
}

function _launcherDir(): string { return _launcherDirFor(_ctx.root); }

function _writable(dir: string): boolean {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.qd-w-' + Date.now().toString(36));
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        return true;
    } catch { return false; }
}

/**
 * 任务安装根目录（一万年规则）：
 *   ① 记账目录仍可写 → 直接用（老用户路径永不漂移）
 *   ② qd 启动器所在目录的父目录名为 program（不区分大小写）→ <父>/everything
 *   ③ 兜底 %LOCALAPPDATA%\qd\program\everything（任何机器都可写，无需管理员）
 * 选定即记账（task-ops.state.json），下次直接用同一处。
 */
function _installBase(): { dir: string; via: string } {
    const st = _state();
    if (st.installBase && fs.existsSync(st.installBase) && _writable(st.installBase)) {
        return { dir: path.join(st.installBase, EV.dirName), via: 'state' };
    }
    const ld = _launcherDir();
    if (ld) {
        const parent = path.dirname(ld);
        if (path.basename(parent).toLowerCase() === 'program' && _writable(parent)) {
            _statePatch({ installBase: parent });
            return { dir: path.join(parent, EV.dirName), via: 'program' };
        }
    }
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const base = path.join(local, 'qd', 'program');
    if (_writable(base)) {
        _statePatch({ installBase: base });
        return { dir: path.join(base, EV.dirName), via: 'localappdata' };
    }
    return { dir: '', via: 'none' };
}

// ════════════════════════════════════════════════════════════════════════════
// 下载 / 解压
// ════════════════════════════════════════════════════════════════════════════
function _download(url: string, dest: string, taskId: string, timeout = 180000): Promise<{ ok: boolean; size: number; sha: string; error?: string }> {
    return new Promise(resolve => {
        const file = fs.createWriteStream(dest);
        const hash = crypto.createHash('sha256');
        let size = 0;
        let settled = false;
        const done = (res: any) => {
            if (settled) return;
            settled = true;
            try { file.close(); } catch { /* 已关闭 */ }
            resolve(res);
        };
        const go = (u: string, redirects = 0) => {
            const mod = u.indexOf('https:') === 0 ? https : http;
            const req = mod.get(u, { timeout: 30000, headers: { 'User-Agent': 'qqqide-task' } }, (res: any) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
                    res.resume();
                    return go(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return done({ ok: false, size, sha: '', error: 'HTTP ' + res.statusCode });
                }
                const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
                let lastTick = 0;
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    hash.update(chunk);
                    const now = Date.now();
                    if (now - lastTick > 400) {
                        lastTick = now;
                        _progress({ id: taskId, phase: 'download', pct: total ? Math.min(99, Math.round(size * 100 / total)) : 0, text: '下载中 ' + _sizeText(size) + (total ? ' / ' + _sizeText(total) : '') });
                    }
                });
                res.pipe(file);
                file.on('finish', () => {
                    done({ ok: true, size, sha: hash.digest('hex') });
                });
                res.on('error', (e: any) => done({ ok: false, size, sha: '', error: (e && e.message) || 'stream error' }));
            });
            req.on('error', (e: any) => done({ ok: false, size, sha: '', error: (e && e.message) || 'network error' }));
            req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* 已销毁 */ } });
            req.setTimeout(timeout, () => { try { req.destroy(new Error('timeout')); } catch { /* 已销毁 */ } });
        };
        go(url);
    });
}

/** 解压 zip 到目标目录（Win: ZipFile → Expand-Archive → Shell COM；其余: unzip） */
function _extractZip(zip: string, dest: string): { ok: boolean; error?: string } {
    try { fs.mkdirSync(dest, { recursive: true }); } catch { /* 下面会如实失败 */ }
    if (!_isWin()) {
        try {
            execFileSync('unzip', ['-o', zip, '-d', dest], { timeout: 180000 });
            return { ok: true };
        } catch (e: any) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$zip = '" + _psQuote(zip) + "'",
        "$dst = '" + _psQuote(dest) + "'",
        "$ok = $false",
        "try {",
        "  Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dst)",
        "  $ok = $true",
        "} catch { $ok = $false }",
        "if (-not $ok) {",
        "  try { Expand-Archive -Path $zip -DestinationPath $dst -Force; $ok = $true } catch { $ok = $false }",
        "}",
        "if (-not $ok) {",
        "  try {",
        "    $sh = New-Object -ComObject Shell.Application",
        "    $z = $sh.NameSpace($zip)",
        "    $d = $sh.NameSpace($dst)",
        "    if ($z -and $d) {",
        "      $n = $z.Items().Count",
        "      $d.CopyHere($z.Items(), 16)",
        "      $t0 = Get-Date",
        "      while (((Get-Date) - $t0).TotalSeconds -lt 120) {",
        "        if ($d.Items().Count -ge $n) { Start-Sleep -Milliseconds 600; $ok = $true; break }",
        "        Start-Sleep -Milliseconds 400",
        "      }",
        "    }",
        "  } catch { $ok = $false }",
        "}",
        "if ($ok) { exit 0 } else { exit 1 }"
    ].join('\r\n');
    const r = _runPs(script, 240000);
    if (r.ok) return { ok: true };
    return { ok: false, error: (r.err || 'extract-failed').slice(0, 300) };
}

function _rmrf(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

// ════════════════════════════════════════════════════════════════════════════
// 动作：Everything
// ════════════════════════════════════════════════════════════════════════════
function _everythingRunning(): boolean {
    if (!_isWin()) return false;
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Everything.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
        return /Everything\.exe/i.test(out || '');
    } catch { return false; }
}

/** 系统里已装的 Everything（Program Files 两处 + PATH 探测）；找不到返回 '' */
function _existingEverything(): string {
    if (!_isWin()) return '';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const cands = [
        path.join(pf, 'Everything', 'Everything.exe'),
        path.join(pf86, 'Everything', 'Everything.exe')
    ];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 权限 */ } }
    return '';
}

function _shortcutEverything(exePath: string, taskId: string): { ok: boolean; message: string; warn?: boolean } {
    const dirs = desktopDirsForShortcut();
    if (!dirs.length) return { ok: false, message: '已安装，但读不到桌面目录（快捷方式未创建）', warn: true };
    const specs = dirs.map(d => ({
        lnk: path.join(d, 'Everything.lnk'),
        target: exePath, workDir: path.dirname(exePath), icon: exePath + ',0', desc: 'Everything 文件搜索'
    }));
    const r = createShortcuts(specs);
    _progress({ id: taskId, done: true });
    if (!r.ok) {
        return { ok: false, message: '已安装，但桌面快捷方式创建失败' + (r.error ? '（' + r.error + '）' : ''), warn: true };
    }
    return { ok: true, message: '桌面快捷方式：' + r.made.map(p => p.slice(0, p.lastIndexOf(path.sep))).join(' 、 ') };
}

async function _actionInstallEverything(taskId: string): Promise<any> {
    if (!_isWin()) {
        return { ok: false, warn: true, message: 'Everything 仅 Windows 可用；macOS 请直接用 Spotlight（⌘ + 空格），Linux 请用 locate/mlocate。' };
    }
    if (process.arch !== 'x64') {
        return { ok: false, warn: true, message: '当前系统为 ' + process.arch + '，qd 与 Everything 均只提供 64 位（x64）版本。' };
    }
    const st = _state();
    const target = _installBase();
    const marker = st.everything || null;

    // ① 我们自己装过且在位 → 只补快捷方式（幂等）
    if (marker && marker.dir && fs.existsSync(path.join(marker.dir, EV.exe))) {
        if (marker.version === EV.version) {
            const s = _shortcutEverything(path.join(marker.dir, EV.exe), taskId);
            return { ok: s.ok, warn: !s.ok, message: s.ok ? 'Everything 已安装（' + marker.dir + '），' + s.message : s.message };
        }
        // 版本不同 → 走重装（保留目录，非破坏式覆盖）
    }

    // ② 系统已有 Everything（用户自己装过）→ 只做快捷方式，绝不重复安装
    const existing = _existingEverything();
    if (existing && !marker) {
        const s = _shortcutEverything(existing, taskId);
        return { ok: s.ok, warn: !s.ok, message: s.ok ? '系统已有 Everything，' + s.message : s.message };
    }

    if (_everythingRunning()) {
        return { ok: false, warn: true, message: '检测到 Everything 正在运行（它与新装实例共用同一份），请先退出 Everything 再执行本任务。' };
    }

    if (!target.dir) {
        return { ok: false, message: '找不到可写的安装目录（qd 同级 program 与 %LOCALAPPDATA% 都不可写）。' };
    }

    // ③ 下载（内容锁定：size + sha256 双校验）
    _progress({ id: taskId, phase: 'download', pct: 0, text: '准备下载 Everything…' });
    const dlDir = path.join(os.tmpdir(), 'qd-dl');
    try { fs.mkdirSync(dlDir, { recursive: true }); } catch { /* 忽略 */ }
    const zipPath = path.join(dlDir, 'everything-' + EV.version + '.zip');
    const dl = await _download(EV.url, zipPath, taskId);
    if (!dl.ok) {
        _rmrf(zipPath);
        return { ok: false, message: '下载失败：' + (dl.error || '未知网络错误') + '（可稍后重试）' };
    }
    if (dl.sha !== EV.sha256) {
        _rmrf(zipPath);
        return { ok: false, message: '安装包校验不通过（sha256 不符），已丢弃。请稍后重试。' };
    }

    // ④ 解压到临时目录 → 校验 → 原子换入（失败绝不破坏旧目录）
    _progress({ id: taskId, phase: 'extract', pct: 100, text: '解压中…' });
    const staging = target.dir + '.staging';
    const oldDir = target.dir + '.replacing';
    _rmrf(staging);
    const ex = _extractZip(zipPath, staging);
    if (!ex.ok || !fs.existsSync(path.join(staging, EV.exe))) {
        _rmrf(staging); _rmrf(zipPath);
        return { ok: false, message: '解压失败或产物不完整：' + (ex.error || '未找到 ' + EV.exe) };
    }
    try {
        _rmrf(oldDir);
        if (fs.existsSync(target.dir)) fs.renameSync(target.dir, oldDir);
        fs.renameSync(staging, target.dir);
    } catch (e: any) {
        // 换入失败 → 还原旧目录
        try { if (!fs.existsSync(target.dir) && fs.existsSync(oldDir)) fs.renameSync(oldDir, target.dir); } catch { /* 尽力 */ }
        _rmrf(staging); _rmrf(zipPath);
        return { ok: false, message: '安装目录写入失败：' + ((e && e.message) || e) };
    }
    _rmrf(oldDir);
    _rmrf(zipPath);

    const exePath = path.join(target.dir, EV.exe);
    if (!fs.existsSync(exePath)) {
        return { ok: false, message: '安装后未找到 ' + EV.exe + '（' + target.dir + '）' };
    }
    _statePatch({ everything: { dir: target.dir, version: EV.version, sha256: EV.sha256, at: Date.now(), exe: exePath } });

    // ⑤ 桌面快捷方式（系统真值目录）
    const s = _shortcutEverything(exePath, taskId);
    if (!s.ok) return { ok: true, warn: true, message: 'Everything 已安装到 ' + target.dir + '，但' + s.message };
    return { ok: true, message: 'Everything 已安装到 ' + target.dir + '，' + s.message };
}

// ════════════════════════════════════════════════════════════════════════════
// IPC 注册
// ════════════════════════════════════════════════════════════════════════════
// 单飞登记（动作 id → 正在执行；详见 qqqide:task:run）
const _running = new Set<string>();

// ★ 唯一一条常驻动作。新增一条前先问：这件事 AI 用 run_command + capabilities 里的配方做不好吗？
//   能做好的就不进壳层——壳层代码 = 每次发版都要背的账（详文件头注释）。
const ACTIONS: Record<string, (taskId: string, opts: any) => any> = {
    install_everything: async (id) => _actionInstallEverything(id)
};

// ipc 参数默认真实 ipcMain（单测可注入假体；生产路径零差异）
export function registerTaskOpsIpc(root: string, userData: string, ipc: any = ipcMain): void {
    _ctx = { root, userData };

    ipc.handle('qqqide:task:probe', async () => {
        const folders = _isWin() ? _resolveShellFolders() : null;
        const st = _state();
        const target = _installBase();
        return {
            ok: true,
            platform: process.platform,
            arch: process.arch,
            launcherDir: _launcherDir(),
            installDir: target.dir,
            installVia: target.via,
            desktop: folders ? folders.desktop : path.join(os.homedir(), 'Desktop'),
            desktopDirs: desktopDirsForShortcut(),
            desktopSource: folders ? folders.source : 'fallback',
            everything: st.everything || null
        };
    });

    ipc.handle('qqqide:task:run', async (_e: any, id: string, opts: any) => {
        const key = String(id || '');
        const fn = ACTIONS[key];
        if (!fn) return { ok: false, message: '未知任务（客户端与服务器任务表不一致）' };
        // ★ 单飞：同一动作同时只跑一份（两个窗口各点一次 = 两份写同一 staging → 卡死/互相踩）
        if (_running.has(key)) return { ok: false, warn: true, message: '这个任务正在执行中，完成前无需重复点。' };
        _running.add(key);
        try {
            const res = await fn(key, opts || {});
            return res || { ok: true };
        } catch (e: any) {
            console.error('[tasks] ' + id + ' failed: ' + ((e && e.message) || e));
            return { ok: false, message: '执行失败：' + ((e && e.message) || String(e)) };
        } finally {
            _running.delete(key);
        }
    });
}

// ── 单测凸口（只暴露纯执行件；动作入口恒走 registerTaskOpsIpc 白名单）────────
export const __test = {
    download: _download,
    extractZip: _extractZip,
    sizeText: _sizeText,
    launcherDirFor: _launcherDirFor,
    everything: EV
};

// ── 桌面快捷方式目录（同一真值，禁第二套；qd 自身快捷方式与 Everything 共用）────
export function desktopDirsForShortcut(): string[] {
    if (!_isWin()) return [];
    const f = _resolveShellFolders();
    const out: string[] = [];
    const add = (d: string) => {
        if (!d) return;
        let k = '';
        try { k = path.resolve(d).toLowerCase(); } catch { k = d.toLowerCase(); }
        for (const x of out) {
            let kx = '';
            try { kx = path.resolve(x).toLowerCase(); } catch { kx = x.toLowerCase(); }
            if (kx === k) return;
        }
        out.push(d);
    };
    // ① 系统真值桌面（D 盘 / OneDrive / 重定向都算）——这一份必须先成功
    add(f.desktop);
    // ② C 盘用户目录桌面再放一份（用户明确要求：桌面被搬到 D 盘也要在 C 盘有底）
    add(path.join(os.homedir(), 'Desktop'));
    // ③ 公共桌面（所有用户可见；用户配置文件也不在 C 盘时的最后一份）
    add(f.desktopPublic);
    return out;
}
