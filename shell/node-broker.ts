// ============================================================================
// node-broker.ts — DevTools 窗口改名，纯 Node.js（koffi → Win32 API）
// 零子进程，零 Python 依赖。仅 Windows。
// 失败自动回退到 py-broker（由调用方处理）。
// ============================================================================

import { BrowserWindow } from 'electron';

// ══════════════════════════════════════════════════════════════
// koffi 懒加载：用到了才 require，缺了不报错，调用方回退
// ══════════════════════════════════════════════════════════════

let _koffiModule: any = null;
let _koffiTried = false;

function _tryLoadKoffi(): any {
    if (_koffiTried) return _koffiModule;
    _koffiTried = true;
    try {
        _koffiModule = require('koffi');
        console.log('[node-broker] koffi loaded — Win32 FFI available');
        return _koffiModule;
    } catch {
        console.log('[node-broker] koffi not installed. Run: npm install koffi');
        return null;
    }
}

/** 是否可用（Windows + koffi 已装） */
export function isNodeBrokerAvailable(): boolean {
    return process.platform === 'win32' && _tryLoadKoffi() !== null;
}

// ══════════════════════════════════════════════════════════════
// Win32 API 包装（koffi FFI）
// ══════════════════════════════════════════════════════════════

/**
 * Windows 下直接调 user32.dll 改 detached DevTools 窗口标题。
 * 逻辑与 py-broker.py _win_rename_devtools 完全对齐：
 *   EnumWindows → 匹配 "Developer Tools" 前缀 → SetWindowTextW
 */
export function renameDevToolsViaNodeBroker(mainWin: BrowserWindow, projName: string): boolean {
    if (process.platform !== 'win32') return false;

    const koffi = _tryLoadKoffi();
    if (!koffi) return false;

    // 获取主窗口 HWND
    let mainHwnd = 0;
    try {
        const hbuf = mainWin.getNativeWindowHandle();
        if (hbuf && hbuf.length >= 4) {
            mainHwnd = hbuf.length === 8
                ? Number(hbuf.readBigUInt64LE(0))
                : hbuf.readUInt32LE(0);
        }
    } catch { /* ignore */ }
    if (!mainHwnd) {
        console.log('[node-broker] Cannot get main window HWND');
        return false;
    }

    const title = '\u300c\U0001f527\u300d' + projName;
    const GW_OWNER = 4;

    try {
        const user32 = koffi.load('user32.dll');

        const EnumWindows = user32.func('int EnumWindows(void *lpEnumFunc, int64 lParam)');
        const GetWindowTextW = user32.func('int GetWindowTextW(void *hwnd, _Out_ char16 *buf, int nMaxCount)');
        const GetWindow = user32.func('void *GetWindow(void *hwnd, int uCmd)');
        const SetWindowTextW = user32.func('int SetWindowTextW(void *hwnd, const char16 *lpString)');

        const foundHwnds: number[] = [];

        // EnumWindows 回调 — 每个顶层窗口被调用一次
        const cb = koffi.callback('int (void *hwnd, int64 lp)', (hwnd: any, _lp: number) => {
            try {
                const buf = Buffer.alloc(1024);
                GetWindowTextW(hwnd, buf, 512);
                const winTitle = buf.toString('utf16le').replace(/\0[\s\S]*$/, '');
                if (!winTitle) return 1; // continue

                if (winTitle.startsWith('Developer Tools') || winTitle.startsWith('\u300c\ud83d\udd27\u300d')) {
                    let owner: any = null;
                    try { owner = GetWindow(hwnd, GW_OWNER); } catch { /* ignore */ }

                    if (owner && Number(owner) !== 0 && Number(owner) === mainHwnd) {
                        foundHwnds.push(Number(hwnd));
                    } else if (!owner || Number(owner) === 0) {
                        // detached DevTools 可能 owner=0，仍然收集
                        foundHwnds.push(Number(hwnd));
                    }
                }
            } catch { /* callback 内部异常不中断枚举 */ }
            return 1; // continue
        });

        EnumWindows(cb, 0);

        if (foundHwnds.length === 0) {
            console.log('[node-broker] No DevTools window found for HWND=' + mainHwnd);
            return false;
        }

        let renamed = 0;
        for (const hwnd of foundHwnds) {
            const ret = SetWindowTextW(koffi.as(hwnd, 'void *'), title);
            if (ret) renamed++;
        }

        if (renamed > 0) {
            console.log('[node-broker] OK: renamed=' + renamed + ' title=' + title);
            return true;
        }
        console.log('[node-broker] SetWindowTextW failed for all ' + foundHwnds.length + ' windows');
        return false;
    } catch (e: any) {
        console.log('[node-broker] ERROR:', e.message || e);
        return false;
    }
}
