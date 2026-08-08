// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-audio.ts
// Registers qqqide:audio:* IPC handlers routing to the AudioEngine singleton
// (miniaudio_v16.py AudioHub via engines/miniaudio_bridge.py).
//
// Path resolution for play():
//   - "yz:<name>"        → <webapp>/assets/yz/<name>   (Roam sfx semantic)
//   - "assets/<rel>"     → <webapp>/<file>             (payload static assets)
//   - absolute path      → used as-is
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AudioEngine } from './audio-engine';

function resolveWebappDir(appRoot: string): string | null {
    const candidates = [
        path.join(appRoot, 'Data', 'webapp'),       // packaged (gh555.com/Data/webapp)
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
    ipcMain.handle('qqqide:audio:play', async (_e, file: string, opts?: any) => {
        try {
            const abs = resolveSfxPath(appRoot, String(file || ''));
            if (!abs) { return { ok: false, error: 'empty_path' }; }
            const vol = opts && typeof opts.volume === 'number' ? opts.volume : 1.0;
            return await engine.invoke('play_sfx', { path: abs, volume: vol }, 5000);
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

    // ★ 预热 yz 音效解码缓存 — 首响零延迟 (性能优化, 启动 3s 后静默执行)
    setTimeout(() => {
        try {
            const wd = resolveWebappDir(appRoot);
            if (!wd) { return; }
            const yzDir = path.join(wd, 'assets', 'yz');
            if (!fs.existsSync(yzDir)) { return; }
            const files = fs.readdirSync(yzDir).filter(f => /\.mp3$/i.test(f));
            if (files.length === 0) { return; }
            engine.invoke('prime_sfx', { paths: files.map(f => path.join(yzDir, f)) }, 10000).catch(() => { /* ignore */ });
        } catch { /* ignore */ }
    }, 3000);
}

/** 主进程直呼音效（编队召唤成功反馈等）— 与 qqqide:audio:play 同一路径解析 */
export function playSfxFile(engine: AudioEngine, appRoot: string, file: string, volume = 1.0): void {
    try {
        const abs = resolveSfxPath(appRoot, String(file || ''));
        if (!abs) { return; }
        engine.invoke('play_sfx', { path: abs, volume }, 5000).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}
