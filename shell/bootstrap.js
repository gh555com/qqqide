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
        // ★ mac .app bundle（2026-09-16）：禁写 bundle 内——写数据破代码签名封条
        //   （TCC csreq 失配 → 已授权限全失效）。日志重定向到 .app 同级
        //   qqqide-data/Data/Logs（与 portable-paths.getDataDir 同源）。
        var norm = rootDir.replace(/\\/g, '/');
        var idx = norm.indexOf('.app/Contents/MacOS');
        if (idx >= 0) {
            rootDir = path.join(path.dirname(norm.slice(0, idx)), 'qqqide-data');
        }
        var logDir = path.join(rootDir, 'Data', 'Logs');
        fs.mkdirSync(logDir, { recursive: true });
        var ts = new Date().toISOString();
        var logFile = path.join(logDir, 'bootstrap.log');
        // ★ 轮转（2026-09-24）: 单文件 ≤256KB，超限滚为 .old（单代）——曾无上限 append
        try {
            if (fs.statSync(logFile).size > 256 * 1024) {
                try { fs.unlinkSync(logFile + '.old'); } catch (e1) { }
                try { fs.renameSync(logFile, logFile + '.old'); } catch (e2) { }
            }
        } catch (e0) { /* 文件不存在 */ }
        fs.appendFileSync(logFile, '[' + ts + '] ' + msg + '\n');
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
