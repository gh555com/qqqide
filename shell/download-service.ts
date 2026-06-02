// ============================================================================
// download-service.ts — SmartHttpDownloader for qqq-shell-v2
//
// HTTP/HTTPS download with:
//   - Range-based resume (If-Range + 206 Partial Content)
//   - SHA-256 optional verification
//   - Progress events via webContents.send('qqq:download:progress', ...)
//   - Cancellation via AbortController token
//   - Output to portable.cache/downloads/ by default; dir overridable per-start.
//
// IPC handlers registered in main.ts:
//   qqq:download:start(opts) → {id, filePath, totalBytes}
//   qqq:download:cancel(id)  → boolean
//   qqq:download:list()      → [{id, url, filePath, bytesDone, totalBytes, done, error}]
//
// preload exposes:
//   bridge.download.start / cancel / list + onProgress(cb)
// ============================================================================

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { URL } from 'url';

export interface DownloadOpts {
  url: string;
  dir?: string;          // output directory; default portable.cache/downloads
  fileName?: string;     // override filename; default extracted from URL or Content-Disposition
  sha256?: string;       // optional expected hex digest
  headers?: Record<string, string>;
}

export interface DownloadE
ntry {
  id: string;
  url: string;
  filePath: string;
  totalBytes: number;
  bytesDone: number;
  done: boolean;
  error: string | null;
  sha256Ok: boolean;
}  

type ProgressSender = (entry: DownloadEntry) => void;

export class DownloadService {
  private _cacheDir: string;
  private _active = new Map<string, { controller: AbortController; entry: DownloadEntry }>();
  private _sendProgress: ProgressSender | null = null;

  constructor(cacheDir: string) {
    this._cacheDir = path.join(cacheDir, 'downloads');
    try { fs.mkdirSync(this._cacheDir, { recursive: true }); } catch { /* ignore */ }
  }

  /** Set the progress callback. Called from main.ts after window is created. */
  setProgressSender(fn: ProgressSender): void {
    this._sendProgress = fn;
  }

  // ---- public API ----

  /** Start a download. Returns the entry immediately; progress is async. */
  start(opts: DownloadOpts): DownloadEntry {
    const id = 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const dir = opts.dir || this._cacheDir;
    const fileName = opts.fileName || this._extractFileName(opts.url);
    const filePath = path.join(dir, fileName);

    const entry: DownloadEntry = {
      id, url: opts.url, filePath,
      totalBytes: 0, bytesDone: 0, done: false, error: null, sha256Ok: false,
    };

    // Check partial file for resume
    let resumeFrom = 0;
    try {
      if (fs.existsSync(filePath)) {
        resumeFrom = fs.statSync(filePath).size;
        entry.bytesDone = resumeFrom;
      }
    } catch { /* start fresh */ }

    const controller = new AbortController();
    this._active.set(id, { controller, entry });

    // Fire-and-forget the actual download
    this._doDownload(entry, opts, controller.signal, resumeFrom).catch(err => {
      if (!entry.done) {
        entry.error = String(err && err.message || err);
        entry.done = true;
        this._emit(entry);
      }
    });

    // Remove from active map when done
    this._emit(entry);
    return entry;
  }

  cancel(id: string): boolean {
    const a = this._active.get(id);
    if (!a) return false;
    try { a.controller.abort(); } catch { /* ignore */ }
    a.entry.done = true;
    a.entry.error = 'cancelled';
    this._emit(a.entry);
    this._active.delete(id);
    return true;
  }
 
  list(): DownloadEntry[] {
    return Array.from(this._active.values()).map(a => a.entry);
  }

  // ---- internal ----

  private _emit(entry: DownloadEntry): void {
    if (this._sendProgress) {
      try { this._sendProgress(entry); } catch { /* ignore */ }
    }
  }

  private _extractFileName(url: string): string {
    try {
      const u = new URL(url);
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length > 0) {
        const last = decodeURIComponent(segs[segs.length - 1]);
        if (last && last.indexOf('.') >= 0) return last;
      }
    } catch { /* fall through */ }
    // Fallback: domain + timestamp
    let host = 'download';
    try { host = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_'); } catch { /* ignore */ }
    return host + '_' + Date.now().toString(36) + '.bin';
  }

  private async _doDownload(
    entry: DownloadEntry,
    opts: DownloadOpts,
    signal: AbortSignal,
    resumeFrom: number,
  ): Promise<void> {
    const parsedUrl = new URL(opts.url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    // Ensure output dir
    try { fs.mkdirSync(path.dirname(entry.filePath), { recursive: true }); } catch { /* ignore */ }

    // If sha256 is given, set up the hasher
    let hasher: ReturnType<typeof crypto.createHash> | null = null;
    if (opts.sha256) {
      hasher = crypto.createHash('sha256');
    }

    // Open the file for writing (append if resuming)
    const flags = resumeFrom > 0 ? 'a' : 'w';
    let fd: number | null = null;
    try {
      fd = fs.openSync(entry.filePath, flags);
    } catch (e: any) {
      entry.error = 'cannot open file: ' + (e.message || String(e));
      entry.done = true;
      this._emit(entry);
      return;
    }

    // Best-effort: if we're resuming and the file is larger than expected, truncate
    // (this can happen if the server doesn't support resume and we re-download from 0)
    // We'll handle that after we get the Content-Length.

    try {
      const contentLength = await this._headRequest(parsedUrl, opts, signal, resumeFrom);

      if (contentLength < 0) {
        // Server doesn't support Range → start fresh
        try { fs.ftruncateSync(fd!); } catch { /* ignore */ }
        try { fs.closeSync(fd!); } catch { /* ignore */ }
        fd = fs.openSync(entry.filePath, 'w');
        resumeFrom = 0;
        entry.bytesDone = 0;
      } else {
        entry.totalBytes = resumeFrom + contentLength;
      }

      if (signal.aborted) {
        entry.error = 'cancelled';
        entry.done = true;
        this._emit(entry);
        try { fs.closeSync(fd!); } catch { /* ignore */ }
        return;
      }

      // Build request
      const headers: Record<string, string> = {
        ...(opts.headers || {}),
        'User-Agent': 'qqq-shell-v2/0.1',
        'Accept': '*/*',
      };
      if (resumeFrom > 0) {
        headers['Range'] = 'bytes=' + resumeFrom + '-';
      }

      const reqOpts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: 'GET' as const,
        headers,
      };

      await new Promise<void>((resolve, reject) => {
        const req = (lib as typeof http).request(reqOpts, (res) => {
          // Handle redirects (3xx)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            try { fs.closeSync(fd!); } catch { /* ignore */ }
            fd = null;
            req.destroy();
            // Follow redirect
            const loc = (Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location) as string;
            const nextUrl = new URL(loc, opts.url).toString();
            const nextOpts: DownloadOpts = { ...opts, url: nextUrl };
            // Reset resume if server doesn't pass range through redirect
            this._doDownload(entry, nextOpts, signal, 0).then(resolve, reject);
            return;
          }

          // Determine total size from response
          const cl = res.headers['content-length'];
          if (cl) {
            const clStr = (Array.isArray(cl) ? cl[0] : cl) as string;
            const parsed = parseInt(clStr, 10);
            if (!isNaN(parsed)) {
              if (res.statusCode === 206) {
                // Partial Content: total = resumeFrom + partial-length
                entry.totalBytes = resumeFrom + parsed;
              } else if (res.statusCode === 200) {
                entry.totalBytes = parsed;
              }
            }
          }

          if (hasher && resumeFrom > 0) {
            // If resuming, we need to hash the already-downloaded portion too
            const h = hasher;  // narrow: TS can't narrow `let` inside nested closure
            try {
              const existing = fs.readFileSync(entry.fi2lePath);
              h.update(existing);
            } catch { /* ignore */ }
          }

          res.on('data', (chunk) => {
            if (signal.aborted) {
              req.destroy();
              return;
            }
            try {
              fs.writeSync(fd!, chunk);
              entry.bytesDone += chunk.length;
              if (hasher) hasher.update(chunk);
              this._emit(entry);
            } catch (e: any) {
              req.destroy();
              reject(e);
            }
          });

          res.on('end', () => {
            try { fs.closeSync(fd!); } catch { /* ignore */ }
            fd = null;
            // SHA-256 verification
            if (hasher) {
              const digest = hasher.digest('hex');
              entry.sha256Ok = digest === opts.sha256;
              if (!entry.sha256Ok) {
                entry.error = 'sha256 mismatch: expected ' + opts.sha256 + ' got ' + digest;
                entry.done = true;
                this._emit(entry);
                reject(new Error(entry.error));
                return;
              }
            }
            entry.done = true;
            entry.error = null;
            this._emit(entry);
            this._active.delete(entry.id);
            resolve();
          });

          res.on('error', (e) => {
            try { fs.closeSync(fd!); } catch { /* ignore */ }
            fd = null;
            reject(e);
          });
        });

        req.on('error', (e: any) => {
          if (e.name === 'AbortError' || signal.aborted) {
            entry.error = 'cancelled';
          } else {
            entry.error = String(e.message || e);
          }
          try { fs.closeSync(fd!); } catch { /* ignore */ }
          fd = null;
          entry.done = true;
          this._emit(entry);
          reject(e);
        });

        if (signal.aborted) {
          req.destroy();
          try { fs.closeSync(fd!); } catch { /* ignore */ }
          fd = null;
          entry.error = 'cancelled';
          entry.done = true;
          this._emit(entry);
          reject(new Error('cancelled'));
          return;
        }

        signal.addEventListener('abort', () => {
          try { req.destroy(); } catch { /* ignore */ }
          try { fs.closeSync(fd!); } catch { /* ignore */ }
          fd = null;
        });

        req.end();
      });
    } catch (e: any) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      if (!entry.error) {
        entry.error = String(e.message || e);
      }
      entry.done = true;
      this._emit(entry);
      this._active.delete(entry.id);
    }
  }

  /** HEAD request to check if server supports Range, returns content-length or -1 */
  private _headRequest(
    parsedUrl: URL,
    opts: DownloadOpts,
    signal: AbortSignal,
    resumePos: number,
  ): Promise<number> {
    return new Promise((resolve) => {
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        ...(opts.headers || {}),
        'User-Agent': 'qqq-shell-v2/0.1',
      };
      if (resumePos > 0) {
        headers['Range'] = 'bytes=0-0'; // probe: ask for first byte to check support
      }

      const req = (lib as typeof http).request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: resumePos > 0 ? 'GET' : 'HEAD',
        headers,
      }, (res) => {
        // If we get 206, server supports Range
        if (res.statusCode === 206) {
          const cr = res.headers['content-range'];
          if (cr) {
            const crStr = (Array.isArray(cr) ? cr[0] : cr) as string;
            const m = /bytes \d+-\d+\/(\d+)/.exec(crStr);
            if (m) { resolve(parseInt(m[1], 10) || -1); return; }
          }
          // Fallback: try Content-Length on the HEAD if range wasn't proper
          const cl = res.headers['content-length'];
          if (cl) {
            const clStr = (Array.isArray(cl) ? cl[0] : cl) as string;
            resolve(parseInt(clStr, 10));
            return;
          }
          resolve(-1);
          return;
        }
        if (res.statusCode === 200) {
          const cl2 = res.headers['content-length'];
          if (cl2) {
            const cl2Str = (Array.isArray(cl2) ? cl2[0] : cl2) as string;
            resolve(parseInt(cl2Str, 10));
          } else {
            resolve(-1); // no content-length → unknown size, start fresh
          }
          return;
        }
        // 4xx/5xx → can't resume, start fresh
        resolve(-1);
      });

      req.on('error', () => resolve(-1));
      signal.addEventListener('abort', () => { try { req.destroy(); } catch { /* ignore */ } });

      if (resumePos > 0) {
        // Must consume the tiny body (1 byte) for the Range GET probe
        req.end();
      } else {
        // HEAD request, no body
        req.end();
      }

      // Safety timeout
      setTimeout(() => {
        try { req.destroy(); } catch { /* ignore */ }
        resolve(-1);
      }, 8000);
    });
  }
}
