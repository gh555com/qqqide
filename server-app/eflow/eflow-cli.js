// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// eflow-cli.js — E-Flow v2 命令行适配器（Node / fs）
//
// 用法：
//   node server-app/eflow/eflow-cli.js status  [root]
//   node server-app/eflow/eflow-cli.js check   [root]        # 退出码 1 = BLOCK
//   node server-app/eflow/eflow-cli.js index   [root] [--dry]
//   node server-app/eflow/eflow-cli.js init    [root] [--name X]
//   node server-app/eflow/eflow-cli.js rotate  [root] [--apply] [--days N]
//   node server-app/eflow/eflow-cli.js upgrade [root] [--dry] [--keep-rules]
//   node server-app/eflow/eflow-cli.js detach  [root] [--purge]
//   任意 op 可加 --data <用户级目录>：有了它才会把 global.txt 接管块计入每轮成本
//
// root 缺省 = 当前工作目录。逻辑全在 eflow-core.js（与面板共用同一份）——
// 这里只做 fs 适配与参数解析，禁写任何判断。
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./eflow-core.js');

const IO = {
    read: async (p) => (await fs.promises.readFile(p, 'utf8')).replace(/^\uFEFF/, ''),
    // 写盘一律 tmp + fsync + rename（写一半断电 = L0 半截，是“文档地基”最不该有的伤）
    write: async (p, t) => {
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
        const fh = await fs.promises.open(tmp, 'w');
        try { await fh.writeFile(t, 'utf8'); await fh.sync(); } finally { await fh.close(); }
        await fs.promises.rename(tmp, p);
    },
    list: async (p) => {
        const es = await fs.promises.readdir(p, { withFileTypes: true });
        return es.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    },
    exists: async (p) => {
        try { await fs.promises.stat(p); return true; } catch (_) { return false; }
    },
    mkdir: async (p) => { if (p) await fs.promises.mkdir(p, { recursive: true }); },
    remove: async (p) => { await fs.promises.unlink(p); },
    rename: async (a, b) => { await fs.promises.rename(a, b); }
};

async function main() {
    const argv = process.argv.slice(2);
    const op = (argv[0] || 'check').toLowerCase();
    const opts = {};
    let root = '';
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry') opts.dry = true;
        else if (a === '--apply') opts.apply = true;
        else if (a === '--name') opts.name = argv[++i];
        else if (a === '--days') opts.days = argv[++i];
        else if (a === '--today') opts.today = argv[++i];
        else if (a === '--purge') opts.purge = true;
        else if (a === '--keep-rules') opts.keepRules = true;
        else if (a === '--data') opts.dataRoot = argv[++i];   // 用户级目录（能算全局接管块的成本；缺省 = 不算，不猜）
        else if (a === '--no-link') opts.link = false;
        else if (a.charAt(0) !== '-') root = a;
    }
    root = path.resolve(root || process.cwd()).replace(/[\\]+/g, '/');
    const r = await core.run(op, IO, root, opts);
    process.stdout.write(r.text + '\n');
    process.exit(op === 'check' ? (r.ok ? 0 : 1) : (r.ok ? 0 : 1));
}

main().catch((e) => {
    process.stderr.write('eflow cli 失败：' + ((e && e.message) || e) + '\n');
    process.exit(2);
});
