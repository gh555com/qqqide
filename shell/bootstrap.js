// ============================================================================
// bootstrap.js — Pre-loader: checks for pending shell-out updates BEFORE
// loading main.js. Runs on every app start, takes <5ms if no update pending.
//
// This is PLAIN JS to ensure require('./main.js') is a DYNAMIC call to a
// separate file — essential for hot-update: main.js must be independently
// replaceable without re-bundling bootstrap.
//
// Flow:
//   1. Check if cache/staging/shell-out-next/ exists
//   2. If yes → atomic swap with shell-out/ → log → proceed
//   3. If no  → proceed directly
//   4. Always: require('./main.js') to run the real app
// ============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var BOOTSTRAP_VERSION = '1.0.0';

function bootstrapLog(msg) {
    try {
        var logDir = path.join(process.cwd(), 'cache');
        fs.mkdirSync(logDir, { recursive: true });
        var ts = new Date().toISOString();
        fs.appendFileSync(path.join(logDir, 'bootstrap.log'), '[' + ts + '] ' + msg + '\n');
    } catch (e) {
        // bootstrap must never fail — swallow all errors
    }
}

function applyPendingUpdate() {
    try {
        var appDir = __dirname; // shell-out/
        var stagingDir = path.join(appDir, '..', 'cache', 'staging', 'shell-out-next');

        if (!fs.existsSync(stagingDir)) {
            return false;
        }

        // Verify staging contains at least main.js (sanity check)
        var stagingMain = path.join(stagingDir, 'main.js');
        if (!fs.existsSync(stagingMain)) {
            bootstrapLog('bootstrap: staging missing main.js, clearing');
            fs.rmSync(stagingDir, { recursive: true, force: true });
            return false;
        }

        bootstrapLog('bootstrap: applying pending shell-out update...');

        // Backup current shell-out
        var backupDir = path.join(appDir, '..', 'cache', 'staging', 'shell-out-old');
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (e) {}
        try {
            fs.cpSync(appDir, backupDir, { recursive: true });
            bootstrapLog('bootstrap: backed up current shell-out');
        } catch (e) {
            bootstrapLog('bootstrap: backup failed: ' + (e.message || e));
            // Continue anyway — staging is verified
        }

        // Atomic swap: clear appDir, copy staging in
        var entries = fs.readdirSync(appDir);
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry === 'bootstrap.js') continue; // don't delete ourselves
            var p = path.join(appDir, entry);
            try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
        }

        var stagingEntries = fs.readdirSync(stagingDir);
        for (var j = 0; j < stagingEntries.length; j++) {
            var entry2 = stagingEntries[j];
            var src = path.join(stagingDir, entry2);
            var dst = path.join(appDir, entry2);
            try { fs.cpSync(src, dst, { recursive: true }); } catch (e) {}
        }

        // Cleanup staging
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) {}
        bootstrapLog('bootstrap: shell-out updated successfully');

        return true;
    } catch (e) {
        bootstrapLog('bootstrap: update failed: ' + (e.message || e));
        return false;
    }
}

// ---- Entry ----
(function main() {
    bootstrapLog('bootstrap v' + BOOTSTRAP_VERSION + ' starting');
    var updated = applyPendingUpdate();
    if (updated) {
        bootstrapLog('bootstrap: update applied, loading main.js');
    } else {
        bootstrapLog('bootstrap: no pending update, loading main.js directly');
    }

    // Load the real main process entry
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
