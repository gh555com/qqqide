// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
//
// ipc-syspy.ts — 系统解释器机器（设置面板「系统解释器」行：Node / Python 两按钮后端）
//
// ★ 双目标（2026-09-26）：
//   python：把 .py 关联一次性指向绿色包内置 Python（双击 = python -i，跑完窗口不关）
//   node：把 .js 关联一次性指向「引擎同源 Node 门面」（engines/node/node.exe[win] / engines/node/node[mac]，
//     = Electron 的 ELECTRON_RUN_AS_NODE；双击 = cmd 包裹 + pause，跑完窗口不关；零下载零维护）
//
// ★ 双平台（2026-09-26）：
//   win32：把 .py/.js 关联一次性指向内置解释器，只管当：
//     ① HKCU\Software\Classes（Python.File 命令 + .py 默认值）
//     ② UserChoice：hash 强写（Deny ACL 突破 → 写 ProgId + 重算 hash，防跨分钟重试）
//     ③ HKCU PATH 前置内置 Python 目录（去重后置顶——WindowsApps 假存根恒被压后）
//     ④ AssocQueryString 验证；失败逐级回退：旧版 hash → 删 UserChoice → 清 FileExts 遗留（Win7）→ UAC 写 HKLM
//     ⑤ .pyw 第二遍（Python.NoConFile + pythonw，无控制台，与 python.org 官方语义一致）；成功后 SHChangeNotify 通知外壳立即刷新
//   darwin：osacompile 生成 Launcher.app（{hostDir}/syspy/qqqide-syspy.app）→ lsregister 注册
//     → LSSetDefaultRoleHandlerForContentType 设默认 → NSWorkspace 回读验证；双击 .py
//     → Launcher on open → run.sh → Terminal 窗口 → 内置 Python -i（跑完窗口不关）。
//     免管理员/无 UAC；PATH 前置 ~/.zprofile（bash 用户 ~/.bash_profile）；
//     runner 钉清单稳定路径 bin/python3（symlink）——引擎目录内升级不断链。
// 只管当：不维护、不追搬迁；用户再点一次 = 幂等刷新重写。
// hash 算法 = Windows UserChoice 公开逆向格式（1803+ 主版 + 1507 旧版回退）。
//
// PS2.0 兼容（Win7 出厂）：不用 ConvertTo-Json，输出 QQQIDE_SYSPY_* 行协议；
// 脚本经 stdin（-Command -）传入，全程 ASCII，零临时脚本文件（UAC 兜底除外）。
// CLR2 铁律（PS2 引擎 = CLR2）：禁用 PS3.0+ 构造（PSTypeName 等）；禁用 .NET4 API（RegistryKey.Handle
// 等）——注册表 FT 读取走原生 RegOpenKeyExW（QS.GetKeyFT）。实测 PS2 下 -Command - 正常执行并退出。
//
// IPC：qqqide:syspy:check / qqqide:syspy:apply → preload bridge.sysPy

import { ipcMain } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getComponentBin } from './component-checker';
import { getHostDir } from './portable-paths';
import * as syspyReport from './syspy-report';
import { notifySyspyFailed } from './wq-ping';
import { PS_HEAD, PS_BODY } from './syspy-ps';

// PS 脚本体（PS_HEAD/PS_BODY）→ ./syspy-ps.ts（纯常量；PS2/CLR2 兼容铁律见其文件头，改脚本必须复核）

// ── PS 执行（异步，行协议解析） ──
interface PsResult {
    ok: boolean;
    fields: Record<string, string>;
    raw: string;
}

// Windows PowerShell 解析：优先绝对路径（SystemRoot\System32\WindowsPowerShell\v1.0——PATH 被裁剪的
// 机器/绿色包环境也稳）；缺失回落裸名。产品调用恒为 stdin（-Command -）：实测 PS2 引擎仅此模式正常
// 执行并退出（-File / 内联 -Command 在管道 stdin 下不退出，禁改用）。
const PS_EXE = (() => {
    try {
        const abs = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        return fs.existsSync(abs) ? abs : 'powershell.exe';
    } catch { return 'powershell.exe'; }
})();

export function runPs(script: string, env: Record<string, string>, timeoutMs: number, prefix: string = 'QQQIDE_SYSPY_'): Promise<PsResult> {
    return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
                env: { ...process.env, ...env } as NodeJS.ProcessEnv,
                windowsHide: true,
            });
        } catch (e: any) {
            resolve({ ok: false, fields: { CODE: 'spawn-failed', ERR: String(e && e.message || e) }, raw: '' });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch { /* ignore */ }
            resolve({ ok: false, fields: { CODE: 'timeout' }, raw: stdout + '\n' + stderr });
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', (e: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, fields: { CODE: 'spawn-failed', ERR: String(e && e.message || e) }, raw: '' });
        });
        child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const fields: Record<string, string> = {};
            const re = new RegExp('^' + prefix + '([A-Z0-9_]+)=(.*)$');
            for (const line of stdout.split(/\r?\n/)) {
                const m = re.exec(line.trim().replace(/^\uFEFF/, ''));
                if (m) fields[m[1]] = m[2];
            }
            if (!fields.CODE && stderr) fields.ERR = stderr.slice(0, 400);
            resolve({ ok: fields.OK === '1', fields, raw: stdout + '\n' + stderr });
        });
        try { child.stdin.write(script); child.stdin.end(); } catch { /* ignore */ }
    });
}

export function b64d(v: string | undefined): string {
    if (!v) return '';
    try { return Buffer.from(v, 'base64').toString('utf8'); } catch { return ''; }
}

/** PS 数字字段 → number（缺省/非法 → -1）。 */
function pi(v: string | undefined): number {
    const n = parseInt(String(v === undefined || v === '' ? '-1' : v), 10);
    return Number.isFinite(n) ? n : -1;
}

// ── Node 门面（静态资产 engines/node/，随引擎发布；win=node.exe C 小启动器 / mac=node sh 脚本）──
//   门面本体把调用转交本包 Electron（ELECTRON_RUN_AS_NODE=1）——零下载、离线可用、与 IDE 同源（Node 16）、Win7-11 全覆盖
function resolveEnginesRoot(portableRoot: string): string | null {
    try {
        const pyBin = getComponentBin(portableRoot, 'python');
        if (!pyBin) return null;
        let root = path.dirname(pyBin);
        root = path.dirname(root);                                     // win: engines/python -> engines
        if (process.platform === 'darwin') root = path.dirname(root);  // mac: engines/python/bin -> engines
        return root;
    } catch { return null; }
}

function nodeFacadePath(portableRoot: string): string | null {
    const root = resolveEnginesRoot(portableRoot);
    if (!root) return null;
    return path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
}

function nodeEnv(facade: string, ext: string): Record<string, string> {
    return {
        QQQIDE_SYSPY_EXE: facade,
        QQQIDE_SYSPY_DIR: path.dirname(facade),
        QQQIDE_SYSPY_EXT: ext,
        QQQIDE_SYSPY_PROGID: 'qqqide.NodeScript',
        QQQIDE_SYSPY_FLAGS: 'none',
        QQQIDE_SYSPY_MATCH: 'node',
        QQQIDE_SYSPY_WRAP: 'pause',
        QQQIDE_SYSPY_APPNAME: 'Node (qd)',
        QQQIDE_SYSPY_ALLEXT: '.js;.mjs;.cjs',
    };
}

// Windows node apply：门面预检 → sidecar（目标 = 运行中的 Electron 本体，搬迁失效回退相对路径）→
// PS 主通（.js）→ .mjs/.cjs 尽力而为 → 首写备份（sysnode-backup.json）
async function winNodeApply(portableRoot: string): Promise<{ ok: boolean; code: string; via?: string; blocked?: boolean; aq?: string; aqRc?: number; uc?: string; err?: string }> {
    const facade = nodeFacadePath(portableRoot);
    if (!facade || !fs.existsSync(facade)) return { ok: false, code: 'no-node' };
    try { fs.writeFileSync(path.join(path.dirname(facade), 'node-target.txt'), process.execPath + '\n', 'utf8'); } catch { /* 容错 */ }
    const r = await runPs(PS_HEAD + PS_BODY, { ...nodeEnv(facade, '.js'), QQQIDE_SYSPY_MODE: 'apply' }, 300000);
    for (const ext of ['.mjs', '.cjs']) {
        try { await runPs(PS_HEAD + PS_BODY, { ...nodeEnv(facade, ext), QQQIDE_SYSPY_MODE: 'apply' }, 300000); } catch { /* 尽力而为 */ }
    }
    try {
        const bakPath = path.join(portableRoot, 'Data', 'alphal', 'sysnode-backup.json');
        if (!fs.existsSync(bakPath)) {
            fs.mkdirSync(path.dirname(bakPath), { recursive: true });
            const bak: Record<string, any> = {
                ts: new Date().toISOString(),
                nodeFacade: facade,
                oldClassesCmd: b64d(r.fields.OLD_CLASSES_CMD),
                oldJsDefault: b64d(r.fields.OLD_PY_DEFAULT),
                oldUserChoiceProgId: b64d(r.fields.OLD_UC_PROGID),
                oldUserChoiceHash: b64d(r.fields.OLD_UC_HASH),
                oldPath: b64d(r.fields.OLD_PATH),
            };
            fs.writeFileSync(bakPath, JSON.stringify(bak, null, 2), 'utf8');
        }
    } catch { /* 备份失败不影响主流程 */ }
    if (r.ok) {
        return {
            ok: true, code: 'ok', via: r.fields.VIA || '',
            aq: b64d(r.fields.AQ), aqRc: pi(r.fields.AQRC), uc: b64d(r.fields.UC_PROGID2),
        };
    }
    const code = r.fields.CODE === 'no-python' ? 'no-node' : (r.fields.CODE || 'verify-failed');
    console.warn('[syspy] node apply fail:', r.fields.CODE, (r.fields.ERR || '').slice(0, 300));
    return {
        ok: false, code, via: r.fields.VIA || '',
        blocked: r.fields.BLOCKED === '1',
        aq: b64d(r.fields.AQ), aqRc: pi(r.fields.AQRC), uc: b64d(r.fields.UC_PROGID2),
        err: (b64d(r.fields.PSERR) || r.fields.ERR || '').slice(0, 400),
    };
}

// ══════════════════════════════════════════════════════════════
// macOS 分支（2026-09-26）——同一按钮、另一套系统机制（免管理员，无 UAC）
//   机制链：osacompile 生成 Launcher.app（{hostDir}/syspy/qqqide-syspy.app）
//     → lsregister 注册 → LSSetDefaultRoleHandlerForContentType 设默认
//     → NSWorkspace.URLForApplicationToOpenURL 回读（唯一验证器）
//   双击/⌘O 链路：.py → Launcher(on open) → run.sh → 一次性 .command
//     → Terminal 窗口 → 内置 Python -i（看得见输出、跑完窗口不关——与 Windows 同款语义；
//     思路同 python.org 官方 Python Launcher，但直接复用内置 Python）。
//   只读检查：回读已解析默认程序 + 登录 shell PATH 探查（排除 Apple /usr/bin 桩与驻场路径）。
//   只管当：不维护不追搬迁；再点一次 = 幂等重写。
// ══════════════════════════════════════════════════════════════
const MAC_BUNDLE_ID = 'com.qqqide.syspy';
const MAC_APP_NAME = 'qqqide-syspy.app';
const MAC_PLISTBUDDY = '/usr/libexec/PlistBuddy';
const MAC_PLUTIL = '/usr/bin/plutil';
const MAC_PATH_BEGIN = '# >>> qqqide syspy >>>';
const MAC_PATH_END = '# <<< qqqide syspy <<<';
const MAC_LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

interface CmdResult { code: number | null; out: string; err: string; }

function runCmd(bin: string, args: string[], timeoutMs: number): Promise<CmdResult> {
    return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try { child = spawn(bin, args, { windowsHide: true }); }
        catch (e: any) { resolve({ code: -1, out: '', err: String((e && e.message) || e) }); return; }
        let out = ''; let err = ''; let settled = false;
        const timer = setTimeout(() => {
            if (settled) return; settled = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve({ code: null, out, err });
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
        child.on('error', (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code: -1, out, err: err + String(((e as any) && (e as any).message) || e) }); });
        child.on('close', (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, out, err }); });
    });
}

function normPath(p: string): string {
    let s = String(p || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    try { s = fs.realpathSync(s); } catch { /* keep */ }
    return s.toLowerCase();
}

/** NSWorkspace 回读：该 .py 此刻会被哪个 app 打开（= 双击的真实答案）。 */
function jxaResolveApp(probePath: string): Promise<string> {
    const js = 'ObjC.import("AppKit"); var ws=$.NSWorkspace.sharedWorkspace; var u=$.NSURL.fileURLWithPath(' + JSON.stringify(probePath) + '); var a=ws.URLForApplicationToOpenURL(u); a ? ObjC.unwrap(a.path) : "";';
    return runCmd('osascript', ['-l', 'JavaScript', '-e', js], 15000).then(r => (r.out || '').trim());
}

/** LSSetDefaultRoleHandlerForContentType：设默认打开程序（返回 OSStatus，0 = OK）。 */
function jxaSetHandler(uti: string, bundleId: string): Promise<number | null> {
    const js = 'ObjC.import("CoreServices"); var r=$.LSSetDefaultRoleHandlerForContentType($(' + JSON.stringify(uti) + '), -1, $(' + JSON.stringify(bundleId) + ')); r;';
    return runCmd('osascript', ['-l', 'JavaScript', '-e', js], 15000).then(r => {
        const n = parseInt((r.out || '').trim(), 10);
        return Number.isFinite(n) ? n : null;
    });
}

/** 探针文件（LS 回读需要一个真实存在的 .py 路径）。 */
function macEnsureProbe(hostDir: string): string {
    const dir = path.join(hostDir, 'syspy');
    const probe = path.join(dir, 'probe.py');
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(probe)) fs.writeFileSync(probe, '# qqqide syspy probe\n', 'utf8');
    } catch { /* 容错：读不到 → 空结果 */ }
    return probe;
}

/** 探针文件（node：LS 回读需要一个真实存在的 .js 路径）。 */
function macEnsureProbeJs(hostDir: string): string {
    const dir = path.join(hostDir, 'syspy');
    const probe = path.join(dir, 'probe.js');
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(probe)) fs.writeFileSync(probe, '// qqqide sysnode probe\n', 'utf8');
    } catch { /* 容错：读不到 → 空结果 */ }
    return probe;
}

/** 登录 shell PATH 探查：是否存在第三方解析器（排除 Apple /usr/bin 桩与驻场路径）。 */
async function macThirdPartyTool(target: 'python' | 'node'): Promise<boolean> {
    let sh = '/bin/zsh';
    try { const u = os.userInfo(); if (u && (u as any).shell) sh = (u as any).shell; } catch { /* ignore */ }
    const probeCmd = (target === 'node')
        ? 'command -v node 2>/dev/null; command -v nodejs 2>/dev/null'
        : 'command -v python3 2>/dev/null; command -v python 2>/dev/null';
    const r = await runCmd(sh, ['-lc', probeCmd], 8000);
    const host = normPath(getHostDir());
    for (const raw of (r.out || '').split(/\r?\n/)) {
        const p = raw.trim();
        if (!p) continue;
        const n = normPath(p);
        if (n.startsWith('/usr/bin/') || n.startsWith('/bin/') || n.startsWith('/system/') || n.startsWith('/usr/libexec/')) continue;
        if (host && n.startsWith(host + '/')) continue;
        return true;
    }
    return false;
}

/** Launcher 内嵌 AppleScript —— on open = 双击/⌘O 入口。 */
function macAppleScript(runnerPath: string): string {
    const lit = '"' + runnerPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return [
        'on open theFiles',
        '\trepeat with f in theFiles',
        '\t\tset fp to POSIX path of f',
        '\t\tdo shell script quoted form of ' + lit + ' & " " & quoted form of fp',
        '\tend repeat',
        '\tquit',
        'end open',
        '',
    ].join('\n');
}

/** Launcher run.sh —— 生成一次性 .command → Terminal 窗口 → 内置 Python -i。 */
function macRunner(enginesRoot: string): string {
    const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const pyExe = enginesRoot + '/python/bin/python3';
    const nodeExe = enginesRoot + '/node/node';
    return [
        '#!/bin/bash',
        '# qqqide interpreter runner — argv1 = 脚本路径（.js/.mjs/.cjs → 内置 Node；其余 → 内置 Python；可重新生成覆盖）',
        'SRC="$1"; [ -n "$SRC" ] || exit 0',
        'case "$SRC" in',
        '  *.js|*.mjs|*.cjs) EXE=' + sq(nodeExe) + '; LABEL="Node" ;;',
        '  *) EXE=' + sq(pyExe) + '; LABEL="Python" ;;',
        'esac',
        'if [ ! -x "$EXE" ]; then',
        '  /usr/bin/osascript -e ' + sq('display dialog "内置解释器已失效（安装目录可能被移动）：请在 qd (qqqide) 设置里重新点击「做系统 Node 解释器」或「做系统 Python 解释器」" buttons {"好"} default button 1 with icon caution with title "qd (qqqide)"') + ' >/dev/null 2>&1',
        '  exit 1',
        'fi',
        'CACHE="$HOME/Library/Caches/qqqide-syspy"; mkdir -p "$CACHE" 2>/dev/null',
        'find "$CACHE" -name "run-*.command" -mtime +7 -delete 2>/dev/null',
        'CMD="$CACHE/run-$(date +%s)-$$.command"',
        '{',
        '  echo "#!/bin/bash"',
        "  printf 'echo %q\\n' \"* qd (qqqide) · 内置 $LABEL · $SRC\"",
        '  printf "exec %q -i %q\\n" "$EXE" "$SRC"',
        '} > "$CMD"',
        'chmod 755 "$CMD" 2>/dev/null',
        'exec /usr/bin/open -a Terminal "$CMD"',
        '',
    ].join('\n');
}

/** Info.plist 补丁（Set 失败自动 Add；文档类型整树重建，幂等）。 */
async function macPlistPatch(plist: string): Promise<void> {
    const pb = async (cmd: string) => (await runCmd(MAC_PLISTBUDDY, ['-c', cmd, plist], 10000)).code === 0;
    if (!(await pb('Set :CFBundleIdentifier ' + MAC_BUNDLE_ID))) await pb('Add :CFBundleIdentifier string ' + MAC_BUNDLE_ID);
    if (!(await pb('Set :LSUIElement true'))) await pb('Add :LSUIElement bool true');
    if (!(await pb('Set :CFBundleDisplayName "qd (qqqide) Interpreter"'))) await pb('Add :CFBundleDisplayName string "qd (qqqide) Interpreter"');
    await pb('Delete :CFBundleDocumentTypes');
    await pb('Add :CFBundleDocumentTypes array');
    await pb('Add :CFBundleDocumentTypes:0 dict');
    await pb('Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array');
    await pb('Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string py');
    await pb('Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer');
    await pb('Add :CFBundleDocumentTypes:0:LSHandlerRank string Default');
    await pb('Add :CFBundleDocumentTypes:0:LSItemContentTypes array');
    await pb('Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string public.python-script');
    await pb('Add :CFBundleDocumentTypes:1 dict');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions array');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions:0 string js');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions:1 string mjs');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions:2 string cjs');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeRole string Viewer');
    await pb('Add :CFBundleDocumentTypes:1:LSHandlerRank string Default');
    await pb('Add :CFBundleDocumentTypes:1:LSItemContentTypes array');
    await pb('Add :CFBundleDocumentTypes:1:LSItemContentTypes:0 string com.netscape.javascript-source');
}

/** PATH 追加（登录 shell profile；幂等块；只写 zsh/bash，其余 shell 跳过并如实记录）。 */
function macAppendPath(enginesRoot: string): Record<string, any> {
    const pyDir = enginesRoot + '/python/bin';
    const nodeDir = enginesRoot + '/node';
    const home = os.homedir();
    let sh = '/bin/zsh';
    try { const u = os.userInfo(); if (u && (u as any).shell) sh = (u as any).shell; } catch { /* ignore */ }
    const base = path.basename(sh).toLowerCase();
    let file = '';
    if (base.indexOf('zsh') >= 0) file = path.join(home, '.zprofile');
    else if (base.indexOf('bash') >= 0) file = path.join(home, '.bash_profile');
    const backup: Record<string, any> = { shell: sh, profileFile: file || null, profileExisted: false, profileContentB64: '' };
    if (!file) return backup;
    const BEGIN = MAC_PATH_BEGIN;
    const END = MAC_PATH_END;
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 不存在 */ }
    backup.profileExisted = !!prev;
    backup.profileContentB64 = Buffer.from(prev, 'utf8').toString('base64');
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let next = prev.replace(new RegExp(esc(BEGIN) + '[\\s\\S]*?' + esc(END) + '\\n?', 'g'), '');
    if (next && !next.endsWith('\n')) next += '\n';
    next += BEGIN + '\n' + 'export PATH="' + pyDir + ':$PATH"\n' + 'export PATH="' + nodeDir + ':$PATH"\n' + END + '\n';
    try { fs.writeFileSync(file, next, 'utf8'); } catch { /* 失败不阻塞主流程 */ }
    return backup;
}

async function macSysInterpCheck(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; mode: string; exeOk: boolean; aq: string }> {
    const hostDir = getHostDir();
    const appDir = path.join(hostDir, 'syspy', MAC_APP_NAME);
    let exe: string | null = null;
    if (target === 'node') exe = nodeFacadePath(portableRoot);
    else { try { exe = getComponentBin(portableRoot, 'python'); } catch { exe = null; } }
    const exeOk = !!exe && fs.existsSync(exe);
    const probe = (target === 'node') ? macEnsureProbeJs(hostDir) : macEnsureProbe(hostDir);
    let resolved = '';
    try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    const ours = !!resolved && normPath(resolved) === normPath(appDir) && fs.existsSync(appDir);
    let mode = 'none';
    if (ours) mode = 'ours';
    else if (resolved || (await macThirdPartyTool(target))) mode = 'other';
    return { ok: true, mode, exeOk, aq: resolved };
}

async function macSysInterpApply(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; code: string; via?: string }> {
    const hostDir = getHostDir();
    const enginesRoot = resolveEnginesRoot(portableRoot);
    let exe: string | null = null;
    if (target === 'node') exe = nodeFacadePath(portableRoot);
    else { try { exe = getComponentBin(portableRoot, 'python'); } catch { exe = null; } }
    if (!enginesRoot || !exe || !fs.existsSync(exe)) return { ok: false, code: target === 'node' ? 'no-node' : 'no-python' };
    if (target === 'node') {
        try { fs.chmodSync(exe, 0o755); } catch { /* ignore */ }
        // sidecar：门面目标 = 运行中的 Electron 本体（precise，胜过任何相对回退）
        try { fs.writeFileSync(path.join(path.dirname(exe), 'node-target.txt'), process.execPath + '\n', 'utf8'); } catch { /* 容错 */ }
    }
    // ★ 稳定路径：python 清单 bin_unix = bin/python3（相对符号链接）——引擎目录内升级（3.11→3.12）后依然有效；
    //   禁 realpath 钉死小版本（python3.11 硬化路径 → 引擎升级即断链 → 双击弹「已失效」提示）。

    const syspyDir = path.join(hostDir, 'syspy');
    const appDir = path.join(syspyDir, MAC_APP_NAME);
    const contentsDir = path.join(appDir, 'Contents');
    const runnerPath = path.join(contentsDir, 'Resources', 'run.sh');
    const plistPath = path.join(contentsDir, 'Info.plist');
    const probe = (target === 'node') ? macEnsureProbeJs(hostDir) : macEnsureProbe(hostDir);

    // 0. 首写快照（备份原值，供人工还原）——改动任何状态之前采集
    const bakPath = path.join(hostDir, 'Data', 'alphal', 'syspy-backup.json');
    let needBackup = false;
    if (target === 'python') { needBackup = !fs.existsSync(bakPath); }
    else {
        let bakObj: any = null;
        try { bakObj = JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch { bakObj = null; }
        needBackup = !(bakObj && bakObj.node);
    }
    let prevResolved = '';
    if (needBackup) { try { prevResolved = await jxaResolveApp(probe); } catch { /* ignore */ } }

    // 1. 重建 Launcher.app（幂等：每次全量重建；先停残留旧实例——旧脚本驻留内存）
    try { fs.mkdirSync(syspyDir, { recursive: true }); } catch { /* ignore */ }
    await runCmd('/usr/bin/pkill', ['-f', appDir + '/Contents/MacOS/droplet'], 5000);
    try { fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const asSrc = path.join(syspyDir, 'launcher.applescript');
    try { fs.writeFileSync(asSrc, macAppleScript(runnerPath), 'utf8'); } catch { return { ok: false, code: 'verify-failed' }; }
    const c1 = await runCmd('/usr/bin/osacompile', ['-o', appDir, asSrc], 60000);
    if (c1.code !== 0 || !fs.existsSync(path.join(contentsDir, 'MacOS', 'droplet'))) return { ok: false, code: 'verify-failed' };
    try {
        fs.writeFileSync(runnerPath, macRunner(enginesRoot), 'utf8');
        fs.chmodSync(runnerPath, 0o755);
    } catch { return { ok: false, code: 'verify-failed' }; }
    await macPlistPatch(plistPath);

    // 2. 注册 + 设默认 + 回读验证（失配自动重试一轮）
    if ((await runCmd(MAC_LSREGISTER, ['-f', appDir], 30000)).code !== 0) return { ok: false, code: 'verify-failed' };
    const uti = (target === 'node') ? 'com.netscape.javascript-source' : 'public.python-script';
    let setRc = await jxaSetHandler(uti, MAC_BUNDLE_ID);
    let resolved = '';
    try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    if (setRc !== 0 || normPath(resolved) !== normPath(appDir)) {
        await runCmd(MAC_LSREGISTER, ['-f', appDir], 30000);
        setRc = await jxaSetHandler(uti, MAC_BUNDLE_ID);
        try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    }
    const pass = normPath(resolved) === normPath(appDir);

    // 3. PATH（幂等；失败不阻塞）
    const profBackup = macAppendPath(enginesRoot);

    // 4. 备份落盘（python：首写快照；node：并入 node 分区不覆盖既有——与 Windows 同语义）
    if (needBackup) {
        try {
            fs.mkdirSync(path.dirname(bakPath), { recursive: true });
            if (target === 'python') {
                fs.writeFileSync(bakPath, JSON.stringify(Object.assign({
                    ts: new Date().toISOString(),
                    platform: 'darwin',
                    pythonExe: exe,
                    launcherApp: appDir,
                    prevHandlerPath: prevResolved,
                }, profBackup), null, 2), 'utf8');
            } else {
                let bakObj: any = null;
                try { bakObj = JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch { bakObj = null; }
                if (!bakObj || typeof bakObj !== 'object') bakObj = {};
                bakObj.node = { ts: new Date().toISOString(), nodeFacade: exe, prevHandlerPath: prevResolved };
                fs.writeFileSync(bakPath, JSON.stringify(bakObj, null, 2), 'utf8');
            }
        } catch { /* 备份失败不影响主流程 */ }
    }

    if (pass) return { ok: true, code: 'ok', via: 'mac' };
    console.warn('[syspy] mac verify failed:', 'target=' + target, 'setRc=' + setRc, 'resolved=' + resolved, 'appDir=' + appDir);
    return { ok: false, code: 'verify-failed' };
}

// ══════════════════════════════════════════════════════════════
// 解除（双平台）——纯清空一锤子买卖：只拆我们的手印，绝不还原旧值（白板化）。
//   win：UserChoice 删键（DACL 突破重试；退路=清 ProgId+Hash 让系统忽略）→ Classes 手印（指纹校验）
//        → 自有 ProgId 树（qqqide.*）→ FileExts 遗留 → PATH 去项 → HKLM 手印（UAC 兜底）；SHChangeNotify。
//   mac：LSHandler 偏好条目移除（实证：移除 + killall lsd 即回落系统下一处理器）+ PATH 块重建；
//        末位解除 → lsregister -u + 删 syspy 目录 + 清运行缓存；共享 Launcher.app 在另一目标仍接管时保留。
// ══════════════════════════════════════════════════════════════
function pyEnv(exe: string | null, ext: string, progId: string, flags: string): Record<string, string> {
    return {
        QQQIDE_SYSPY_EXE: exe || '',
        QQQIDE_SYSPY_DIR: exe ? path.dirname(exe) : '',
        QQQIDE_SYSPY_EXT: ext,
        QQQIDE_SYSPY_PROGID: progId,
        QQQIDE_SYSPY_FLAGS: flags,
        QQQIDE_SYSPY_APPNAME: 'Python (qd)',
        QQQIDE_SYSPY_ALLEXT: '.py;.pyw',
    };
}

/** PATH 块重建（登录 shell profile；只保留仍由我们接管的目标；全不归 → 整块删除）。 */
function macRewritePathBlock(enginesRoot: string, keepPy: boolean, keepNode: boolean): void {
    let sh = '/bin/zsh';
    try { const u = os.userInfo(); if (u && (u as any).shell) sh = (u as any).shell; } catch { /* ignore */ }
    const base = path.basename(sh).toLowerCase();
    let file = '';
    if (base.indexOf('zsh') >= 0) file = path.join(os.homedir(), '.zprofile');
    else if (base.indexOf('bash') >= 0) file = path.join(os.homedir(), '.bash_profile');
    if (!file) return;
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { return; }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let next = prev.replace(new RegExp(esc(MAC_PATH_BEGIN) + '[\\s\\S]*?' + esc(MAC_PATH_END) + '\\n?', 'g'), '');
    const lines: string[] = [];
    if (keepPy && enginesRoot) lines.push('export PATH="' + enginesRoot + '/python/bin:$PATH"');
    if (keepNode && enginesRoot) lines.push('export PATH="' + enginesRoot + '/node:$PATH"');
    if (lines.length) {
        if (next && !next.endsWith('\n')) next += '\n';
        next += MAC_PATH_BEGIN + '\n' + lines.join('\n') + '\n' + MAC_PATH_END + '\n';
    }
    if (next !== prev) { try { fs.writeFileSync(file, next, 'utf8'); } catch { /* ignore */ } }
}

/** 从 LSHandler 偏好（secure plist）移除指定 UTI 的全部条目（解除「默认程序」设定；倒序删保索引稳定）。 */
async function macRemoveLsHandler(uti: string): Promise<number> {
    const pl = path.join(os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
    if (!fs.existsSync(pl)) return 0;
    const r = await runCmd(MAC_PLUTIL, ['-convert', 'json', '-o', '-', pl], 15000);
    if (r.code !== 0) return 0;
    let arr: any[] = [];
    try {
        const obj = JSON.parse(r.out || '{}');
        if (obj && Array.isArray(obj.LSHandlers)) arr = obj.LSHandlers;
    } catch { return 0; }
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        const h = arr[i];
        if (h && h.LSHandlerContentType === uti) {
            const rm = await runCmd(MAC_PLUTIL, ['-remove', 'LSHandlers.' + i, pl], 15000);
            if (rm.code === 0) removed++;
        }
    }
    return removed;
}

async function macSysInterpRemove(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; code: string }> {
    const hostDir = getHostDir();
    const appDir = path.join(hostDir, 'syspy', MAC_APP_NAME);
    const enginesRoot = resolveEnginesRoot(portableRoot) || '';
    const uti = (target === 'node') ? 'com.netscape.javascript-source' : 'public.python-script';
    const probe = (target === 'node') ? macEnsureProbeJs(hostDir) : macEnsureProbe(hostDir);
    const otherProbe = (target === 'node') ? macEnsureProbe(hostDir) : macEnsureProbeJs(hostDir);

    // 1. 停掉驻留的 Launcher 实例
    await runCmd('/usr/bin/pkill', ['-f', appDir + '/Contents/MacOS/droplet'], 5000);

    // 2. 移除本目标的默认程序偏好条目（白板：不还原旧 handler）
    await macRemoveLsHandler(uti);

    // 3. 另一目标是否仍由我们接管？（决定共享 Launcher.app 的去留）
    let otherOurs = false;
    try {
        const r = await jxaResolveApp(otherProbe);
        otherOurs = !!r && normPath(r) === normPath(appDir) && fs.existsSync(appDir);
    } catch { /* ignore */ }

    // 4. 末位解除 → 全拆：注销 + 删整个 syspy 目录 + 清运行缓存（另一目标仍在 → 保留共享 Launcher.app）
    if (!otherOurs) {
        await runCmd(MAC_LSREGISTER, ['-u', appDir], 30000);
        try { fs.rmSync(path.join(hostDir, 'syspy'), { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(path.join(os.homedir(), 'Library', 'Caches', 'qqqide-syspy'), { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // 5. PATH 块重建（只保留仍归我们的目标；全不归 → 整块删除）
    macRewritePathBlock(enginesRoot, (target === 'python') ? false : otherOurs, (target === 'node') ? false : otherOurs);

    // 6. 刷 LS 缓存（lsd 内存映射表）+ 回读验证（失配重试一轮）
    await runCmd('/usr/bin/killall', ['cfprefsd'], 5000);
    await runCmd('/usr/bin/killall', ['lsd'], 5000);
    let resolved = '';
    try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    let pass = !(!!resolved && normPath(resolved) === normPath(appDir));
    if (!pass) {
        await new Promise((r2) => setTimeout(r2, 800));
        await runCmd('/usr/bin/killall', ['lsd'], 5000);
        try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
        pass = !(!!resolved && normPath(resolved) === normPath(appDir));
    }
    if (pass) return { ok: true, code: 'ok' };
    console.warn('[syspy] mac remove verify failed:', 'target=' + target, 'resolved=' + resolved, 'appDir=' + appDir);
    return { ok: false, code: 'verify-failed' };
}

// Windows 解除：python = .py + .pyw 两遍；node = .js + .mjs/.cjs 尽力而为
async function winSysInterpRemove(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; code: string; err?: string }> {
    if (target === 'node') {
        const facade = nodeFacadePath(portableRoot);
        const exeArg = (facade && fs.existsSync(facade)) ? facade : '';
        const env = (exeArg)
            ? nodeEnv(exeArg, '.js')
            : { QQQIDE_SYSPY_EXE: '', QQQIDE_SYSPY_DIR: '', QQQIDE_SYSPY_EXT: '.js', QQQIDE_SYSPY_PROGID: 'qqqide.NodeScript', QQQIDE_SYSPY_FLAGS: 'none', QQQIDE_SYSPY_MATCH: 'node', QQQIDE_SYSPY_WRAP: 'pause' };
        const r = await runPs(PS_HEAD + PS_BODY, { ...env, QQQIDE_SYSPY_MODE: 'remove' }, 300000);
        for (const ext of ['.mjs', '.cjs']) {
            try { await runPs(PS_HEAD + PS_BODY, { ...env, QQQIDE_SYSPY_EXT: ext, QQQIDE_SYSPY_MODE: 'remove' }, 300000); } catch { /* 尽力而为 */ }
        }
        if (r.fields.OK === '1') return { ok: true, code: 'ok' };
        console.warn('[syspy] node remove fail:', r.fields.CODE, (r.fields.ERR || '').slice(0, 300));
        return { ok: false, code: r.fields.CODE || 'remove-failed', err: (r.fields.ERR || '').slice(0, 300) };
    }
    let exe = '';
    try { exe = getComponentBin(portableRoot, 'python') || ''; } catch { exe = ''; }
    const r1 = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(exe, '.py', 'Python.File', '-i'), QQQIDE_SYSPY_MODE: 'remove' }, 300000);
    try {
        const pyw = exe ? path.join(path.dirname(exe), 'pythonw.exe') : '';
        if (pyw && fs.existsSync(pyw)) {
            await runPs(PS_HEAD + PS_BODY, { ...pyEnv(pyw, '.pyw', 'Python.NoConFile', 'none'), QQQIDE_SYSPY_MODE: 'remove' }, 300000);
        }
    } catch { /* 尽力而为 */ }
    if (r1.fields.OK === '1') return { ok: true, code: 'ok' };
    console.warn('[syspy] remove fail:', r1.fields.CODE, (r1.fields.ERR || '').slice(0, 300));
    return { ok: false, code: r1.fields.CODE || 'remove-failed', err: (r1.fields.ERR || '').slice(0, 300) };
}

// ── 失败遥测（2026-10-02）: check/apply/remove 结果采样 → syspy-report.json + ping 搭车诊断 ──
//   失败现场三件套: via（卡在哪级）/ aq（系统最终解析成什么）/ err（被吞掉的真报错）
function buildSyspyEnv(portableRoot: string, t: 'python' | 'node'): syspyReport.SyspyEnv {
    const env: syspyReport.SyspyEnv = {};
    try {
        const engRoot = resolveEnginesRoot(portableRoot);
        env.eng = engRoot && fs.existsSync(engRoot) ? 1 : 0;
        env.man = engRoot && fs.existsSync(path.join(engRoot, 'manifest.json')) ? 1 : 0;
        let exe: string | null = null;
        if (t === 'node') exe = nodeFacadePath(portableRoot);
        else { try { exe = getComponentBin(portableRoot, 'python'); } catch { exe = null; } }
        env.fac = exe && fs.existsSync(exe) ? 1 : 0;
        if (exe) env.facPath = exe;
    } catch { /* ignore */ }
    return env;
}

function noteSyspyOutcome(portableRoot: string, t: 'python' | 'node', op: 'check' | 'apply' | 'remove', res: any): void {
    try {
        if (!res || typeof res !== 'object') return;
        if (res.code === 'busy' || res.code === 'unsupported') return;
        let failCode = '';
        if (op === 'check') {
            if (!res.ok) failCode = String(res.code || 'check-failed');
            else if (res.exeOk === false) failCode = (t === 'node') ? 'no-node' : 'no-python';
        } else if (!res.ok) {
            failCode = String(res.code || (op === 'apply' ? 'verify-failed' : 'remove-failed'));
            if (t === 'node' && failCode === 'no-python') failCode = 'no-node';
        }
        const ok = !failCode;
        let viaStr = res.via ? String(res.via) : '';
        if (res.blocked) viaStr += '+blk';
        const evt: syspyReport.SyspyEvent = {
            tg: t, op, ok,
            code: failCode || String(res.code || res.mode || 'ok'),
            via: viaStr,
            err: res.err ? String(res.err) : '',
            aq: res.aq ? String(res.aq) : '',
            aqRc: (typeof res.aqRc === 'number' && Number.isFinite(res.aqRc)) ? res.aqRc : undefined,
            uc: res.uc ? String(res.uc) : '',
            exeOk: (typeof res.exeOk === 'boolean') ? res.exeOk : undefined,
            env: ok ? undefined : buildSyspyEnv(portableRoot, t),
        };
        try { syspyReport.recordSyspyEvent(path.join(portableRoot, 'Data'), evt); } catch { /* ignore */ }
        if (!ok) { try { notifySyspyFailed(); } catch { /* ignore */ } }
    } catch { /* 遥测绝不影响主流程 */ }
}

// ── IPC 注册 ──
let _inFlight = false;

export function registerSysPyIpc(portableRoot: string): void {
    const resolvePython = () => {
        try { return getComponentBin(portableRoot, 'python'); } catch { return null; }
    };

    ipcMain.handle('qqqide:syspy:check', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform === 'darwin') {
            if (_inFlight) return { ok: false, code: 'busy' };
            _inFlight = true;
            try { const out = await macSysInterpCheck(portableRoot, t); noteSyspyOutcome(portableRoot, t, 'check', out); return out; }
            catch (e: any) { console.warn('[syspy] mac check err:', (e && e.message) || e); return { ok: false, code: 'check-failed' }; }
            finally { _inFlight = false; }
        }
        if (process.platform !== 'win32') return { ok: true, mode: 'unsupported' };
        if (_inFlight) return { ok: false, code: 'busy' };
        _inFlight = true;
        try {
            const env = (t === 'node')
                ? nodeEnv(nodeFacadePath(portableRoot) || 'node.exe', '.js')
                : pyEnv(resolvePython(), '.py', 'Python.File', '-i');
            const r = await runPs(PS_HEAD + PS_BODY, { ...env, QQQIDE_SYSPY_MODE: 'check' }, 60000);
            if (!r.fields.CODE) {
                console.warn('[syspy] check raw:', r.raw.slice(0, 600));
                const out = { ok: false, code: 'check-failed', err: String(r.fields.ERR || r.raw || '').slice(0, 400) };
                noteSyspyOutcome(portableRoot, t, 'check', out);
                return out;
            }
            const out = {
                ok: true,
                mode: r.fields.CODE,                       // 'none' | 'other' | 'ours'
                exeOk: r.fields.EXE_OK === '1',
                aq: b64d(r.fields.AQ),
                aqRc: pi(r.fields.AQRC),
                ucProgId: b64d(r.fields.UC_PROGID),
            };
            noteSyspyOutcome(portableRoot, t, 'check', out);
            return out;
        } finally {
            _inFlight = false;
        }
    });

    ipcMain.handle('qqqide:syspy:apply', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform === 'darwin') {
            if (_inFlight) return { ok: false, code: 'busy' };
            _inFlight = true;
            try { const out = await macSysInterpApply(portableRoot, t); noteSyspyOutcome(portableRoot, t, 'apply', out); return out; }
            catch (e: any) { console.warn('[syspy] mac apply err:', (e && e.message) || e); return { ok: false, code: 'verify-failed' }; }
            finally { _inFlight = false; }
        }
        if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
        if (_inFlight) return { ok: false, code: 'busy' };
        _inFlight = true;
        try {
            if (t === 'node') {
                const out = await winNodeApply(portableRoot);
                noteSyspyOutcome(portableRoot, t, 'apply', out);
                return out;
            }
            const exe = resolvePython();
            if (!exe) {
                const out = { ok: false, code: 'no-python' };
                noteSyspyOutcome(portableRoot, t, 'apply', out);
                return out;
            }
            const r = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(exe, '.py', 'Python.File', '-i'), QQQIDE_SYSPY_MODE: 'apply' }, 300000);
            // ★ .pyw 第二遍（Python.NoConFile + pythonw，无控制台——与 python.org 官方语义一致）
            //   尽力而为：只记日志，不影响 .py 主结论
            let r2: PsResult | null = null;
            let pywExe = '';
            try {
                const cand = path.join(path.dirname(exe), 'pythonw.exe');
                if (fs.existsSync(cand)) {
                    pywExe = cand;
                    r2 = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(cand, '.pyw', 'Python.NoConFile', 'none'), QQQIDE_SYSPY_MODE: 'apply' }, 300000);
                    if (!r2.ok) console.warn('[syspy] pyw pass:', r2.fields.CODE, (r2.fields.ERR || '').slice(0, 200));
                }
            } catch (e: any) { console.warn('[syspy] pyw pass err:', (e && e.message) || e); }
            // 备份原值（首写快照，不覆盖已存在文件）——留作将来人工还原之据
            try {
                const bakPath = path.join(portableRoot, 'Data', 'alphal', 'syspy-backup.json');
                if (!fs.existsSync(bakPath)) {
                    fs.mkdirSync(path.dirname(bakPath), { recursive: true });
                    const bak: Record<string, any> = {
                        ts: new Date().toISOString(),
                        pythonExe: exe,
                        oldClassesCmd: b64d(r.fields.OLD_CLASSES_CMD),
                        oldPyDefault: b64d(r.fields.OLD_PY_DEFAULT),
                        oldUserChoiceProgId: b64d(r.fields.OLD_UC_PROGID),
                        oldUserChoiceHash: b64d(r.fields.OLD_UC_HASH),
                        oldPath: b64d(r.fields.OLD_PATH),
                    };
                    if (r2) {
                        bak.pyw = {
                            pythonwExe: pywExe,
                            oldClassesCmd: b64d(r2.fields.OLD_CLASSES_CMD),
                            oldPyDefault: b64d(r2.fields.OLD_PY_DEFAULT),
                            oldUserChoiceProgId: b64d(r2.fields.OLD_UC_PROGID),
                            oldUserChoiceHash: b64d(r2.fields.OLD_UC_HASH),
                        };
                    }
                    fs.writeFileSync(bakPath, JSON.stringify(bak, null, 2), 'utf8');
                }
            } catch { /* 备份失败不影响主流程 */ }
            const out = {
                ok: r.ok,
                code: r.ok ? 'ok' : (r.fields.CODE || 'verify-failed'),
                via: r.fields.VIA || '',
                blocked: r.fields.BLOCKED === '1',
                aq: b64d(r.fields.AQ),
                aqRc: pi(r.fields.AQRC),
                uc: b64d(r.fields.UC_PROGID2),
                err: (b64d(r.fields.PSERR) || r.fields.ERR || '').slice(0, 400),
            };
            if (!r.ok) console.warn('[syspy] apply fail:', r.fields.CODE, (r.fields.ERR || '').slice(0, 300));
            noteSyspyOutcome(portableRoot, t, 'apply', out);
            return out;
        } finally {
            _inFlight = false;
        }
    });

    // ★ picker / finalize（2026-10-02 引导流）——系统「用户选择保护」（Win11 25H2 .js）下
    //   picker = 直连式注册（选择窗口可见性铁律：cmd 包裹式会被系统从列表隐藏）+ 桌面样例文件
    //   + best-effort 拉起窗口；finalize = 归一包裹式（窗口不关）+ 清样例。幂等注册，不做 _inFlight
    ipcMain.handle('qqqide:syspy:picker', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
        try {
            if (t === 'node') {
                const facade = nodeFacadePath(portableRoot);
                if (!facade || !fs.existsSync(facade)) return { ok: false, code: 'no-node' };
                const r = await runPs(PS_HEAD + PS_BODY, { ...nodeEnv(facade, '.js'), QQQIDE_SYSPY_MODE: 'picker' }, 60000);
                return { ok: r.ok, code: r.ok ? 'ok' : (r.fields.CODE || 'picker-failed'), sample: b64d(r.fields.SAMPLE), launch: r.fields.LAUNCH || '', exePath: b64d(r.fields.EXE) };
            }
            const exe = resolvePython();
            if (!exe) return { ok: false, code: 'no-python' };
            const r = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(exe, '.py', 'Python.File', '-i'), QQQIDE_SYSPY_MODE: 'picker' }, 60000);
            return { ok: r.ok, code: r.ok ? 'ok' : (r.fields.CODE || 'picker-failed'), sample: b64d(r.fields.SAMPLE), launch: r.fields.LAUNCH || '', exePath: b64d(r.fields.EXE) };
        } catch (e: any) {
            console.warn('[syspy] picker err:', (e && e.message) || e);
            return { ok: false, code: 'picker-failed' };
        }
    });

    ipcMain.handle('qqqide:syspy:finalize', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
        try {
            if (t === 'node') {
                const facade = nodeFacadePath(portableRoot);
                if (!facade || !fs.existsSync(facade)) return { ok: false, code: 'no-node' };
                const r = await runPs(PS_HEAD + PS_BODY, { ...nodeEnv(facade, '.js'), QQQIDE_SYSPY_MODE: 'finalize' }, 60000);
                return { ok: r.ok, code: r.ok ? 'ok' : (r.fields.CODE || 'finalize-failed') };
            }
            const exe = resolvePython();
            if (!exe) return { ok: false, code: 'no-python' };
            const r = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(exe, '.py', 'Python.File', '-i'), QQQIDE_SYSPY_MODE: 'finalize' }, 60000);
            return { ok: r.ok, code: r.ok ? 'ok' : (r.fields.CODE || 'finalize-failed') };
        } catch (e: any) {
            console.warn('[syspy] finalize err:', (e && e.message) || e);
            return { ok: false, code: 'finalize-failed' };
        }
    });

    // ★ 解除（纯清空白板化；不还原旧值）
    ipcMain.handle('qqqide:syspy:remove', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform === 'darwin') {
            if (_inFlight) return { ok: false, code: 'busy' };
            _inFlight = true;
            try { const out = await macSysInterpRemove(portableRoot, t); noteSyspyOutcome(portableRoot, t, 'remove', out); return out; }
            catch (e: any) { console.warn('[syspy] mac remove err:', (e && e.message) || e); return { ok: false, code: 'remove-failed' }; }
            finally { _inFlight = false; }
        }
        if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
        if (_inFlight) return { ok: false, code: 'busy' };
        _inFlight = true;
        try { const out = await winSysInterpRemove(portableRoot, t); noteSyspyOutcome(portableRoot, t, 'remove', out); return out; }
        catch (e: any) { console.warn('[syspy] remove err:', (e && e.message) || e); return { ok: false, code: 'remove-failed' }; }
        finally { _inFlight = false; }
    });
}
