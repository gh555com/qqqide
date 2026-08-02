// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// preload.ts
// Bridges renderer (remote web app loaded from server) to main process via
// a strict contextBridge whitelist. NO arbitrary IPC. NO node integration.
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron';

const QQQ = {
    // ---- app info ----
    app: {
        root: () => ipcRenderer.invoke('qqqide:app:root'),
        quitAll: () => ipcRenderer.invoke('qqqide:app:quitAll'),
    },

    // ---- component binaries ----
    components: {
        getBin: (name: string) => ipcRenderer.invoke('qqqide:components:getBin', name),
    },

    // ---- auth — 认证中心大脑（2026-07-31 T3） ----
    auth: {
        // ★ 外部浏览器登录（主通道 — shell.openExternal → OS 协议回调）
        openLoginExternal: () => ipcRenderer.invoke('qqqide:auth:open-login-external'),
        // ★ 内嵌窗口登录（兜底 — BrowserWindow）
        openLoginWindow: () => ipcRenderer.invoke('qqqide:auth:open-login-window'),
        // ★ 订阅认证状态变更（中心大脑广播 → 所有窗口秒级同步）
        onAuthChanged: (cb: (snap: any) => void) => {
            const handler = (_e: any, snap: any) => { try { cb(snap); } catch (err) { console.warn('[auth.onAuthChanged]', err); } };
            ipcRenderer.on('qqqide:auth:changed', handler);
            return () => ipcRenderer.removeListener('qqqide:auth:changed', handler);
        },
        // ★ 获取当前认证状态（新窗口打开时同步）
        getState: () => ipcRenderer.invoke('qqqide:auth:get-state'),
        // ★ 退出登录
        logout: () => ipcRenderer.invoke('qqqide:auth:logout'),
        // ★ billing 事件 → 刷新 LV
        notifyBilling: (costWge: number) => ipcRenderer.send('qqqide:auth:billing', costWge),
        // ── 以下为旧 API，保留兼容但标记废弃 ──
        onAuthPush: (cb: (data: { token: string; phone: string; country_iso2?: string; purchased?: boolean; session_id?: string }) => void) => {
            const handler = (_e: any, data: { token: string; phone: string; country_iso2?: string; purchased?: boolean; session_id?: string }) => { try { cb(data); } catch (err) { console.warn('[auth.onAuthPush]', err); } };
            ipcRenderer.on('qqqide-auth', handler);
            return () => ipcRenderer.removeListener('qqqide-auth', handler);
        },
        saveAuth: (auth: { token: string; phone: string; device_name?: string; country_iso2?: string; purchased?: boolean } | null) => ipcRenderer.invoke('qqqide:auth:save', auth),
        loadAuth: () => ipcRenderer.invoke('qqqide:auth:load'),
        clearAuth: () => ipcRenderer.invoke('qqqide:auth:clear'),
        setPhone: (phone: string) => ipcRenderer.invoke('qqqide:auth:set-phone', phone),
    },

    // ---- file system (proxied to engine subprocess) ----
    fs: {
        read: (p: string) => ipcRenderer.invoke('qqqide:fs:read', p),
        readBase64: (p: string) => ipcRenderer.invoke('qqqide:fs:readBase64', p),
        write: (p: string, content: string | Buffer) => ipcRenderer.invoke('qqqide:fs:write', p, content),
        writeBase64: (p: string, base64: string) => ipcRenderer.invoke('qqqide:fs:writeBase64', p, base64),
        append: (p: string, content: string) => ipcRenderer.invoke('qqqide:fs:append', p, content),
        list: async (p: string) => {
            var result: any = await ipcRenderer.invoke('qqqide:fs:list', p, new Error('fs.list caller').stack);
            // 新格式（带 stat）：直接返回
            if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') return result;
            // 旧兼容（字符串格式）
            if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'string') {
                return result.map((s: string) => ({
                    name: s.endsWith('/') ? s.slice(0, -1) : s,
                    isDir: s.endsWith('/')
                }));
            }
            return result;
        },
        stat: (p: string) => ipcRenderer.invoke('qqqide:fs:stat', p),
        exists: (p: string) => ipcRenderer.invoke('qqqide:fs:exists', p),
        mkdir: (p: string) => ipcRenderer.invoke('qqqide:fs:mkdir', p),
        remove: (p: string) => ipcRenderer.invoke('qqqide:fs:remove', p),
        rename: (oldP: string, newP: string) => ipcRenderer.invoke('qqqide:fs:rename', oldP, newP),
        // ★ 流式复制 + 进度回调。onProgress({copied,total})，返回 Promise<true>
        copyFile: (src: string, dest: string, onProgress?: (p: { copied: number; total: number }) => void): Promise<boolean> => {
            const streamId = 'cp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            return new Promise((resolve, reject) => {
                const handler = (_e: any, msg: { streamId: string; copied: number; total: number }) => {
                    if (!msg || msg.streamId !== streamId) return;
                    try { if (onProgress) onProgress({ copied: msg.copied, total: msg.total }); } catch { }
                };
                ipcRenderer.on('qqqide:fs:copy-progress', handler);
                ipcRenderer.invoke('qqqide:fs:copyFile', src, dest, streamId).then((result: boolean) => {
                    ipcRenderer.removeListener('qqqide:fs:copy-progress', handler);
                    resolve(result);
                }).catch((err: any) => {
                    ipcRenderer.removeListener('qqqide:fs:copy-progress', handler);
                    reject(err);
                });
            });
        },
        drives: () => ipcRenderer.invoke('qqqide:fs:drives'),
        diskFree: (d: string[]) => ipcRenderer.invoke('qqqide:fs:diskFree', d),
    },

    // ---- dialogs ----
    dialog: {
        open: (opts?: any) => ipcRenderer.invoke('qqqide:dialog:open', opts),
        save: (opts?: any) => ipcRenderer.invoke('qqqide:dialog:save', opts),
        message: (opts?: any) => ipcRenderer.invoke('qqqide:dialog:message', opts),
    },

    // ---- asset-roots: extend the qqqide-asset://file/ whitelist at runtime ----
    assetRoots: {
        add: (absDir: string) => ipcRenderer.invoke('qqqide:assetRoots:add', absDir),
        list: () => ipcRenderer.invoke('qqqide:assetRoots:list'),
        remove: (absDir: string) => ipcRenderer.invoke('qqqide:assetRoots:remove', absDir),
    },

    // ---- window controls ----
    window: {
        minimize: () => ipcRenderer.invoke('qqqide:window:minimize'),
        maximize: () => ipcRenderer.invoke('qqqide:window:maximize'),
        unmaximize: () => ipcRenderer.invoke('qqqide:window:unmaximize'),
        close: () => ipcRenderer.invoke('qqqide:window:close'),
        closeConfirmed: () => ipcRenderer.invoke('qqqide:window:close-confirmed'),
        onCloseConfirm: (cb: () => void) => { const h = () => { try { cb(); } catch (_) {} }; ipcRenderer.on('qqqide:confirm-close', h); return () => ipcRenderer.removeListener('qqqide:confirm-close', h); },
        isMaximized: () => ipcRenderer.invoke('qqqide:window:isMaximized'),
        setTitle: (s: string) => ipcRenderer.invoke('qqqide:window:setTitle', s),
        toggleDevTools: () => ipcRenderer.invoke('qqqide:window:toggleDevTools'),
        new: (folderPath?: string) => ipcRenderer.invoke('qqqide:window:new', folderPath),
        claimProject: (projectRoot: string) => ipcRenderer.invoke('qqqide:window:claimProject', projectRoot),
        releaseProject: (projectRoot: string) => ipcRenderer.invoke('qqqide:window:releaseProject', projectRoot),
        adjustBounds: (deltaLeft: number, deltaRight: number) => ipcRenderer.invoke('qqqide:window:adjust-bounds', deltaLeft, deltaRight),
        setWingState: (leftOpen: boolean, rightOpen: boolean) => ipcRenderer.invoke('qqqide:wing:state', leftOpen, rightOpen),
    },

    // ---- devtools bridge (renderer → main process) ----
    devtools: {
        rename: (projectRoot: string) => ipcRenderer.invoke('qqqide:devtools:rename', projectRoot),
    },

    // ---- zoom (UI scale) ----
    zoom: {
        get: () => ipcRenderer.invoke('qqqide:zoom:get'),
        set: (factor: number) => ipcRenderer.invoke('qqqide:zoom:set', factor),
        adjust: (delta: number) => ipcRenderer.invoke('qqqide:zoom:adjust', delta),
        onChanged: (cb: (factor: number) => void) => {
            const handler = (_e: any, factor: number) => cb(factor);
            ipcRenderer.on('qqqide:zoom:changed', handler);
            return () => ipcRenderer.removeListener('qqqide:zoom:changed', handler);
        },
    },

    // ---- native menu (server-pushed JSON schema -> Electron Menu) ----
    menu: {
        set: (schema: any) => ipcRenderer.invoke('qqqide:menu:set', schema),
        onFired: (cb: (cmd: string) => void) => {
            const handler = (_e: any, cmd: string) => cb(cmd);
            ipcRenderer.on('qqqide:menu:fired', handler);
            return () => ipcRenderer.removeListener('qqqide:menu:fired', handler);
        },
    },

    // ---- monaco editor pool (in-shell instances) ----
    monaco: {
        create: (opts?: any) => ipcRenderer.invoke('qqqide:monaco:create', opts),
        open: (id: number, file: string) => ipcRenderer.invoke('qqqide:monaco:open', id, file),
        save: (id: number) => ipcRenderer.invoke('qqqide:monaco:save', id),
        dispose: (id: number) => ipcRenderer.invoke('qqqide:monaco:dispose', id),
    },

    // ---- generic engine RPC (Rust/Python/Node subprocesses) ----
    engine: {
        invoke: (method: string, params?: any) => ipcRenderer.invoke('qqqide:engine:invoke', method, params),
        isAlive: () => ipcRenderer.invoke('qqqide:engine:isAlive'),
    },

    // ---- audio (will route to miniaudio_v16.py) ----
    audio: {
        play: (file: string, opts?: any) => ipcRenderer.invoke('qqqide:audio:play', file, opts),
        stop: (scope?: string) => ipcRenderer.invoke('qqqide:audio:stop', scope),
        invoke: (action: string, params?: any) => ipcRenderer.invoke('qqqide:audio:invoke', action, params),
        isAlive: () => ipcRenderer.invoke('qqqide:audio:isAlive'),
    },

    // ---- system shell ----
    shell: {
        openExternal: (url: string) => ipcRenderer.invoke('qqqide:shell:openExternal', url),
        openPath: (p: string) => ipcRenderer.invoke('qqqide:shell:openPath', p),
        hardRefresh: () => ipcRenderer.invoke('qqqide:shell:hardRefresh'),
        // ★ 浏览器启动兜底（2026-07-28）：主进程所有层失败后推 URL 给渲染层弹 qoast
        onBrowserFallback: (cb: (url: string) => void) => {
            const handler = (_e: any, data: { url: string }) => { try { cb(data.url); } catch (err) { console.warn('[shell.onBrowserFallback]', err); } };
            ipcRenderer.on('qqqide:browser-fallback', handler);
            return () => ipcRenderer.removeListener('qqqide:browser-fallback', handler);
        },
    },

    // ---- 跨窗口同步 IPC（替代 BroadcastChannel，终极架构 §C）----
    sync: {
        // 广播消息到所有其他窗口（主进程中转）。静默吞错——广播是 best-effort。
        broadcast: (channel: string, data: any) => ipcRenderer.invoke('qqqide:sync:broadcast', channel, data).catch(() => { }),
        // 订阅来自其他窗口的消息。返回 unsubscribe 函数。
        onMessage: (cb: (channel: string, data: any) => void) => {
            const handler = (_e: any, channel: string, data: any) => {
                try { cb(channel, data); } catch (err) { console.warn('[sync.onMessage]', err); }
            };
            ipcRenderer.on('qqqide:sync:message', handler);
            return () => { ipcRenderer.removeListener('qqqide:sync:message', handler); };
        },
        getProjectPath: () => ipcRenderer.invoke('qqqide:sync:get-project-path'),
        setProjectPath: (p: string) => ipcRenderer.invoke('qqqide:sync:set-project-path', p).catch(() => { }),
        getTheme: () => ipcRenderer.invoke('qqqide:sync:get-theme'),
    },

    // ---- clipboard (klipzap) ----
    clipboard: {
        probe: () => ipcRenderer.invoke('qqqide:clipboard:probe'),
        readText: () => ipcRenderer.invoke('qqqide:clipboard:readText'),
        writeText: (s: string) => ipcRenderer.invoke('qqqide:clipboard:writeText', s),
        readImage: () => ipcRenderer.invoke('qqqide:clipboard:readImage'),
        hasImage: () => ipcRenderer.invoke('qqqide:clipboard:hasImage'),
        readHtml: () => ipcRenderer.invoke('qqqide:clipboard:readHtml'),
        readFiles: () => ipcRenderer.invoke('qqqide:clipboard:readFiles'),
        writeFiles: (paths: string[]) => ipcRenderer.invoke('qqqide:clipboard:writeFiles', paths),
    },

    // ---- ghrun (qz process manager) ----
    ghrun: {
        exec: (cmd: string, args: string[], opts?: any) => ipcRenderer.invoke('qqqide:ghrun:exec', cmd, args, opts),
        isAlive: () => ipcRenderer.invoke('qqqide:ghrun:isAlive'),
    },

    // ---- qz unified spawn (canonical entry; ghrun/runner.py/node fallback) ----
    qz: {
        spawn: (brief: any) => ipcRenderer.invoke('qqqide:qz:spawn', brief),
        // Streaming spawn: real-time stdout/stderr via onChunk(channel, data).
        // Returns Promise<SpawnResult>. Used for long-running commands like git push/pull.
        spawnStream: (brief: any, onChunk: (channel: string, data: string) => void) => {
            const streamId = 'qzs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            return new Promise((resolve, reject) => {
                const handler = (_e: any, msg: any) => {
                    if (!msg || msg.streamId !== streamId) return;
                    if (msg.type === 'progress') {
                        try { onChunk(msg.channel || 'stdout', msg.data || ''); } catch { }
                    } else if (msg.type === 'done') {
                        ipcRenderer.removeListener('qqqide:qz:stream', handler);
                        resolve(msg.result);
                    } else if (msg.type === 'error') {
                        ipcRenderer.removeListener('qqqide:qz:stream', handler);
                        reject(new Error(msg.error || 'spawn-stream failed'));
                    }
                };
                ipcRenderer.on('qqqide:qz:stream', handler);
                ipcRenderer.invoke('qqqide:qz:spawn-stream', { ...brief, streamId }).catch((err: any) => {
                    ipcRenderer.removeListener('qqqide:qz:stream', handler);
                    reject(err);
                });
            });
        },
        which: (cmd: string) => ipcRenderer.invoke('qqqide:qz:which', cmd),
        ghrunAlive: () => ipcRenderer.invoke('qqqide:qz:ghrunAlive'),
        runnerAlive: () => ipcRenderer.invoke('qqqide:qz:runnerAlive'),
    },

    // ---- lsp (language intelligence — spawns language servers for diagnostics) ----
    lsp: {
        startLanguage: (lang: string, rootUri: string) => ipcRenderer.invoke('qqqide:lsp:startLanguage', lang, rootUri),
        stopLanguage: (lang: string) => ipcRenderer.invoke('qqqide:lsp:stopLanguage', lang),
        openDocument: (filePath: string, text: string) => ipcRenderer.invoke('qqqide:lsp:openDocument', filePath, text),
        changeDocument: (filePath: string, changes: any[], version: number) => ipcRenderer.invoke('qqqide:lsp:changeDocument', filePath, changes, version),
        closeDocument: (filePath: string) => ipcRenderer.invoke('qqqide:lsp:closeDocument', filePath),
        hover: (filePath: string, line: number, character: number) => ipcRenderer.invoke('qqqide:lsp:hover', filePath, line, character),
        getDiagnostics: (uri: string) => ipcRenderer.invoke('qqqide:lsp:getDiagnostics', uri),
        activeLanguages: () => ipcRenderer.invoke('qqqide:lsp:activeLanguages'),
        onDiagnostics: (cb: (msg: { uri: string; diagnostics: any[] }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[lsp.onDiagnostics]', err); } };
            ipcRenderer.on('qqqide:lsp:diagnostics', handler);
            return () => ipcRenderer.removeListener('qqqide:lsp:diagnostics', handler);
        },
    },

    // ---- search (高性能项目搜索引擎) ----
    search: {
        query: (opts: { query: string; searchPath: string; isRegex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; includePattern?: string; excludePattern?: string; contextLines?: number; maxResults?: number; timeoutMs?: number; respectGitignore?: boolean }) => ipcRenderer.invoke('qqqide:search:query', opts),
        replace: (opts: { replacements?: Array<{ file: string; line: number; col: number; matchLen: number; replacement: string }>; files?: string[]; find?: string; replace?: string; useRegex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; searchPath?: string; onProgress?: (data: { current: number; total: number; file: string; replaced: number; errors: string[] }) => void }) => {
            const { onProgress } = opts;
            let handler: ((_e: any, data: any) => void) | null = null;
            if (onProgress) {
                handler = (_e: any, data: any) => { try { onProgress(data); } catch {} };
                ipcRenderer.on('qqqide:search:replace:progress', handler);
            }
            const invokeArgs: any = {};
            if (opts.files) invokeArgs.files = opts.files;
            if (opts.find) invokeArgs.find = opts.find;
            if (opts.replace) invokeArgs.replace = opts.replace;
            if (opts.useRegex !== undefined) invokeArgs.useRegex = opts.useRegex;
            if (opts.caseSensitive !== undefined) invokeArgs.caseSensitive = opts.caseSensitive;
            if (opts.wholeWord !== undefined) invokeArgs.wholeWord = opts.wholeWord;
            if (opts.searchPath) invokeArgs.searchPath = opts.searchPath;
            if (opts.replacements) invokeArgs.replacements = opts.replacements;
            return ipcRenderer.invoke('qqqide:search:replace', invokeArgs).then((res: any) => {
                if (handler) ipcRenderer.removeListener('qqqide:search:replace:progress', handler);
                return res;
            }).catch((err: any) => {
                if (handler) ipcRenderer.removeListener('qqqide:search:replace:progress', handler);
                throw err;
            });
        },
    },

    // ---- ai (one-shot AI calls for hover, inline completions, etc.) ----
    ai: {
        hover: (context: string) => ipcRenderer.invoke('qqqide:ai:hover', context),
        search_text: (args: { query: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqqide:ai:search_text', args),
        find_files: (args: { pattern: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqqide:ai:find_files', args),
        list_files: (args: { path: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqqide:ai:list_files', args),
        read_file: (args: { path: string; start_line?: number; end_line?: number; sha256?: string }) => ipcRenderer.invoke('qqqide:ai:read_file', args),
        edit_file: (args: { path: string; edits: Array<{ find: string; replace: string; replace_all?: boolean }> }) => ipcRenderer.invoke('qqqide:ai:edit_file', args),
        create_file: (args: { path: string; content: string }) => ipcRenderer.invoke('qqqide:ai:create_file', args),
        delete_file: (args: { path: string }) => ipcRenderer.invoke('qqqide:ai:delete_file', args),
        write_file: (args: { path: string; content: string }) => ipcRenderer.invoke('qqqide:ai:write_file', args),
        search_smart: (args: { query: string; topK?: number; path?: string; regex?: string }) => ipcRenderer.invoke('qqqide:ai:search_smart', args),
    },

    // ---- cache (KV + bucketed file cache rooted at portable.cache) ----
    cache: {
        get: (key: string) => ipcRenderer.invoke('qqqide:cache:get', key),
        put: (key: string, value: any, opts?: any) => ipcRenderer.invoke('qqqide:cache:put', key, value, opts),
        has: (key: string) => ipcRenderer.invoke('qqqide:cache:has', key),
        delete: (key: string) => ipcRenderer.invoke('qqqide:cache:delete', key),
        path: (key: string) => ipcRenderer.invoke('qqqide:cache:path', key),
        bucketPath: (sig: string, ext?: string) => ipcRenderer.invoke('qqqide:cache:bucketPath', sig, ext),
    },

    // ---- state (唯一真理持久化机器: doc/blob/log via shell/state-sqlite.ts) ----
    state: {
        register: (ns: string, schema: any) => ipcRenderer.invoke('qqqide:state:register', ns, schema),
        get: (ns: string, key: string) => ipcRenderer.invoke('qqqide:state:get', ns, key),
        set: (ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:state:set', ns, key, value),
        setNow: (ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:state:setNow', ns, key, value),
        append: (ns: string, key: string, event: any) => ipcRenderer.invoke('qqqide:state:append', ns, key, event),
        del: (ns: string, key: string) => ipcRenderer.invoke('qqqide:state:del', ns, key),
        list: (ns: string) => ipcRenderer.invoke('qqqide:state:list', ns),
        flush: () => ipcRenderer.invoke('qqqide:state:flush'),
        flushOne: (ns: string, key: string) => ipcRenderer.invoke('qqqide:state:flushOne', ns, key),
        stats: () => ipcRenderer.invoke('qqqide:state:stats'),
        sql: (query: string, params?: any[]) => ipcRenderer.invoke('qqqide:state:sql', query, params),
        cloud: {
            pull: () => ipcRenderer.invoke('qqqide:state:cloud:pull'),
            push: () => ipcRenderer.invoke('qqqide:state:cloud:push'),
            sync: () => ipcRenderer.invoke('qqqide:state:cloud:sync'),
            setAuth: (auth: { phone: string; token: string; device_name?: string } | null) => ipcRenderer.invoke('qqqide:state:cloud:setAuth', auth),
        },
        // Subscribe to any (ns,key) change. Returns an unsubscribe fn.
        onChange: (cb: (msg: { ns: string; key: string; value: any; deleted: boolean }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[state.onChange]', err); } };
            ipcRenderer.on('qqqide:state:changed', handler);
            return () => ipcRenderer.removeListener('qqqide:state:changed', handler);
        },
        // Project-level SQLite (quest.sq3) — separate DB per dbPath
        project: {
            register: (dbPath: string, ns: string, schema: any) => ipcRenderer.invoke('qqqide:state:project:register', dbPath, ns, schema),
            get: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:state:project:get', dbPath, ns, key),
            set: (dbPath: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:state:project:set', dbPath, ns, key, value),
            setNow: (dbPath: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:state:project:setNow', dbPath, ns, key, value),
            append: (dbPath: string, ns: string, key: string, event: any) => ipcRenderer.invoke('qqqide:state:project:append', dbPath, ns, key, event),
            del: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:state:project:del', dbPath, ns, key),
            list: (dbPath: string, ns: string) => ipcRenderer.invoke('qqqide:state:project:list', dbPath, ns),
            flush: (dbPath: string) => ipcRenderer.invoke('qqqide:state:project:flush', dbPath),
            flushOne: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:state:project:flushOne', dbPath, ns, key),
            stats: (dbPath: string) => ipcRenderer.invoke('qqqide:state:project:stats', dbPath),
            atomicIncr: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:state:project:atomicIncr', dbPath, ns, key),
            onChange: (dbPath: string, cb: (msg: { dbPath: string; ns: string; key: string; value: any; deleted: boolean }) => void) => {
                const handler = (_e: any, msg: any) => { if (msg && msg.dbPath === dbPath) { try { cb(msg); } catch (err) { console.warn('[state.project.onChange]', err); } } };
                ipcRenderer.on('qqqide:state:project:changed', handler);
                return () => ipcRenderer.removeListener('qqqide:state:project:changed', handler);
            },
        },
    },

    // ---- qgf (FS 原子读写真理机) ----
    qgf: {
        register: (rootDir: string, ns: string, schema: any) => ipcRenderer.invoke('qqqide:qgf:register', rootDir, ns, schema),
        get: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:qgf:get', rootDir, ns, key),
        set: (rootDir: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:qgf:set', rootDir, ns, key, value),
        setNow: (rootDir: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:qgf:setNow', rootDir, ns, key, value),
        append: (rootDir: string, ns: string, key: string, event: any) => ipcRenderer.invoke('qqqide:qgf:append', rootDir, ns, key, event),
        del: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:qgf:del', rootDir, ns, key),
        list: (rootDir: string, ns: string) => ipcRenderer.invoke('qqqide:qgf:list', rootDir, ns),
        flush: (rootDir: string) => ipcRenderer.invoke('qqqide:qgf:flush', rootDir),
        stats: (rootDir: string) => ipcRenderer.invoke('qqqide:qgf:stats', rootDir),
        flushOne: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:qgf:flushOne', rootDir, ns, key),
        // ★ 任意路径原子读写（突破固定目录限制）
        atomicWrite: (absPath: string, data: string) => ipcRenderer.invoke('qqqide:qgf:atomicWrite', absPath, data),
        atomicRead: (absPath: string) => ipcRenderer.invoke('qqqide:qgf:atomicRead', absPath),
        onChange: (cb: (msg: { rootDir: string; ns: string; key: string; value: any; deleted: boolean }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[qgf.onChange]', err); } };
            ipcRenderer.on('qqqide:qgf:changed', handler);
            return () => ipcRenderer.removeListener('qqqide:qgf:changed', handler);
        },
    },

    // ---- timeline (文件版本时间线，SHA256去重 + gzip + SQLite) ----
    timeline: {
        record: (args: { projectRoot: string; filePath: string; content: string; source: string; floorId?: string }) => ipcRenderer.invoke('qqqide:timeline:record', args),
        versions: (args: { projectRoot: string; filePath: string }) => ipcRenderer.invoke('qqqide:timeline:versions', args),
        content: (args: { projectRoot: string; blobHash: string }) => ipcRenderer.invoke('qqqide:timeline:content', args),
        stat: (filePath: string) => ipcRenderer.invoke('qqqide:timeline:stat', filePath),
        readCurrent: (filePath: string) => ipcRenderer.invoke('qqqide:timeline:readCurrent', filePath),
        listTrackedFiles: (args: { projectRoot: string }) => ipcRenderer.invoke('qqqide:timeline:listTrackedFiles', args),
        captureChanged: (args: { projectRoot: string; sinceMs: number; cwd?: string }) => ipcRenderer.invoke('qqqide:timeline:captureChanged', args),
        openDiffWindow: (args: { filePath: string; beforeBlobHash?: string; afterBlobHash?: string; projectRoot: string }) => ipcRenderer.invoke('qqqide:open-diff-window', args),
        // 用户在 diff 窗口内切换文件时更新主进程映射
        setPath: (newPath: string) => ipcRenderer.send('qqqide:diff:set-path', newPath),
        // op 按钮：在 X 区 editor 打开文件
        openInEditor: (filePath: string) => ipcRenderer.send('qqqide:timeline:open-in-editor', filePath),
        // op 按钮：喂给 AI
        feedToAi: (filePath: string) => ipcRenderer.send('qqqide:timeline:feed-to-ai', filePath),
        // 监听主进程推送的 diff 更新（复用已有窗口时触发）
        onDiffUpdate: (cb: (data: { beforeBlobHash?: string; afterBlobHash?: string }) => void) => {
            const handler = (_e: any, data: any) => { try { cb(data); } catch (err) { console.warn('[timeline.onDiffUpdate]', err); } };
            ipcRenderer.on('qqqide:diff:update', handler);
            return () => ipcRenderer.removeListener('qqqide:diff:update', handler);
        },
    },

        // ---- git diff window (独立 BrowserWindow Monaco diff, read-only) ----
    git: {
        openDiff: (args: { filePath: string; projectRoot: string; commitHash?: string; mode?: string; staged?: boolean }) => ipcRenderer.invoke('qqqide:git:open-diff', args),
    },

    // ---- dirty snapshots (跨窗口脏文件共享，Layer 2: IDE 领域内视觉一致) ----
    dirty: {
        set: (filePath: string, content: string) => ipcRenderer.invoke('qqqide:dirty:set', filePath, content).catch(() => {}),
        get: (filePath: string) => ipcRenderer.invoke('qqqide:dirty:get', filePath),
        remove: (filePath: string) => ipcRenderer.invoke('qqqide:dirty:remove', filePath).catch(() => {}),
        list: () => ipcRenderer.invoke('qqqide:dirty:list'),
    },

    // ---- hash (xxh64 fast + sha256 strong, with mtime cache) ----
    hash: {
        file: (p: string, mode?: 'fast' | 'strong' | 'both') => ipcRenderer.invoke('qqqide:hash:file', p, mode),
        buffer: (b64: string, mode?: 'fast' | 'strong' | 'both') => ipcRenderer.invoke('qqqide:hash:buffer', b64, mode),
    },

    // ---- media (ffmpeg-backed thumbnail / transcode / probe via qz) ----
    media: {
        thumb: (opts: any) => ipcRenderer.invoke('qqqide:media:thumb', opts),
        transcode: (opts: any) => ipcRenderer.invoke('qqqide:media:transcode', opts),
        probe: (src: string) => ipcRenderer.invoke('qqqide:media:probe', src),
        ffmpegPath: () => ipcRenderer.invoke('qqqide:media:ffmpegPath'),
    },

    // ---- key (global shortcut bridge; per-window/iframe handled in renderer) ----
    key: {
        registerGlobal: (accel: string, id: string) => ipcRenderer.invoke('qqqide:key:registerGlobal', accel, id),
        unregisterGlobal: (accel: string) => ipcRenderer.invoke('qqqide:key:unregisterGlobal', accel),
        unregisterAllGlobal: () => ipcRenderer.invoke('qqqide:key:unregisterAllGlobal'),
        onGlobal: (cb: (msg: { id: string; accel: string }) => void) => {
            const handler = (_e: any, msg: any) => cb(msg);
            ipcRenderer.on('qqqide:key:global', handler);
            return () => ipcRenderer.removeListener('qqqide:key:global', handler);
        },
    },

    // ---- download (SmartHttpDownloader via shell/download-service.ts) ----
    download: {
        start: (opts: any) => ipcRenderer.invoke('qqqide:download:start', opts),
        cancel: (id: string) => ipcRenderer.invoke('qqqide:download:cancel', id),
        list: () => ipcRenderer.invoke('qqqide:download:list'),
        onProgress: (cb: (entry: any) => void) => {
            const handler = (_e: any, entry: any) => { try { cb(entry); } catch (err) { console.warn('[download.onProgress]', err); } };
            ipcRenderer.on('qqqide:download:progress', handler);
            return () => ipcRenderer.removeListener('qqqide:download:progress', handler);
        },
    },

    // ---- update (hot reload: pull server-app.tar.xz from gh555.com) ----
    update: {
        check: () => ipcRenderer.invoke('qqqide:update:check'),
        apply: () => ipcRenderer.invoke('qqqide:update:apply'),
        state: () => ipcRenderer.invoke('qqqide:update:state'),
        abort: () => ipcRenderer.invoke('qqqide:update:abort'),
        upgradeShell: () => ipcRenderer.invoke('qqqide:update:upgrade-shell'),
    },

    // ---- boot info (read once on startup) ----
    boot: {
        getInfo: () => ipcRenderer.invoke('qqqide:boot:info'),
        retry: () => ipcRenderer.invoke('qqqide:boot:retry'),
        probe: () => ipcRenderer.invoke('qqqide:boot:probe'),
    },

    // ---- gaeaProcess (通用 gaea process-type goods 进程管理) ----
    // lifecycle: 'attached'=随主窗口生死 / 'independent'=独立程序
    gaeaProcess: {
        start: (goodsId: string, scriptPath: string, runtime?: string, lifecycle?: string, allowMultiple?: boolean) => ipcRenderer.invoke('qqqide:gaea-process:start', goodsId, scriptPath, runtime, lifecycle, allowMultiple),
        stop: (goodsId: string) => ipcRenderer.invoke('qqqide:gaea-process:stop', goodsId),
        status: (goodsId: string) => ipcRenderer.invoke('qqqide:gaea-process:status', goodsId),
        getAutoStart: (goodsId: string) => ipcRenderer.invoke('qqqide:gaea-process:get-auto-start', goodsId),
        setAutoStart: (goodsId: string, v: boolean, meta?: { scriptPath?: string; runtime?: string; lifecycle?: string; allowMultiple?: boolean }) => ipcRenderer.invoke('qqqide:gaea-process:set-auto-start', goodsId, v, meta),
        onStatusChanged: (cb: (goodsId: string, running: boolean, pid: number | null) => void) => {
            const handler = (_e: any, data: { goodsId: string; running: boolean; pid: number | null }) => cb(data.goodsId, data.running, data.pid);
            ipcRenderer.on('qqqide:gaea-process:status-changed', handler);
            return () => ipcRenderer.removeListener('qqqide:gaea-process:status-changed', handler);
        },
    },

    // ---- desktop shortcut (Windows: PowerShell COM 创建/删除 .lnk) ----
    desktop: {
        syncShortcut: (enabled: boolean) => ipcRenderer.invoke('qqqide:desktop:sync-shortcut', enabled),
    },

    // ---- kope (剪贴板历史, sql.js 直接读写 kope.sq3) ----
    kope: {
        getHistory: (limit?: number, offset?: number, keyword?: string) => ipcRenderer.invoke('qqqide:kope:getHistory', limit, offset, keyword),
        getStats: () => ipcRenderer.invoke('qqqide:kope:getStats'),
        togglePin: (id: number) => ipcRenderer.invoke('qqqide:kope:togglePin', id),
        deleteItem: (id: number) => ipcRenderer.invoke('qqqide:kope:deleteItem', id),
    },


};

contextBridge.exposeInMainWorld('qqqideBridge', QQQ);
