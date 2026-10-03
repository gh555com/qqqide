// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-fileassoc.ts — 系统默认播放器机器（播放器窗「Default」按钮后端）
//   语义（2026-10-02 q319 定案）: 一次点击 = 全量接管「一切媒体」默认打开方式——
//   不设白名单筛选；范围 = 播放器可播全谱（视频 20 + 音频 17 = 37 类，.ts 排除——
//   与 TypeScript 冲突）。接管层 = HKCU：ProgID(qqqide.player) + 每扩展 OpenWithProgids
//   + Capabilities/RegisteredApplications（系统「默认应用」可见）+ UserChoice hash 强写
//   （Deny-ACL 突破，ipc-syspy.ts 同源算法）。解除 = 纯清空白板化（不恢复旧值，与
//   系统解释器同语义）。验证 = 逐扩展 AssocQueryString 回调含 '--qqqide-play' 标记。
//   可达性: Windows（fa-ps.ts PS 机）+ macOS（fa-mac.ts LaunchServices 机）；结果恒上报
//   {total, taken}，系统保护拦截（Win11）如实报 blocked。
//   PS 脚本体 = shell/fa-ps.ts（纯文本，探针可整体导入做沙箱验证）。
// ============================================================================
import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import { runPs, b64d } from './ipc-syspy';
import { FA_PS } from './fa-ps';
import { faMacCheck, faMacApply, faMacRemove } from './fa-mac';

// 「一切媒体」= 播放器全谱扩展名（与 ipc-player._VIDEO_EXTS / _AUDIO_EXTS 同口径，
//   media-engine / roam 白名单三方一致；新增可播格式必须四处同改）
export const MEDIA_ASSOC_EXTS: string[] = [
    // 视频
    '.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.avi', '.wmv', '.flv', '.rmvb',
    '.rm', '.mpg', '.mpeg', '.m2ts', '.mts', '.3gp', '.vob', '.asf', '.f4v', '.ogm',
    // 音频
    '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.weba', '.wma',
    '.aiff', '.aif', '.ape', '.ac3', '.mka', '.amr', '.au',
];

const APP_NAME = 'qd (qqqide) 播放器';
const APP_DESC = 'qd (qqqide) 内置媒体播放器 — 视频/音频全格式（转码兜底）';

/** 打开命令 = 当前进程 exe（绿色包 = gh555.com\\joker.exe；dev = electron.exe + 项目根）。 */
function _command(): { cmd: string; icon: string } {
    const exe = process.execPath;
    const appArg = app.isPackaged ? '' : ('"' + app.getAppPath() + '" ');
    return {
        cmd: '"' + exe + '" ' + appArg + '--qqqide-play "%1"',
        icon: '"' + exe + '",0',
    };
}

function _faEnv(mode: string): Record<string, string> {
    const c = _command();
    return {
        QQQIDE_FA_MODE: mode,
        QQQIDE_FA_EXTS: MEDIA_ASSOC_EXTS.join(';'),
        QQQIDE_FA_CMD: c.cmd,
        QQQIDE_FA_ICON: c.icon,
        QQQIDE_FA_NAME: APP_NAME,
        QQQIDE_FA_DESC: APP_DESC,
    };
}

// ★ check 结果缓存（2026-10-02 v17 补）：每次播放器开窗角标刷新都跑一次 PS+Add-Type（冷启 ~1s）——
//   60s TTL 缓存（apply/remove 成功后立即失效——角标恒跟实态）；失败不缓存。
let _checkAt = 0;
let _checkVal: any = null;
const _CHECK_TTL = 60000;
function _invalidateCheckCache(): void { _checkVal = null; _checkAt = 0; }

// ★ 串行链（禁 busy 拒绝——页面自动角标刷新与用户点击可能并发；排队执行即可）
let _chain: Promise<any> = Promise.resolve();
function _serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = _chain.then(fn, fn);
    _chain = p.then(() => undefined, () => undefined);
    return p;
}

export function registerFileAssocIpc(portableRoot: string): void {
    void portableRoot;
    // ── macOS 实现（2026-10-03 补）：LaunchServices 机（fa-mac.ts——osascript JXA 直调框架）；
    //   语义与 Windows 版逐项对齐；双击链另一端 = main.ts 的 open-file 机器。──
    if (process.platform === 'darwin') {
        ipcMain.handle('qqqide:fileassoc:check', () => _serial(async () => {
            if (_checkVal && (Date.now() - _checkAt) < _CHECK_TTL) { return _checkVal; }   // 60s TTL（多窗角标零重复 osascript）
            const r = await faMacCheck(MEDIA_ASSOC_EXTS);
            if (!r.ok) { console.warn('[fileassoc] mac check err:', r.code, r.err || ''); return { ok: false, code: r.code || 'check-failed' }; }
            const out = { ok: true, total: r.total || 0, ours: r.taken || 0, exeOk: true };
            _checkVal = out; _checkAt = Date.now();
            return out;
        }));
        ipcMain.handle('qqqide:fileassoc:apply', () => _serial(async () => {
            const r = await faMacApply(MEDIA_ASSOC_EXTS);
            if (!r.ok) { console.warn('[fileassoc] mac apply fail:', r.code || '', r.err || '', (r.fails || []).slice(0, 6).join(' ')); }
            else { _invalidateCheckCache(); }   // 实态已变——下次 check 重算
            return { ok: !!r.ok, code: r.ok ? undefined : (r.code || 'apply-failed'), total: r.total || 0, taken: r.taken || 0, fails: r.fails || [], err: r.err };
        }));
        ipcMain.handle('qqqide:fileassoc:remove', () => _serial(async () => {
            const r = await faMacRemove(MEDIA_ASSOC_EXTS);
            if (r.ok) { _invalidateCheckCache(); }   // 实态已变——下次 check 重算
            return { ok: !!r.ok, code: r.ok ? undefined : (r.code || 'remove-failed'), cleaned: r.cleaned || 0 };
        }));
        ipcMain.handle('qqqide:fileassoc:settings', async () => {
            try { await shell.openExternal('x-apple.systempreferences:'); return { ok: true }; }
            catch (e: any) { return { ok: false, error: (e && e.message) || 'open-failed' }; }
        });
        return;
    }
    // 其余平台如实报 unsupported
    if (process.platform !== 'win32') {
        ipcMain.handle('qqqide:fileassoc:check', () => ({ ok: false, code: 'unsupported' }));
        ipcMain.handle('qqqide:fileassoc:apply', () => ({ ok: false, code: 'unsupported' }));
        ipcMain.handle('qqqide:fileassoc:remove', () => ({ ok: false, code: 'unsupported' }));
        ipcMain.handle('qqqide:fileassoc:settings', () => ({ ok: false, code: 'unsupported' }));
        return;
    }

    ipcMain.handle('qqqide:fileassoc:check', () => _serial(async () => {
        if (_checkVal && (Date.now() - _checkAt) < _CHECK_TTL) { return _checkVal; }   // 60s TTL（多窗角标零重复 PS 编译）
        try {
            const r = await runPs(FA_PS, _faEnv('check'), 60000, 'QQQIDE_FA_');
            if (r.fields.OK !== '1') { return { ok: false, code: r.fields.CODE || 'check-failed' }; }
            const out = {
                ok: true,
                total: parseInt(r.fields.TOTAL || '0', 10) || 0,
                ours: parseInt(r.fields.OURS || '0', 10) || 0,
                exeOk: fs.existsSync(process.execPath),
            };
            _checkVal = out; _checkAt = Date.now();
            return out;
        } catch (e: any) {
            console.warn('[fileassoc] check err:', (e && e.message) || e);
            return { ok: false, code: 'check-failed' };
        }
    }));

    ipcMain.handle('qqqide:fileassoc:apply', () => _serial(async () => {
        try {
            const r = await runPs(FA_PS, _faEnv('apply'), 240000, 'QQQIDE_FA_');
            const total = parseInt(r.fields.TOTAL || '0', 10) || 0;
            const taken = parseInt(r.fields.TAKEN || '0', 10) || 0;
            const fails = b64d(r.fields.FAILS).split(';').filter((s) => s);
            const out = {
                ok: r.fields.OK === '1',
                code: r.fields.CODE || 'apply-failed',
                total, taken, fails,
                err: (b64d(r.fields.PSERR) || '').slice(0, 300),
            };
            if (!out.ok) { console.warn('[fileassoc] apply fail:', out.code, out.err); }
            else { _invalidateCheckCache(); }   // 实态已变——下次 check 重算
            return out;
        } catch (e: any) {
            console.warn('[fileassoc] apply err:', (e && e.message) || e);
            return { ok: false, code: 'apply-failed' };
        }
    }));

    ipcMain.handle('qqqide:fileassoc:remove', () => _serial(async () => {
        try {
            const r = await runPs(FA_PS, _faEnv('remove'), 240000, 'QQQIDE_FA_');
            if (r.fields.OK === '1') { _invalidateCheckCache(); }   // 实态已变——下次 check 重算
            return {
                ok: r.fields.OK === '1',
                code: r.fields.CODE || 'remove-failed',
                cleaned: parseInt(r.fields.CLEANED || '0', 10) || 0,
            };
        } catch (e: any) {
            console.warn('[fileassoc] remove err:', (e && e.message) || e);
            return { ok: false, code: 'remove-failed' };
        }
    }));

    // 系统「默认应用」设置页（部分拦截场景的手动兜底通道）
    ipcMain.handle('qqqide:fileassoc:settings', async () => {
        try { await shell.openExternal('ms-settings:defaultapps'); return { ok: true }; }
        catch (e: any) { return { ok: false, error: (e && e.message) || 'open-failed' }; }
    });
}
