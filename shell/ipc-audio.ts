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
    ipcMain.handle('qqqide:audio:play', async (_e, file: string, opts?: any) => {
        try {
            const f = String(file || '');
            if (_sfxSkipped(f)) { return { ok: true, skipped: true }; }
            const abs = resolveSfxPath(appRoot, f);
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
        // ★ 音效开关同步（渲染层 audio-volume.js 唯一推送方，覆盖式幂等）
        if (String(action || '') === 'setSfxDisabled') {
            const pats = params && Array.isArray(params.patterns) ? params.patterns : [];
            _sfxDisabledPatterns = pats.map((p: any) => String(p)).filter(Boolean);
            return { ok: true };
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
        const f = String(file || '');
        if (_sfxSkipped(f)) { return; }
        const abs = resolveSfxPath(appRoot, f);
        if (!abs) { return; }
        engine.invoke('play_sfx', { path: abs, volume }, 5000).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}
