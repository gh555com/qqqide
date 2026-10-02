// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-audio.ts
// Registers qqqide:audio:* IPC handlers routing to the AudioEngine singleton
// (miniaudio_v16.py AudioHub via engines/miniaudio_bridge.py).
//
// Path resolution for play():
//   - "yz:<name>"        → <webapp>/assets/yz/<name>   (roam sfx semantic)
//   - "assets/<rel>"     → <webapp>/<file>             (payload static assets)
//   - absolute path      → used as-is
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AudioEngine } from './audio-engine';
import { getDataDir } from './portable-paths';

function resolveWebappDir(appRoot: string): string | null {
    const candidates = [
        path.join(getDataDir(), 'webapp'),          // packaged (mac: qqqide-data/Data · win: gh555.com/Data)
        path.join(appRoot, 'server-app'),           // dev (project root)
        path.join(appRoot, 'resources', 'app', 'webapp'),
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(path.join(p, 'index.html'))) { return p; }
        } catch { /* ignore */ }
    }
    return null;
}

// ★ 音效开关闸门（2026-09-04）：渲染层经 audio:invoke('setSfxDisabled',{patterns}) 推送文件子串黑名单
//   命中即静默跳过（play 返回 {ok:true} 防调用方 .then/.catch 链异常）——所有播放点（含 iframe
//   Roam/kmd/QA、主进程编队召回 playSfxFile）统一被拦，播放点零侵入。主进程初始空 = 全响，
//   渲染层 audio-volume.js 加载后自动推送当前用户设置（默认全开 → 空集）。
let _sfxDisabledPatterns: string[] = [];
function _sfxSkipped(file: string): boolean {
    if (!file || _sfxDisabledPatterns.length === 0) { return false; }
    return _sfxDisabledPatterns.some(p => p && file.includes(p));
}

function resolveSfxPath(appRoot: string, file: string): string {
    if (!file) { return ''; }
    if (file.startsWith('yz:')) {
        const wd = resolveWebappDir(appRoot);
        if (wd) { return path.join(wd, 'assets', 'yz', file.slice(3)); }
        return file;
    }
    if (file.startsWith('assets/') || file.startsWith('assets\\') || file.startsWith('../assets/')) {
        const wd = resolveWebappDir(appRoot);
        const rel = file.replace(/^\.\.\//, ''); // '../assets/...' → 'assets/...' (ai-panel iframe 相对路径)
        if (wd) { return path.join(wd, rel); }
        return file;
    }
    return file; // absolute path as-is
}

export function registerAudioIpc(engine: AudioEngine, appRoot: string): void {
    // ★ 懒启配套预热（2026-10-02）：yz 音效解码缓存预热——禁为「预热」主动拉起引擎
    //   （旧实现 = 3s 定时 invoke → 隐式 spawn → 整会话常驻）；仅引擎已存活时预热 + 首次真实播放后补一次。
    let _yzPrimed = false;
    // ★ 懒启配套（2026-10-02）：引擎未存活时收到的电台状态缓存（引擎拉起的首个真实播放前重放）
    let _pendingRadio: any = null;
    const _primeYzSfx = (): void => {
        if (_yzPrimed) { return; }
        try {
            const wd = resolveWebappDir(appRoot);
            if (!wd) { return; }
            const yzDir = path.join(wd, 'assets', 'yz');
            if (!fs.existsSync(yzDir)) { return; }
            const files = fs.readdirSync(yzDir).filter(f => /\.mp3$/i.test(f));
            if (files.length === 0) { return; }
            _yzPrimed = true;
            engine.invoke('prime_sfx', { paths: files.map(f => path.join(yzDir, f)) }, 10000).catch(() => { /* ignore */ });
        } catch { /* ignore */ }
    };

    // ★ 引擎主动事件广播（Savor 2026-09-19）: audio_state_changed / audio_finished → 全窗口
    engine.onEvent((evt: any) => {
        try {
            for (const w of BrowserWindow.getAllWindows()) {
                if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
                    try { w.webContents.send('qqqide:audio:event', evt); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    });

    ipcMain.handle('qqqide:audio:play', async (_e, file: string, opts?: any) => {
        try {
            const f = String(file || '');
            if (_sfxSkipped(f)) { return { ok: true, skipped: true }; }
            const abs = resolveSfxPath(appRoot, f);
            if (!abs) { return { ok: false, error: 'empty_path' }; }
            const vol = opts && typeof opts.volume === 'number' ? opts.volume : 1.0;
            const _r = await engine.invoke('play_sfx', { path: abs, volume: vol }, 5000);
            _primeYzSfx();   // 首次真实播放后补预热（懒启配套；否则永不预热）
            return _r;
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });

    ipcMain.handle('qqqide:audio:stop', async (_e, scope?: string) => {
        try {
            const s = String(scope || 'all');
            if (s === 'music') { return await engine.invoke('stop_music', {}, 5000); }
            if (s === 'clipboard') { return await engine.invoke('stop_clipboard', {}, 5000); }
            return await engine.invoke('stop_all', {}, 5000);
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });

    ipcMain.handle('qqqide:audio:invoke', async (_e, action: string, params?: any) => {
        // ★ 音效开关同步（渲染层 audio-volume.js 唯一推送方，覆盖式幂等）
        if (String(action || '') === 'setSfxDisabled') {
            const pats = params && Array.isArray(params.patterns) ? params.patterns : [];
            _sfxDisabledPatterns = pats.map((p: any) => String(p)).filter(Boolean);
            return { ok: true };
        }
        // ★ 懒启铁律（2026-10-02 实锤：savor 启动同步 get_audio_state → 隐式 spawn → 懒启被击穿）：
        //   只读/状态类调用禁拉起引擎——未存活即如实返回（引擎在首个真实播放时自然拉起，状态由事件自然对齐）。
        
        if (!engine.isAlive()) {
            if (String(action || '') === 'get_audio_state') { return { ok: true, playing: false, alive: false }; }
            if (String(action || '') === 'set_radio_status') { _pendingRadio = { ...(params || {}) }; return { ok: true, deferred: true }; }
        }
        // ★ Savor 音乐：路径经统一解析（'assets/savor/x.mp3' → webapp 绝对路径，同 play 语义）
        // ★ 电台状态重放（懒启配套）：引擎即将拉起 → 先补送先前缓存的电台状态（防首播误走本地）
        if (_pendingRadio) {
            try { await engine.invoke('set_radio_status', _pendingRadio, 5000); } catch { /* ignore */ }
            _pendingRadio = null;
        }
        if (String(action || '') === 'play_music') {
            try {
                const p: any = { ...(params || {}) };
                if (p.path) { p.path = resolveSfxPath(appRoot, String(p.path)); }
                if (p.intro) { p.intro = resolveSfxPath(appRoot, String(p.intro)); }
                const _r2 = await engine.invoke('play_music', p, 15000);
                _primeYzSfx();   // 懒启配套
                return _r2;
            } catch (err: any) {
                return { ok: false, error: String((err && err.message) || err) };
            }
        }
        try {
            return await engine.invoke(String(action || ''), params || {}, 10000);
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });

    ipcMain.handle('qqqide:audio:isAlive', () => engine.isAlive());

    ipcMain.handle('qqqide:audio:prime', async (_e, files: any) => {
        try {
            const list = Array.isArray(files) ? files : [];
            const abs = list.map((f: any) => resolveSfxPath(appRoot, String(f || ''))).filter(Boolean);
            if (abs.length === 0) { return { ok: false, error: 'empty_paths' }; }
            return await engine.invoke('prime_sfx', { paths: abs }, 10000);
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });

    // ★ 旧「启动 3s 预热」已废（懒启配套）——仅在引擎已存活时预热；否则等首个真实播放后补。
    setTimeout(() => {
        try { if (engine.isAlive()) { _primeYzSfx(); } } catch { /* ignore */ }
    }, 3000);
}

/** 主进程直呼音效（编队召唤成功反馈等）— 与 qqqide:audio:play 同一路径解析 */
export function playSfxFile(engine: AudioEngine, appRoot: string, file: string, volume = 1.0): void {
    try {
        const f = String(file || '');
        if (_sfxSkipped(f)) { return; }
        const abs = resolveSfxPath(appRoot, f);
        if (!abs) { return; }
        engine.invoke('play_sfx', { path: abs, volume }, 5000).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}
