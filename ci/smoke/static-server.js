// ci/smoke/static-server.js — 冒烟测试用静默静态服务器
//
// 契约与 shell-build/dev-server.js 对齐：server-app/ 挂载于 /qqqide/（含 /qqqide/health），
// 让冒烟实例以 --url=http://127.0.0.1:PORT/qqqide/ 加载真实载荷。
// 与 dev-server 的差异：零逐请求日志（CI 日志干净）、监听随机空闲端口（可多跑互不打架）。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
};

/**
 * @param {string} rootDir  server-app 目录（绝对路径）
 * @returns {Promise<import('http').Server>} 已监听 127.0.0.1:0 的 server（随机端口）
 */
function createStaticServer(rootDir) {
    const ROOT = path.resolve(rootDir);
    const server = http.createServer((req, res) => {
        const send = (status, headers, body) => {
            try {
                res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store, no-cache, must-revalidate' }, headers));
                res.end(body);
            } catch (_) { /* 客户端已断开 */ }
        };
        let reqPath = '/';
        try { reqPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (_) { }

        if (reqPath === '/' || reqPath === '') { return send(302, { Location: '/qqqide/' }); }
        if (reqPath === '/qqqide') { return send(301, { Location: '/qqqide/' }); }
        if (reqPath === '/qqqide/health' || reqPath === '/qqqide/health/') {
            return send(200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok');
        }
        if (!reqPath.startsWith('/qqqide/')) { return send(404, { 'Content-Type': 'text/plain' }, 'not found'); }

        let rel = reqPath.slice('/qqqide'.length).replace(/^\/+/, '');
        if (rel === '') { rel = 'index.html'; }
        if (rel.endsWith('/')) { rel += 'index.html'; }
        const abs = path.normalize(path.join(ROOT, rel));
        if (!abs.startsWith(ROOT)) { return send(403, { 'Content-Type': 'text/plain' }, 'forbidden'); }

        fs.stat(abs, (err, st) => {
            if (err || !st.isFile()) { return send(404, { 'Content-Type': 'text/plain' }, 'not found'); }
            const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
            try {
                res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
            } catch (_) { return; }
            const stream = fs.createReadStream(abs);
            stream.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
            stream.pipe(res);
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { createStaticServer };
