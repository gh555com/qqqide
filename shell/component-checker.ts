// ============================================================================
// component-checker.ts — 运行时组件管理器（唯一真理源: engines/manifest.json）
// 启动时读 manifest → 检查 rank0 组件 → 缺了自动下载 → 服务器改 install_to 客户端自动重组目录
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { spawnSync, execSync } from 'child_process';

// ── 类型 ──
interface SrcEntry { url: string; kind: 'zip' | 'tar.gz' | 'binary'; }

interface ComponentDef {
    bundled?: boolean;
    install_to: string;
    bin_win?: string | null;
    bin_unix?: string | null;
    verify_args: string[];
    version: string;
    srcs: Record<string, SrcEntry[]>;
}

interface Manifest {
    _version: number;
    rank0: string[];
    rank1: string[];
    download_cooldown_ms: number;
    components: Record<string, ComponentDef>;
}

interface VersionRecord {
    version: string;
    install_to: string;
    verified_at: number;
}

type VersionsFile = Record<string, VersionRecord>;
interface DownloadLog { [name: string]: { last_fail: number; last_success: number; }; }

// ── 缓存（避免每次查询重读磁盘） ──
let _manifestCache: Manifest | null = null;
let _manifestRoot: string = '';

// ── 工具 ──

function _platformKey(): string {
    const p = process.platform;
    const a = process.arch === 'x64' ? 'x64' : 'arm64';
    if (p === 'win32') return 'win32-x64';
    if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    return 'linux-x64';
}

function _readJson<T>(filePath: string, fallback: T): T {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function _writeJson(filePath: string, obj: any): void {
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { }
    const tmp = filePath + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); } catch { return; }
    try { fs.renameSync(tmp, filePath); } catch { try { fs.unlinkSync(tmp); } catch {} }
}

function _cmdOk(binPath: string, args: string[]): boolean {
    try {
        const r = spawnSync(binPath, args, {
            encoding: 'utf8',
            timeout: 15000,
            windowsHide: true,
        });
        return r.status === 0;
    } catch { return false; }
}

// ── 清单加载（缓存） ──

function _loadManifest(portableRoot: string): Manifest | null {
    if (_manifestCache && _manifestRoot === portableRoot) return _manifestCache;
    const p = path.join(portableRoot, 'engines', 'manifest.json');
    const m = _readJson<Manifest | null>(p, null);
    if (m && m._version >= 3) {
        _manifestCache = m;
        _manifestRoot = portableRoot;
        return m;
    }
    return null;
}

function _getDef(portableRoot: string, name: string): ComponentDef | null {
    const m = _loadManifest(portableRoot);
    return m?.components[name] || null;
}

function _binRel(def: ComponentDef): string | null {
    return process.platform === 'win32' ? (def.bin_win || def.bin_unix || null) : (def.bin_unix || def.bin_win || null);
}

function _binPath(portableRoot: string, def: ComponentDef): string | null {
    const br = _binRel(def);
    if (!br) return null;
    const dir = def.install_to ? path.join(portableRoot, 'engines', def.install_to) : path.join(portableRoot, 'engines');
    return path.join(dir, br);
}

// ── 下载冷却 ──

function _dlLogPath(portableRoot: string): string {
    return path.join(portableRoot, 'engines', '.downloads.json');
}

function _isInCooldown(portableRoot: string, name: string, manifest: Manifest): boolean {
    const cooldownMs = manifest.download_cooldown_ms || 300000;
    const log = _readJson<DownloadLog>(_dlLogPath(portableRoot), {});
    const entry = log[name];
    if (!entry) return false;
    const now = Date.now();
    // 上次成功 → 永不再下载（除非版本升级或 install_to 变更）
    if (entry.last_success > 0) return true;
    // 上次失败在冷却期内 → 跳过
    if (entry.last_fail > 0 && (now - entry.last_fail) < cooldownMs) return true;
    return false;
}

function _recordDlSuccess(portableRoot: string, name: string): void {
    const log = _readJson<DownloadLog>(_dlLogPath(portableRoot), {});
    log[name] = { last_fail: 0, last_success: Date.now() };
    _writeJson(_dlLogPath(portableRoot), log);
}

function _recordDlFail(portableRoot: string, name: string): void {
    const log = _readJson<DownloadLog>(_dlLogPath(portableRoot), {});
    if (!log[name]) log[name] = { last_fail: 0, last_success: 0 };
    log[name].last_fail = Date.now();
    _writeJson(_dlLogPath(portableRoot), log);
}

// ── 主入口 ──

let _checked = false;

export function checkRank0Components(portableRoot: string): void {
    if (_checked) return;
    _checked = true;

    const manifest = _loadManifest(portableRoot);
    if (!manifest) {
        console.log('[components] manifest.json not found or invalid, skipping');
        return;
    }

    const versPath = path.join(portableRoot, 'engines', '.versions.json');
    const versions = _readJson<VersionsFile>(versPath, {});

    _checkAll(portableRoot, manifest, versions, versPath).catch(e => {
        console.log('[components] rank0 check error:', e.message || e);
    });
}

async function _checkAll(
    portableRoot: string,
    manifest: Manifest,
    versions: VersionsFile,
    versPath: string,
): Promise<void> {
    const pk = _platformKey();
    for (const name of manifest.rank0) {
        const def = manifest.components[name];
        if (!def) { console.log('[components] ' + name + ': not in manifest'); continue; }
        if (def.bundled) continue;

        try {
            await _ensureOne(portableRoot, name, def, pk, versions, manifest);
        } catch (e: any) {
            console.log('[components] ' + name + ': FAILED — ' + (e.message || e));
        }
    }
    _writeJson(versPath, versions);
}

// ── 单个组件保证 ──

async function _ensureOne(
    portableRoot: string,
    name: string,
    def: ComponentDef,
    pk: string,
    versions: VersionsFile,
    manifest: Manifest,
): Promise<void> {
    const enginesDir = path.join(portableRoot, 'engines');
    const binRel = _binRel(def);
    if (!binRel) { console.log('[components] ' + name + ': no binary for this platform'); return; }

    const targetDir = def.install_to ? path.join(enginesDir, def.install_to) : enginesDir;
    const binPath = path.join(targetDir, binRel);
    const verifyArgs = def.verify_args || ['--version'];

    // ── ① 当前位置已安装且验证通过 → 检查版本升级 + 目录迁移 ──
    if (fs.existsSync(binPath) && _cmdOk(binPath, verifyArgs)) {
        const old = versions[name];

        // 版本升级 → 删除旧版，触发重新下载
        if (old && old.version !== def.version) {
            console.log('[components] ' + name + ': version changed ' + old.version + ' → ' + def.version + ', reinstalling');
            _safeRmDir(targetDir);
            // fall through to download
        } else if (old && old.install_to !== def.install_to) {
            // 目录迁移
            console.log('[components] ' + name + ': migrating from ' + old.install_to + ' → ' + def.install_to);
            _migrateDir(enginesDir, old.install_to, def.install_to, name);
            versions[name] = { version: def.version, install_to: def.install_to, verified_at: Date.now() };
            return;
        } else {
            versions[name] = { version: def.version, install_to: def.install_to, verified_at: Date.now() };
            return;
        }
    }

    // ── ② 旧位置有有效安装 → 迁移到新位置 ──
    const oldRec = versions[name];
    if (oldRec && oldRec.install_to !== def.install_to && oldRec.install_to) {
        const oldDir = path.join(enginesDir, oldRec.install_to);
        const oldBin = path.join(oldDir, binRel);
        if (fs.existsSync(oldBin) && _cmdOk(oldBin, verifyArgs)) {
            _migrateDir(enginesDir, oldRec.install_to, def.install_to, name);
            versions[name] = { version: def.version, install_to: def.install_to, verified_at: Date.now() };
            return;
        }
    }

    // ── ③ 冷却检查 ──
    if (_isInCooldown(portableRoot, name, manifest)) {
        console.log('[components] ' + name + ': in cooldown, skipping download');
        return;
    }

    // ── ④ 下载 ──
    console.log('[components] ' + name + ': not found, downloading...');
    const srcs = (def.srcs[pk] || []) as SrcEntry[];
    if (srcs.length === 0) {
        console.log('[components] ' + name + ': no sources for platform ' + pk);
        return;
    }

    let ok = false;
    for (const src of srcs) {
        try {
            await _downloadAndInstall(name, src, targetDir, binPath, verifyArgs, portableRoot);
            ok = true;
            break;
        } catch (e: any) {
            console.log('[components] ' + name + ' src failed: ' + (e.message || e));
        }
    }

    if (ok) {
        _recordDlSuccess(portableRoot, name);
        versions[name] = { version: def.version, install_to: def.install_to, verified_at: Date.now() };
        _writeJson(versPath, versions); // 立即持久化
    } else {
        _recordDlFail(portableRoot, name);
        console.log('[components] ' + name + ': all sources exhausted');
    }
}

// ── 下载 + 安装 ──

async function _downloadAndInstall(
    name: string,
    src: SrcEntry,
    targetDir: string,
    binPath: string,
    verifyArgs: string[],
    portableRoot: string,
): Promise<void> {
    const dlDir = path.join(portableRoot, 'Data');
    const ext = src.kind === 'tar.gz' ? '.tar.gz' : '.zip';
    const dlFile = path.join(dlDir, '_dl_' + name + ext);

    console.log('[components] ' + name + ': downloading ' + src.url.slice(0, 80) + ' ...');
    await _download(src.url, dlFile, 120000);

    const size = fs.statSync(dlFile).size;
    if (size < 512) throw new Error('Download too small: ' + size + ' bytes');
    console.log('[components] ' + name + ': ' + (size / 1024 / 1024).toFixed(1) + 'MB');

    // 清空目标目录（全新安装）
    _safeRmDir(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });

    // 解压
    if (src.kind === 'binary') {
        const dest = path.join(targetDir, path.basename(binPath));
        fs.copyFileSync(dlFile, dest);
        try { fs.chmodSync(dest, 0o755); } catch {}
    } else if (src.kind === 'zip') {
        if (process.platform === 'win32') {
            execSync(
                `powershell -NoProfile -Command "Expand-Archive -Path '${dlFile}' -DestinationPath '${targetDir}' -Force"`,
                { windowsHide: true, timeout: 120000 }
            );
        } else {
            execSync(`unzip -o "${dlFile}" -d "${targetDir}"`, { timeout: 120000 });
        }
    } else if (src.kind === 'tar.gz') {
        execSync(`tar -xzf "${dlFile}" -C "${targetDir}" --strip-components=1`, { timeout: 120000 });
    }

    try { fs.unlinkSync(dlFile); } catch {}

    // Python 特殊处理
    if (name === 'python' && process.platform === 'win32') {
        _patchPythonPth(targetDir);
    }

    // 验证 — 用二进制路径直接调，不走 shell
    if (!fs.existsSync(binPath)) {
        const found = _findBinParent(targetDir, path.basename(binPath));
        if (found) {
            _flattenDir(found, targetDir);
        }
    }

    if (!fs.existsSync(binPath)) throw new Error('Binary not found after extract: ' + binPath);
    if (!_cmdOk(binPath, verifyArgs)) throw new Error('Verification failed');

    console.log('[components] ' + name + ': installed ✓');
}

// ── 辅助 ──

function _patchPythonPth(dir: string): void {
    try {
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('._pth'))) {
            const p = path.join(dir, f);
            let c = fs.readFileSync(p, 'utf8');
            c = c.replace('#import site', 'import site');
            const lines = c.split('\n').filter(Boolean);
            if (!lines.some(l => l.trim() === './Lib' || l.trim() === 'Lib')) lines.unshift('./Lib');
            if (!lines.some(l => l.includes('site-packages'))) lines.push('./site-packages');
            fs.writeFileSync(p, lines.join('\n'), 'utf8');
        }
    } catch (e: any) {
        console.log('[components] python _pth patch warning: ' + (e.message || e));
    }
}

function _findBinParent(dir: string, binName: string): string | null {
    function _walk(d: string, depth: number): string | null {
        if (depth > 4) return null;
        try {
            for (const f of fs.readdirSync(d)) {
                const fp = path.join(d, f);
                if (f === binName) return d;
                try { if (fs.statSync(fp).isDirectory()) { const r = _walk(fp, depth + 1); if (r) return r; } } catch {}
            }
        } catch {}
        return null;
    }
    return _walk(dir, 0);
}

function _flattenDir(srcDir: string, dstDir: string): void {
    const tmpDir = dstDir + '_flatten_tmp';
    fs.renameSync(srcDir, tmpDir);
    for (const f of fs.readdirSync(tmpDir)) {
        const sp = path.join(tmpDir, f);
        const dp = path.join(dstDir, f);
        try { fs.renameSync(sp, dp); } catch { try { fs.rmSync(dp, { recursive: true, force: true }); fs.renameSync(sp, dp); } catch {} }
    }
    fs.rmdirSync(tmpDir);
}

/** 目录迁移: oldSub → newSub。新目录已存在→合并（移入不移出），旧删。 */
function _migrateDir(enginesDir: string, oldSub: string, newSub: string, name: string): void {
    if (!oldSub || oldSub === newSub) return;
    const oldDir = path.join(enginesDir, oldSub);
    const newDir = path.join(enginesDir, newSub);
    if (!fs.existsSync(oldDir)) return;
    try {
        fs.mkdirSync(path.dirname(newDir), { recursive: true });
        if (fs.existsSync(newDir)) {
            // 目标已存在 → 旧目录移入新目录下（保留旧内容，避免覆盖）
            for (const f of fs.readdirSync(oldDir)) {
                const sp = path.join(oldDir, f);
                const dp = path.join(newDir, f);
                try { fs.renameSync(sp, dp); } catch { /* 冲突跳过 */ }
            }
            // 清理空的旧目录
            try { if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir); } catch {}
        } else {
            fs.renameSync(oldDir, newDir);
        }
        console.log('[components] ' + name + ': migrated ' + oldSub + ' → ' + newSub);
    } catch (e: any) {
        console.log('[components] ' + name + ': migration failed: ' + (e.message || e));
    }
}

function _safeRmDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── 下载（Node.js https 流式，零依赖，带重定向） ──

function _download(url: string, dest: string, timeoutMs: number): Promise<void> {
    const https = require('https') as typeof import('https');
    const http = require('http') as typeof import('http');

    const doReq = (targetUrl: string, redirects: number): Promise<void> => {
        if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
        return new Promise<void>((resolve, reject) => {
            const u = new URL(targetUrl);
            const transport = u.protocol === 'http:' ? http : https;
            const req = transport.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + u.search,
                timeout: timeoutMs,
                headers: { 'User-Agent': 'Mozilla/5.0 (qqqide)' },
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
                    res.resume();
                    const loc = res.headers.location || '';
                    doReq(new URL(loc, targetUrl).href, redirects + 1).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error('HTTP ' + res.statusCode));
                }
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', (e: any) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
                res.on('error', (e: any) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
            });
            req.on('error', (e: any) => reject(new Error(e.message || 'network')));
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    };
    return doReq(url, 0);
}

// ── 公开查询 ──

/** 获取组件的可执行文件路径（从缓存 manifest 读，不反复读磁盘）。未安装返回 null。 */
export function getComponentBin(portableRoot: string, name: string): string | null {
    const def = _getDef(portableRoot, name);
    if (!def) return null;
    const bp = _binPath(portableRoot, def);
    return bp && fs.existsSync(bp) ? bp : null;
}

/** 获取组件的安装目录（从缓存 manifest 读）。 */
export function getComponentDir(portableRoot: string, name: string): string | null {
    const def = _getDef(portableRoot, name);
    if (!def) return null;
    const bp = _binPath(portableRoot, def);
    return bp && fs.existsSync(bp) ? path.dirname(bp) : null;
}
