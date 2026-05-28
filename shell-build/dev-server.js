// ============================================================================
// dev-server.js - local static server for server-app/
//
//   serves:  http://127.0.0.1:8080/qqq-app/...    -> ../server-app/...
//   health:  http://127.0.0.1:8080/qqq-app/health -> 200 "ok"
//
// Designed so that the electron shell's DEFAULT_REMOTE_URL
// (http://127.0.0.1:8080/qqq-app/) works without any config edit.
//
// Usage:
//   node shell-build/dev-server.js              (port 8080)
//   node shell-build/dev-server.js --port=9090
//   PORT=9090 node shell-build/dev-server.js
// ============================================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const args = process.argv.slice(2);
const getArg = name => {
    const a = args.find(s => s.startsWith('--' + name + '='));
    return a ? a.slice(name.length + 3) : null;
};

const PORT = parseInt(getArg('port') || process.env.PORT || '8080', 10);
const HOST = getArg('host') || process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..', 'server-app');
const MOUNT = '/qqq-app';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm':  'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.otf':  'font/otf',
    '.map':  'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.txt':  'text/plain; charset=utf-8',
};

function send(res, status, headers, body) {
    res.writeHead(status, {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        ...headers,
    });
    if (body) { res.end(body); } else { res.end(); }
}

function serveFile(res, filePath) {
    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
            return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found: ' + filePath);
        }
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': st.size,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Last-Modified': st.mtime.toUTCString(),
        });
        fs.createReadStream(filePath).pipe(res);
    });
}

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    const reqPath = decodeURIComponent(parsed.pathname || '/');

    // Logging
    console.log(`[dev] ${req.method} ${reqPath}`);

    // Mount root: redirect / to /qqq-app/
    if (reqPath === '/' || reqPath === '') {
        return send(res, 302, { Location: MOUNT + '/' });
    }

    // Health endpoint (consumed by shell main.ts healthCheck())
    if (reqPath === MOUNT + '/health' || reqPath === MOUNT + '/health/') {
        return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok');
    }

    // Mount handling
    if (!reqPath.startsWith(MOUNT)) {
        return send(res, 404, { 'Content-Type': 'text/plain' }, 'unknown mount: ' + reqPath);
    }
    let rel = reqPath.slice(MOUNT.length);
    if (rel === '' || rel === '/') { rel = '/index.html'; }

    // Directory-style request -> index.html
    if (rel.endsWith('/')) { rel += 'index.html'; }

    // Path traversal guard
    const resolved = path.normalize(path.join(ROOT, rel));
    if (!resolved.startsWith(ROOT)) {
        return send(res, 403, { 'Content-Type': 'text/plain' }, 'forbidden');
    }

    serveFile(res, resolved);
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[dev] port ${PORT} busy. set --port=NNN or kill the holder.`);
    } else {
        console.error('[dev] server error:', err);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log('============================================================');
    console.log(`[dev] serving ${ROOT}`);
    console.log(`[dev] http://${HOST}:${PORT}${MOUNT}/`);
    console.log(`[dev] health: http://${HOST}:${PORT}${MOUNT}/health`);
    console.log('[dev] edit server-app/* and refresh the window (Ctrl+R).');
    console.log('============================================================');
});
