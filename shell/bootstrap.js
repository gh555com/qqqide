// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// bootstrap.js — 壳层唯一入口（预加载器）
//
// ★ 2026-08-10 重构：壳层冷更通道（staging/shell-out-next swap）已整体删除。
//   壳层更新 100% 随 r 整包原子交换（C 启动器托管），版本 = versions.json 清单编号。
//   本文件职责仅剩：动态 require('./main.js') + 加载失败兜底弹窗。
// ============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

function bootstrapLog(msg) {
    try {
        var rootDir = path.dirname(process.execPath);
        var logDir = path.join(rootDir, 'Data', 'Logs');
        fs.mkdirSync(logDir, { recursive: true });
        var ts = new Date().toISOString();
        fs.appendFileSync(path.join(logDir, 'bootstrap.log'), '[' + ts + '] ' + msg + '\n');
    } catch (e) {
        // bootstrap must never fail — swallow all errors
    }
}

(function main() {
    bootstrapLog('bootstrap starting');
    try {
        require('./main.js');
    } catch (e) {
        bootstrapLog('bootstrap: FATAL — failed to load main.js: ' + (e.message || e));
        console.error('qqq-shell bootstrap: failed to load main.js', e);
        try {
            var electron = require('electron');
            electron.app.whenReady().then(function () {
                var dialog = electron.dialog;
                dialog.showErrorBox('qqq-shell — Startup Error',
                    'Failed to start. The shell code may be corrupted.\n\n' +
                    'Please re-download the portable package from gh555.com.\n\n' +
                    'Error: ' + (e.message || String(e)));
                electron.app.quit();
            });
        } catch (e2) {
            process.exit(1);
        }
    }
})();
