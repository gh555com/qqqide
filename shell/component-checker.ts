// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// component-checker.ts — 运行时组件管理器（唯一真理源: engines/manifest.json）
// 启动时读 manifest → 检查 rank0 组件 → 缺了自动下载 → 服务器改 install_to 客户端自动重组目录
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawnSync, execSync } from 'child_process';

// ── 类型 ──
interface SrcEntry { url: string; kind: 'zip' | 'tar.gz' | 'binary' | 'sfx7z'; }

interface ComponentDef {
    bundled?: boolean;
    bg_download?: boolean;
    kind?: string;            // 'files' = 纯文件组件（无二进制，如 vc_runtime）
    install_to: string;
    _platform_subdir?: boolean;
    bin_win?: string | null;
    bin_unix?: string | null;
    verify_args: string[];
    version: string;
    srcs: Record<string, SrcEntry[]>;
    files?: string[];         // kind='files' 时校验的文件清单
    prune?: string[];         // 解压后删除的相对路径清单（零能力项，如文档）
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

// ── engines 根目录解析（packaged 模式下 engines 在 resources/app/ 下，dev 模式下在项目根） ──

function _enginesRoot(portableRoot: string): string {
    const resApp = path.join(portableRoot, 'resources', 'app');
    return fs.existsSync(path.join(resApp, 'engines')) ? resApp : portableRoot;
}

// ── 清单加载（缓存） ──

function _loadManifest(portableRoot: string): Manifest | null {
    if (_manifestCache && _manifestRoot === portableRoot) return _manifestCache;
    const engRoot = _enginesRoot(portableRoot);
    const p = path.join(engRoot, 'engines', 'manifest.json');
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
    const engRoot = _enginesRoot(portableRoot);
    const baseDir = def.install_to ? path.join(engRoot, 'engines', def.install_to) : path.join(engRoot, 'engines');
    // Platform subdirectory (ffmpeg etc.)
    if (def._platform_subdir) {
        const platDir = path.join(baseDir, _platformKey());
        const platBin = path.join(platDir, br);
        if (fs.existsSync(platBin)) return platBin;
    }
    return path.join(baseDir, br);
}

// kind='files' 纯文件组件：目录 + 清单校验
function _componentDir(portableRoot: string, def: ComponentDef): string | null {
    const engRoot = _enginesRoot(portableRoot);
    const baseDir = def.install_to ? path.join(engRoot, 'engines', def.install_to) : path.join(engRoot, 'engines');
    if (def._platform_subdir) return path.join(baseDir, _platformKey());
    return baseDir;
}

function _filesOk(dir: string, def: ComponentDef): boolean {
    if (!dir || !fs.existsSync(dir)) return false;
    const files = def.files || [];
    for (const f of files) {
        if (!fs.existsSync(path.join(dir, f))) return false;
    }
    return true;
}

// ── 下载冷却 ──

function _dlLogPath(portableRoot: string): string {
    const engRoot = _enginesRoot(portableRoot);
    return path.join(engRoot, 'engines', '.downloads.json');
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

    const engRoot = _enginesRoot(portableRoot);
    const versPath = path.join(engRoot, 'engines', '.versions.json');
    const versions = _readJson<VersionsFile>(versPath, {});

    _checkAll(portableRoot, manifest, versions, versPath).then(() => {
        // After rank0 check completes, verify integrity of bundled components
        return _verifyAllBundled(portableRoot, manifest, versions, versPath);
    }).then(() => {
        // After bundled verification, kick off background download of rank1 bg_download components
        _checkRank1BgDownload(portableRoot, manifest, versions, versPath);
    }).catch(e => {
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
        // bundled: 绿色包自带。若本地不存在 → fall through 到下载逻辑（旧客户端升级场景）
        if (def.bundled) {
            const ok = def.kind === 'files'
                ? _filesOk(_componentDir(portableRoot, def) || '', def)
                : ((_binPath(portableRoot, def) || '') !== '' && fs.existsSync(_binPath(portableRoot, def)!));
            if (ok) continue;
            console.log('[components] ' + name + ': bundled but missing on disk, downloading...');
        }

        try {
            await _ensureOne(portableRoot, name, def, pk, versions, manifest, versPath);
        } catch (e: any) {
            console.log('[components] ' + name + ': FAILED — ' + (e.message || e));
        }
    }
    _writeJson(versPath, versions);
}

// ── Rank1 后台静默下载 — bg_download 组件在 IDE 跑时自动拉取，不阻塞启动 ──

async function _checkRank1BgDownload(
    portableRoot: string,
    manifest: Manifest,
    versions: VersionsFile,
    versPath: string,
): Promise<void> {
    const pk = _platformKey();
    for (const name of manifest.rank1) {
        const def = manifest.components[name];
        if (!def || !def.bg_download) continue;

        // Already present and verified → skip
        const bp = _binPath(portableRoot, def);
        const verifyArgs = def.verify_args || ['--version'];
        if (bp && fs.existsSync(bp) && _cmdOk(bp, verifyArgs)) {
            // Update version record
            const effectiveInstallTo = def._platform_subdir ? (def.install_to + '/' + pk) : def.install_to;
            versions[name] = { version: def.version, install_to: effectiveInstallTo, verified_at: Date.now() };
            _writeJson(versPath, versions);
            continue;
        }

        console.log('[components] ' + name + ': bg_download starting...');
        try {
            await _ensureOne(portableRoot, name, def, pk, versions, manifest, versPath);
            _writeJson(versPath, versions);
            // 重新验证 — 防止假成功（_ensureOne 内部冷却跳过/下载失败会被吞掉）
            const bp2 = _binPath(portableRoot, def);
            if (bp2 && fs.existsSync(bp2) && _cmdOk(bp2, verifyArgs)) {
                console.log('[components] ' + name + ': bg_download complete ✓');
            } else {
                console.log('[components] ' + name + ': bg_download FAILED — binary still missing');
            }
        } catch (e: any) {
            console.log('[components] ' + name + ': bg_download FAILED — ' + (e.message || e));
        }
    }
}

// ── 启动完整性校验 — 自愈能力为唯一真理（2026-07-30 §65）──

interface VerifyResult { status: 'ok' | 'degraded' | 'broken'; detail: string; }

/** 校验单个组件完整性。两级: ① self_heal(能自愈吗?) → ok/degraded ② smoke(能跑吗?) → broken */
function _verifyComponent(portableRoot: string, name: string, def: ComponentDef): VerifyResult {
    if (def.kind === 'files') {
        const dir = _componentDir(portableRoot, def);
        if (!dir || !_filesOk(dir, def)) return { status: 'broken', detail: 'files missing' };
        return { status: 'ok', detail: '' };
    }
    const bp = _binPath(portableRoot, def);
    if (!bp || !fs.existsSync(bp)) return { status: 'broken', detail: 'binary missing' };

    const verify = (def as any).verify;
    const smokeArgs = verify?.smoke || def.verify_args;
    if (!_cmdOk(bp, smokeArgs)) return { status: 'broken', detail: 'smoke test failed' };

    // self_heal: 若定义了 → 必须通过。未定义 → smoke 即充分（单二进制组件）。
    const selfHealArgs = verify?.self_heal;
    if (selfHealArgs && !_cmdOk(bp, selfHealArgs)) {
        return { status: 'degraded', detail: 'self-heal failed — binary runs but cannot self-repair' };
    }
    return { status: 'ok', detail: '' };
}

/** 启动时对全部 bundled 组件跑两级校验。degraded → 组件特定修复。broken → CDN 恢复。 */
async function _verifyAllBundled(
    portableRoot: string,
    manifest: Manifest,
    versions: VersionsFile,
    versPath: string,
): Promise<void> {
    const pk = _platformKey();
    for (const name of manifest.rank0) {
        const def = manifest.components[name];
        if (!def?.bundled) continue;

        const r = _verifyComponent(portableRoot, name, def);
        if (r.status === 'ok') continue;

        console.log(`[components] ${name}: INTEGRITY ${r.status.toUpperCase()} — ${r.detail}`);

        if (r.status === 'degraded') {
            // 尝试组件特定修复（如 Python → _bootstrapPip）
            const repaired = await _tryRepairDegraded(portableRoot, name, def);
            if (repaired) {
                console.log(`[components] ${name}: self-healed ✓`);
                continue;
            }
            console.log(`[components] ${name}: repair failed, falling back to CDN recovery`);
        }

        // degraded 修复失败 或 broken → 清除版本记录 + 冷却记录 → 触发 CDN 灾备下载（broken 恢复不受冷却限制）
        delete versions[name];
        const dlLog = _readJson<DownloadLog>(_dlLogPath(portableRoot), {});
        if (dlLog[name]) { dlLog[name].last_success = 0; dlLog[name].last_fail = 0; }
        _writeJson(_dlLogPath(portableRoot), dlLog);

        try {
            await _ensureOne(portableRoot, name, def, pk, versions, manifest, versPath);
            _writeJson(versPath, versions);
            // 重新验证 — 防止假成功（_ensureOne 内部冷却跳过/下载失败会被吞掉）
            const r2 = _verifyComponent(portableRoot, name, def);
            if (r2.status === 'ok') {
                console.log(`[components] ${name}: CDN recovery ✓`);
            } else {
                console.log(`[components] ${name}: CDN recovery FAILED — ${r2.detail}`);
            }
        } catch (e: any) {
            console.log(`[components] ${name}: CDN recovery FAILED — ${e.message || e}`);
        }
    }
}

/** 组件特定修复 — 仅对 degraded 态（二进制能跑但自愈能力受损）。返回 true=修复成功。 */
async function _tryRepairDegraded(portableRoot: string, name: string, def: ComponentDef): Promise<boolean> {
    if (name === 'python') {
        const bp = _binPath(portableRoot, def);
        if (!bp) return false;
        const targetDir = path.dirname(bp);
        try {
            await _bootstrapPip(targetDir);
            // 重检 self_heal
            const verify = (def as any).verify;
            if (verify?.self_heal && _cmdOk(bp, verify.self_heal)) return true;
        } catch { /* fall through */ }
        // pip 修复失败 → 尝试 .pyd 补全
        try { await _ensureCorePyds(targetDir); await _bootstrapPip(targetDir); } catch {}
        const verify = (def as any).verify;
        return !!(verify?.self_heal && _cmdOk(bp, verify.self_heal));
    }
    // 其他组件暂无特定修复逻辑
    return false;
}

// ── 单个组件保证 ──

async function _ensureOne(
    portableRoot: string,
    name: string,
    def: ComponentDef,
    pk: string,
    versions: VersionsFile,
    manifest: Manifest,
    versPath: string,
): Promise<void> {
    const engRoot = _enginesRoot(portableRoot);
    const enginesDir = path.join(engRoot, 'engines');
    const isFiles = def.kind === 'files';
    const binRel = _binRel(def);
    if (!binRel && !isFiles) { console.log('[components] ' + name + ': no binary for this platform'); return; }

    const targetDir = def.install_to ? path.join(enginesDir, def.install_to) : enginesDir;
    // Platform subdirectory for multi-platform components (ffmpeg etc.)
    const finalDir = def._platform_subdir ? path.join(targetDir, pk) : targetDir;
    const effectiveInstallTo = def._platform_subdir ? (def.install_to + '/' + pk) : def.install_to;
    const binPath = isFiles ? path.join(finalDir, '__files__') : path.join(finalDir, binRel);
    const verifyArgs = def.verify_args || ['--version'];

    // ── ① 当前位置已安装且验证通过 → 检查版本升级 + 目录迁移 ──
    if (isFiles ? _filesOk(finalDir, def) : (fs.existsSync(binPath) && _cmdOk(binPath, verifyArgs))) {
        const old = versions[name];

        // 版本升级 → 删除旧版，触发重新下载
        if (old && old.version !== def.version) {
            console.log('[components] ' + name + ': version changed ' + old.version + ' → ' + def.version + ', reinstalling');
            // For platform-subdir components, only wipe the platform-specific subdir
            _safeRmDir(def._platform_subdir ? finalDir : targetDir);
            // fall through to download
        } else if (old && old.install_to !== effectiveInstallTo) {
            // 目录迁移
            console.log('[components] ' + name + ': migrating from ' + old.install_to + ' → ' + effectiveInstallTo);
            _migrateDir(enginesDir, old.install_to, effectiveInstallTo, name);
            versions[name] = { version: def.version, install_to: effectiveInstallTo, verified_at: Date.now() };
            return;
        } else {
            versions[name] = { version: def.version, install_to: effectiveInstallTo, verified_at: Date.now() };
            return;
        }
    }

    // ── ② 旧位置有有效安装 → 迁移到新位置 ──
    const oldRec = versions[name];
    if (oldRec && oldRec.install_to !== effectiveInstallTo && oldRec.install_to) {
        const oldDir = path.join(enginesDir, oldRec.install_to);
        const oldBin = path.join(oldDir, binRel);
        if (fs.existsSync(oldBin) && _cmdOk(oldBin, verifyArgs)) {
            _migrateDir(enginesDir, oldRec.install_to, effectiveInstallTo, name);
            versions[name] = { version: def.version, install_to: effectiveInstallTo, verified_at: Date.now() };
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
    let srcs = (def.srcs[pk] || []) as SrcEntry[];
    // Win7/8 (6.1/6.2/6.3): git ≥2.47 已放弃 Win7/8 → 用 Win7 兼容版 2.46.0
    if (name === 'git' && process.platform === 'win32' && /^6\.[123]\./.test(os.release())) {
        const w7 = (def as any).win7_srcs?.[pk] as SrcEntry[] | undefined;
        if (w7 && w7.length) srcs = w7;
    }
    if (srcs.length === 0) {
        console.log('[components] ' + name + ': no sources for platform ' + pk);
        return;
    }

    let ok = false;
    for (const src of srcs) {
        try {
            await _downloadAndInstall(name, def, src, finalDir, binPath, verifyArgs, portableRoot);
            ok = true;
            break;
        } catch (e: any) {
            console.log('[components] ' + name + ' src failed: ' + (e.message || e));
        }
    }

    if (ok) {
        _recordDlSuccess(portableRoot, name);
        versions[name] = { version: def.version, install_to: effectiveInstallTo, verified_at: Date.now() };
        _writeJson(versPath, versions); // 立即持久化
    } else {
        _recordDlFail(portableRoot, name);
        console.log('[components] ' + name + ': all sources exhausted');
    }
}

// ── 下载 + 安装 ──

async function _downloadAndInstall(
    name: string,
    def: ComponentDef,
    src: SrcEntry,
    targetDir: string,
    binPath: string,
    verifyArgs: string[],
    portableRoot: string,
): Promise<void> {
    const dlDir = path.join(portableRoot, 'Data');
    const ext = src.kind === 'tar.gz' ? '.tar.gz' : (src.kind === 'sfx7z' ? '.7z.exe' : '.zip');
    const dlFile = path.join(dlDir, '_dl_' + name + ext);

    console.log('[components] ' + name + ': downloading ' + src.url.slice(0, 80) + ' ...');
    await _download(src.url, dlFile, src.kind === 'sfx7z' ? 300000 : 120000);

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
                `powershell -NoProfile -Command "try { Expand-Archive -Path '${dlFile}' -DestinationPath '${targetDir}' -Force } catch { Add-Type -AssemblyName System.IO.Compression.FileSystem; try { [System.IO.Compression.ZipFile]::ExtractToDirectory('${dlFile}','${targetDir}') } catch { $sh=New-Object -ComObject Shell.Application; $z=$sh.NameSpace('${dlFile}'); $d=$sh.NameSpace('${targetDir}'); $n=$z.Items().Count; $d.CopyHere($z.Items(), 16); $t0=Get-Date; while(((Get-Date)-$t0).TotalSeconds -lt 90){ if($d.Items().Count -ge $n){ Start-Sleep -Milliseconds 500; break }; Start-Sleep -Milliseconds 500 } } }"`,
                { windowsHide: true, timeout: 120000 }
            );
        } else {
            execSync(`unzip -o "${dlFile}" -d "${targetDir}"`, { timeout: 120000 });
        }
    } else if (src.kind === 'tar.gz') {
        execSync(`tar -xzf "${dlFile}" -C "${targetDir}" --strip-components=1`, { timeout: 120000 });
    } else if (src.kind === 'sfx7z') {
        // 7-Zip SFX 自解压制品（Git for Windows PortableGit 官方 .7z.exe）: -y 静默 + -o 目标目录。
        // execSync 等待 GUI 子系统进程退出（cmd 不等待，Node spawnSync 会），退出码非 0 即抛错。
        execSync(`"${dlFile}" -y -o"${targetDir}"`, { windowsHide: true, timeout: 300000 });
    }

    try { fs.unlinkSync(dlFile); } catch {}

    // manifest prune 清单（2026-08-11 git portable）: 解压后删除零能力项（文档等），磁盘税从 408MB → ~387MB
    const pruneList = (def as any).prune as string[] | undefined;
    if (pruneList && pruneList.length) {
        for (const rel of pruneList) {
            const p = path.join(targetDir, rel);
            _safeRmDir(p);
            console.log('[components] ' + name + ': pruned ' + rel);
        }
    }

    // Python 特殊处理（解压后、验证前）
    if (name === 'python' && process.platform === 'win32') {
        _patchPythonPth(targetDir);
        // 自动补全缺失的 .pyd 文件（从官方 embed 包提取）
        _ensureCorePyds(targetDir).catch(e => {
            console.log('[components] python pyd supplement: ' + (e.message || e));
        });
        // 自动引导 pip（若 CDN zip 未预装）
        _bootstrapPip(targetDir).catch(e => {
            console.log('[components] python pip bootstrap: ' + (e.message || e));
        });
    }

    // 验证 — 用二进制路径直接调，不走 shell
    if (def.kind === 'files') {
        if (!_filesOk(targetDir, def)) throw new Error('Files missing after extract: ' + targetDir);
    } else {
        if (!fs.existsSync(binPath)) {
            const found = _findBinParent(targetDir, path.basename(binPath));
            if (found) {
                _flattenDir(found, targetDir);
            }
        }

        if (!fs.existsSync(binPath)) throw new Error('Binary not found after extract: ' + binPath);
        if (!_cmdOk(binPath, verifyArgs)) throw new Error('Verification failed');
    }

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

// 自动补全缺失的 .pyd 文件（从官方 Python embed 包提取，解决 pip 依赖 pyexpat 等问题）
const PYTHON_EMBED_URL = 'https://www.python.org/ftp/python/3.8.10/python-3.8.10-embed-amd64.zip';
async function _ensureCorePyds(targetDir: string): Promise<void> {
    // 快速检查：pyexpat.pyd 是 pip 运行的必要条件
    if (fs.existsSync(path.join(targetDir, 'pyexpat.pyd'))) return;

    console.log('[components] python: missing core .pyd files, supplementing from python.org...');
    const https = require('https') as typeof import('https');
    const dlDir = path.join(targetDir, '..', '_pyd_supplement');
    const zipPath = path.join(dlDir, 'embed.zip');
    try { fs.mkdirSync(dlDir, { recursive: true }); } catch {}

    // 下载官方 embed zip
    await new Promise<void>((resolve, reject) => {
        const u = new URL(PYTHON_EMBED_URL);
        const req = https.get({
            hostname: u.hostname, port: 443, path: u.pathname,
            timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0 (qqqide)' },
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const file = fs.createWriteStream(zipPath);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', (e: any) => reject(e));
            res.on('error', (e: any) => reject(e));
        });
        req.on('error', (e: any) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    // 用 Python 的 zipfile 模块提取 .pyd 文件
    const pyBin = path.join(targetDir, 'python.exe');
    const extractScript = `
import zipfile, os
z = zipfile.ZipFile(r'${zipPath.replace(/\\/g, '\\\\')}')
present = set(os.listdir(r'${targetDir.replace(/\\/g, '\\\\')}'))
missing = [n for n in z.namelist() if n.endswith(('.pyd', '.dll')) and n not in present]
for n in missing:
    z.extract(n, r'${targetDir.replace(/\\/g, '\\\\')}')
    print('+', n)
print('done:', len(missing))
`.trim();
    try {
        const r = execSync(`"${pyBin}" -c "${extractScript.replace(/"/g, '\\"')}"`,
            { encoding: 'utf8', timeout: 30000, windowsHide: true });
        console.log('[components] python pyd supplement: ' + r.trim().split('\n').pop());
    } catch (e: any) {
        console.log('[components] python pyd supplement failed: ' + (e.message || e));
    }

    // 清理
    try { fs.unlinkSync(zipPath); fs.rmdirSync(dlDir); } catch {}
}

// 自动引导 pip（若 CDN zip 未预装 pip）
async function _bootstrapPip(targetDir: string): Promise<void> {
    const pyBin = path.join(targetDir, 'python.exe');

    // 先检查 pip 是否已可用
    try {
        execSync(`"${pyBin}" -m pip --version`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
        return; // pip 已存在
    } catch { /* pip 未安装 */ }

    console.log('[components] python: pip not found, bootstrapping...');

    // 下载 get-pip.py
    const getPipPath = path.join(targetDir, 'get-pip.py');
    const https = require('https') as typeof import('https');
    await new Promise<void>((resolve, reject) => {
        const u = new URL('https://bootstrap.pypa.io/pip/3.8/get-pip.py');
        const req = https.get({
            hostname: u.hostname, port: 443, path: u.pathname,
            timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0 (qqqide)' },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d: string) => { data += d; });
            res.on('end', () => {
                if (res.statusCode === 200 && data.length > 1000) {
                    try { fs.writeFileSync(getPipPath, data, 'utf8'); resolve(); }
                    catch (e: any) { reject(e); }
                } else { reject(new Error('HTTP ' + res.statusCode)); }
            });
            res.on('error', (e: any) => reject(e));
        });
        req.on('error', (e: any) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    // 运行 get-pip.py
    try {
        execSync(`"${pyBin}" "${getPipPath}" --no-warn-script-location`,
            { encoding: 'utf8', timeout: 120000, windowsHide: true });
        console.log('[components] python pip bootstrapped ✓');
    } catch (e: any) {
        console.log('[components] python pip bootstrap failed: ' + (e.message || e));
        // 失败不阻塞 — Python 仍可正常使用（只是没 pip）
    } finally {
        try { fs.unlinkSync(getPipPath); } catch {}
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
