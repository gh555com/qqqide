// ============================================================================
// preload.ts
// Bridges renderer (remote web app loaded from server) to main process via
// a strict contextBridge whitelist. NO arbitrary IPC. NO node integration.
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron';

const QQQ = {
    // ---- app info ----
    app: {
        root: () => ipcRenderer.invoke('qqq:app:root'),
    },

    // ---- file system (proxied to engine subprocess) ----
    fs: {
        read: (p: string) => ipcRenderer.invoke('qqq:fs:read', p),
        readBase64: (p: string) => ipcRenderer.invoke('qqq:fs:readBase64', p),
        write: (p: string, content: string | Buffer) => ipcRenderer.invoke('qqq:fs:write', p, content),
        writeBase64: (p: string, base64: string) => ipcRenderer.invoke('qqq:fs:writeBase64', p, base64),
        list: async (p: string) => {
            const result: string[] = await ipcRenderer.invoke('qqq:fs:list', p, new Error('fs.list caller').stack);
            if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'string') {
                return result.map((s: string) => ({
                    name: s.endsWith('/') ? s.slice(0, -1) : s,
                    isDir: s.endsWith('/')
                }));
            }
            return result;
        },
        stat: (p: string) => ipcRenderer.invoke('qqq:fs:stat', p),
        exists: (p: string) => ipcRenderer.invoke('qqq:fs:exists', p),
        mkdir: (p: string) => ipcRenderer.invoke('qqq:fs:mkdir', p),
        remove: (p: string) => ipcRenderer.invoke('qqq:fs:remove', p),
        rename: (oldP: string, newP: string) => ipcRenderer.invoke('qqq:fs:rename', oldP, newP),
        drives: () => ipcRenderer.invoke('qqq:fs:drives'),
        diskFree: (d: string[]) => ipcRenderer.invoke('qqq:fs:diskFree', d),
    },

    // ---- dialogs ----
    dialog: {
        open: (opts?: any) => ipcRenderer.invoke('qqq:dialog:open', opts),
        save: (opts?: any) => ipcRenderer.invoke('qqq:dialog:save', opts),
        message: (opts?: any) => ipcRenderer.invoke('qqq:dialog:message', opts),
    },

    // ---- asset-roots: extend the qqq-asset://file/ whitelist at runtime ----
    assetRoots: {
        add: (absDir: string) => ipcRenderer.invoke('qqq:assetRoots:add', absDir),
        list: () => ipcRenderer.invoke('qqq:assetRoots:list'),
        remove: (absDir: string) => ipcRenderer.invoke('qqq:assetRoots:remove', absDir),
    },

    // ---- window controls ----
    window: {
        minimize: () => ipcRenderer.invoke('qqq:window:minimize'),
        maximize: () => ipcRenderer.invoke('qqq:window:maximize'),
        unmaximize: () => ipcRenderer.invoke('qqq:window:unmaximize'),
        close: () => ipcRenderer.invoke('qqq:window:close'),
        isMaximized: () => ipcRenderer.invoke('qqq:window:isMaximized'),
        setTitle: (s: string) => ipcRenderer.invoke('qqq:window:setTitle', s),
        toggleDevTools: () => ipcRenderer.invoke('qqq:window:toggleDevTools'),
        new: (folderPath?: string) => ipcRenderer.invoke('qqq:window:new', folderPath),
        claimProject: (projectRoot: string) => ipcRenderer.invoke('qqq:window:claimProject', projectRoot),
        releaseProject: (projectRoot: string) => ipcRenderer.invoke('qqq:window:releaseProject', projectRoot),
    },

    // ---- zoom (UI scale) ----
    zoom: {
        get: () => ipcRenderer.invoke('qqq:zoom:get'),
        set: (factor: number) => ipcRenderer.invoke('qqq:zoom:set', factor),
        adjust: (delta: number) => ipcRenderer.invoke('qqq:zoom:adjust', delta),
        onChanged: (cb: (factor: number) => void) => {
            const handler = (_e: any, factor: number) => cb(factor);
            ipcRenderer.on('qqq:zoom:changed', handler);
            return () => ipcRenderer.removeListener('qqq:zoom:changed', handler);
        },
    },

    // ---- native menu (server-pushed JSON schema -> Electron Menu) ----
    menu: {
        set: (schema: any) => ipcRenderer.invoke('qqq:menu:set', schema),
        onFired: (cb: (cmd: string) => void) => {
            const handler = (_e: any, cmd: string) => cb(cmd);
            ipcRenderer.on('qqq:menu:fired', handler);
            return () => ipcRenderer.removeListener('qqq:menu:fired', handler);
        },
    },

    // ---- monaco editor pool (in-shell instances) ----
    monaco: {
        create: (opts?: any) => ipcRenderer.invoke('qqq:monaco:create', opts),
        open: (id: number, file: string) => ipcRenderer.invoke('qqq:monaco:open', id, file),
        save: (id: number) => ipcRenderer.invoke('qqq:monaco:save', id),
        dispose: (id: number) => ipcRenderer.invoke('qqq:monaco:dispose', id),
    },

    // ---- generic engine RPC (Rust/Python/Node subprocesses) ----
    engine: {
        invoke: (method: string, params?: any) => ipcRenderer.invoke('qqq:engine:invoke', method, params),
        isAlive: () => ipcRenderer.invoke('qqq:engine:isAlive'),
    },

    // ---- audio (will route to miniaudio_v16.py) ----
    audio: {
        play: (file: string, opts?: any) => ipcRenderer.invoke('qqq:audio:play', file, opts),
        stop: (scope?: string) => ipcRenderer.invoke('qqq:audio:stop', scope),
        invoke: (action: string, params?: any) => ipcRenderer.invoke('qqq:audio:invoke', action, params),
        isAlive: () => ipcRenderer.invoke('qqq:audio:isAlive'),
    },

    // ---- system shell ----
    shell: {
        openExternal: (url: string) => ipcRenderer.invoke('qqq:shell:openExternal', url),
        openPath: (p: string) => ipcRenderer.invoke('qqq:shell:openPath', p),
    },

    // ---- 外嵌 AI 面板 ----
    aiPanel: {
        toggleExternal: (index: number, open: boolean) => ipcRenderer.invoke('qqq:ai-panel:toggle-external', index, open),
    },

    // ---- 跨窗口同步 IPC（替代 BroadcastChannel，终极架构 §C）----
    sync: {
        // 广播消息到所有其他窗口（主进程中转）。静默吞错——广播是 best-effort。
        broadcast: (channel: string, data: any) => ipcRenderer.invoke('qqq:sync:broadcast', channel, data).catch(() => {}),
        // 订阅来自其他窗口的消息。返回 unsubscribe 函数。
        onMessage: (cb: (channel: string, data: any) => void) => {
            const handler = (_e: any, channel: string, data: any) => {
                try { cb(channel, data); } catch (err) { console.warn('[sync.onMessage]', err); }
            };
            ipcRenderer.on('qqq:sync:message', handler);
            return () => { ipcRenderer.removeListener('qqq:sync:message', handler); };
        },
        // 获取/设置项目路径（僚机初始化用）
        getProjectPath: () => ipcRenderer.invoke('qqq:sync:get-project-path'),
        setProjectPath: (p: string) => ipcRenderer.invoke('qqq:sync:set-project-path', p).catch(() => {}),
        // 获取主窗口当前主题（僚机初始化用）
        getTheme: () => ipcRenderer.invoke('qqq:sync:get-theme'),
    },

    // ---- clipboard ----
    clipboard: {
        readText: () => ipcRenderer.invoke('qqq:clipboard:readText'),
        writeText: (s: string) => ipcRenderer.invoke('qqq:clipboard:writeText', s),
        readImage: () => ipcRenderer.invoke('qqq:clipboard:readImage'),
        hasImage: () => ipcRenderer.invoke('qqq:clipboard:hasImage'),
    },

    // ---- ghrun (qz process manager) ----
    ghrun: {
        exec: (cmd: string, args: string[], opts?: any) => ipcRenderer.invoke('qqq:ghrun:exec', cmd, args, opts),
        isAlive: () => ipcRenderer.invoke('qqq:ghrun:isAlive'),
    },

    // ---- qz unified spawn (canonical entry; ghrun/runner.py/node fallback) ----
    qz: {
        spawn: (brief: any) => ipcRenderer.invoke('qqq:qz:spawn', brief),
        which: (cmd: string) => ipcRenderer.invoke('qqq:qz:which', cmd),
        ghrunAlive: () => ipcRenderer.invoke('qqq:qz:ghrunAlive'),
        runnerAlive: () => ipcRenderer.invoke('qqq:qz:runnerAlive'),
    },

    // ---- lsp (language intelligence — spawns language servers for diagnostics) ----
    lsp: {
        startLanguage: (lang: string, rootUri: string) => ipcRenderer.invoke('qqq:lsp:startLanguage', lang, rootUri),
        stopLanguage: (lang: string) => ipcRenderer.invoke('qqq:lsp:stopLanguage', lang),
        openDocument: (filePath: string, text: string) => ipcRenderer.invoke('qqq:lsp:openDocument', filePath, text),
        changeDocument: (filePath: string, changes: any[], version: number) => ipcRenderer.invoke('qqq:lsp:changeDocument', filePath, changes, version),
        closeDocument: (filePath: string) => ipcRenderer.invoke('qqq:lsp:closeDocument', filePath),
        hover: (filePath: string, line: number, character: number) => ipcRenderer.invoke('qqq:lsp:hover', filePath, line, character),
        getDiagnostics: (uri: string) => ipcRenderer.invoke('qqq:lsp:getDiagnostics', uri),
        activeLanguages: () => ipcRenderer.invoke('qqq:lsp:activeLanguages'),
        onDiagnostics: (cb: (msg: { uri: string; diagnostics: any[] }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[lsp.onDiagnostics]', err); } };
            ipcRenderer.on('qqq:lsp:diagnostics', handler);
            return () => ipcRenderer.removeListener('qqq:lsp:diagnostics', handler);
        },
    },

    // ---- ai (one-shot AI calls for hover, inline completions, etc.) ----
    ai: {
        hover: (context: string) => ipcRenderer.invoke('qqq:ai:hover', context),
        search_text: (args: { query: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqq:ai:search_text', args),
        find_files: (args: { pattern: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqq:ai:find_files', args),
        list_files: (args: { path: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqq:ai:list_files', args),
        read_file: (args: { path: string; start_line?: number; end_line?: number }) => ipcRenderer.invoke('qqq:ai:read_file', args),
        edit_file: (args: { path: string; edits: Array<{ find: string; replace: string; replace_all?: boolean }> }) => ipcRenderer.invoke('qqq:ai:edit_file', args),
        create_file: (args: { path: string; content: string }) => ipcRenderer.invoke('qqq:ai:create_file', args),
        delete_file: (args: { path: string }) => ipcRenderer.invoke('qqq:ai:delete_file', args),
        write_file: (args: { path: string; content: string }) => ipcRenderer.invoke('qqq:ai:write_file', args),
    },

    // ---- cache (KV + bucketed file cache rooted at portable.cache) ----
    cache: {
        get: (key: string) => ipcRenderer.invoke('qqq:cache:get', key),
        put: (key: string, value: any, opts?: any) => ipcRenderer.invoke('qqq:cache:put', key, value, opts),
        has: (key: string) => ipcRenderer.invoke('qqq:cache:has', key),
        delete: (key: string) => ipcRenderer.invoke('qqq:cache:delete', key),
        path: (key: string) => ipcRenderer.invoke('qqq:cache:path', key),
        bucketPath: (sig: string, ext?: string) => ipcRenderer.invoke('qqq:cache:bucketPath', sig, ext),
    },

    // ---- state (唯一真理持久化机器: doc/blob/log via shell/state-store.ts) ----
    state: {
        register: (ns: string, schema: any) => ipcRenderer.invoke('qqq:state:register', ns, schema),
        get: (ns: string, key: string) => ipcRenderer.invoke('qqq:state:get', ns, key),
        set: (ns: string, key: string, value: any) => ipcRenderer.invoke('qqq:state:set', ns, key, value),
        setNow: (ns: string, key: string, value: any) => ipcRenderer.invoke('qqq:state:setNow', ns, key, value),
        append: (ns: string, key: string, event: any) => ipcRenderer.invoke('qqq:state:append', ns, key, event),
        del: (ns: string, key: string) => ipcRenderer.invoke('qqq:state:del', ns, key),
        list: (ns: string) => ipcRenderer.invoke('qqq:state:list', ns),
        flush: () => ipcRenderer.invoke('qqq:state:flush'),
        flushOne: (ns: string, key: string) => ipcRenderer.invoke('qqq:state:flushOne', ns, key),
        stats: () => ipcRenderer.invoke('qqq:state:stats'),
        sql: (query: string, params?: any[]) => ipcRenderer.invoke('qqq:state:sql', query, params),
        cloud: {
            pull: () => ipcRenderer.invoke('qqq:state:cloud:pull'),
            push: () => ipcRenderer.invoke('qqq:state:cloud:push'),
            sync: () => ipcRenderer.invoke('qqq:state:cloud:sync'),
        },
        // Subscribe to any (ns,key) change. Returns an unsubscribe fn.
        onChange: (cb: (msg: { ns: string; key: string; value: any; deleted: boolean }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[state.onChange]', err); } };
            ipcRenderer.on('qqq:state:changed', handler);
            return () => ipcRenderer.removeListener('qqq:state:changed', handler);
        },
        // Project-level SQLite (quest.sq3) — separate DB per dbPath
        project: {
            register: (dbPath: string, ns: string, schema: any) => ipcRenderer.invoke('qqq:state:project:register', dbPath, ns, schema),
            get: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqq:state:project:get', dbPath, ns, key),
            set: (dbPath: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqq:state:project:set', dbPath, ns, key, value),
            setNow: (dbPath: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqq:state:project:setNow', dbPath, ns, key, value),
            append: (dbPath: string, ns: string, key: string, event: any) => ipcRenderer.invoke('qqq:state:project:append', dbPath, ns, key, event),
            del: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqq:state:project:del', dbPath, ns, key),
            list: (dbPath: string, ns: string) => ipcRenderer.invoke('qqq:state:project:list', dbPath, ns),
            flush: (dbPath: string) => ipcRenderer.invoke('qqq:state:project:flush', dbPath),
            flushOne: (dbPath: string, ns: string, key: string) => ipcRenderer.invoke('qqq:state:project:flushOne', dbPath, ns, key),
            stats: (dbPath: string) => ipcRenderer.invoke('qqq:state:project:stats', dbPath),
            onChange: (dbPath: string, cb: (msg: { dbPath: string; ns: string; key: string; value: any; deleted: boolean }) => void) => {
                const handler = (_e: any, msg: any) => { if (msg && msg.dbPath === dbPath) { try { cb(msg); } catch (err) { console.warn('[state.project.onChange]', err); } } };
                ipcRenderer.on('qqq:state:project:changed', handler);
                return () => ipcRenderer.removeListener('qqq:state:project:changed', handler);
            },
        },
    },

    // ---- qg (FS project-level state, per-project .qqq/qg/ instances) ----
    qg: {
        register: (rootDir: string, ns: string, schema: any) => ipcRenderer.invoke('qqq:qg:register', rootDir, ns, schema),
        get: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqq:qg:get', rootDir, ns, key),
        set: (rootDir: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqq:qg:set', rootDir, ns, key, value),
        setNow: (rootDir: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqq:qg:setNow', rootDir, ns, key, value),
        append: (rootDir: string, ns: string, key: string, event: any) => ipcRenderer.invoke('qqq:qg:append', rootDir, ns, key, event),
        del: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqq:qg:del', rootDir, ns, key),
        list: (rootDir: string, ns: string) => ipcRenderer.invoke('qqq:qg:list', rootDir, ns),
        flush: (rootDir: string) => ipcRenderer.invoke('qqq:qg:flush', rootDir),
        stats: (rootDir: string) => ipcRenderer.invoke('qqq:qg:stats', rootDir),
        flushOne: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqq:qg:flushOne', rootDir, ns, key),
        onChange: (cb: (msg: { rootDir: string; ns: string; key: string; value: any; deleted: boolean }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[qg.onChange]', err); } };
            ipcRenderer.on('qqq:qg:changed', handler);
            return () => ipcRenderer.removeListener('qqq:qg:changed', handler);
        },
    },

    // ---- hash (xxh64 fast + sha256 strong, with mtime cache) ----
    hash: {
        file: (p: string, mode?: 'fast' | 'strong' | 'both') => ipcRenderer.invoke('qqq:hash:file', p, mode),
        buffer: (b64: string, mode?: 'fast' | 'strong' | 'both') => ipcRenderer.invoke('qqq:hash:buffer', b64, mode),
    },

    // ---- media (ffmpeg-backed thumbnail / transcode / probe via qz) ----
    media: {
        thumb: (opts: any) => ipcRenderer.invoke('qqq:media:thumb', opts),
        transcode: (opts: any) => ipcRenderer.invoke('qqq:media:transcode', opts),
        probe: (src: string) => ipcRenderer.invoke('qqq:media:probe', src),
        ffmpegPath: () => ipcRenderer.invoke('qqq:media:ffmpegPath'),
    },

    // ---- key (global shortcut bridge; per-window/iframe handled in renderer) ----
    key: {
        registerGlobal: (accel: string, id: string) => ipcRenderer.invoke('qqq:key:registerGlobal', accel, id),
        unregisterGlobal: (accel: string) => ipcRenderer.invoke('qqq:key:unregisterGlobal', accel),
        unregisterAllGlobal: () => ipcRenderer.invoke('qqq:key:unregisterAllGlobal'),
        onGlobal: (cb: (msg: { id: string; accel: string }) => void) => {
            const handler = (_e: any, msg: any) => cb(msg);
            ipcRenderer.on('qqq:key:global', handler);
            return () => ipcRenderer.removeListener('qqq:key:global', handler);
        },
    },

    // ---- download (SmartHttpDownloader via shell/download-service.ts) ----
    download: {
        start: (opts: any) => ipcRenderer.invoke('qqq:download:start', opts),
        cancel: (id: string) => ipcRenderer.invoke('qqq:download:cancel', id),
        list: () => ipcRenderer.invoke('qqq:download:list'),
        onProgress: (cb: (entry: any) => void) => {
            const handler = (_e: any, entry: any) => { try { cb(entry); } catch (err) { console.warn('[download.onProgress]', err); } };
            ipcRenderer.on('qqq:download:progress', handler);
            return () => ipcRenderer.removeListener('qqq:download:progress', handler);
        },
    },

    // ---- update (hot reload: pull server-app.tar.xz from gh555.com) ----
    update: {
        check: () => ipcRenderer.invoke('qqq:update:check'),
        apply: () => ipcRenderer.invoke('qqq:update:apply'),
        state: () => ipcRenderer.invoke('qqq:update:state'),
        abort: () => ipcRenderer.invoke('qqq:update:abort'),
        upgradeShell: () => ipcRenderer.invoke('qqq:update:upgrade-shell'),
    },

    // ---- boot info (read once on startup) ----
    boot: {
        getInfo: () => ipcRenderer.invoke('qqq:boot:info'),
        retry: () => ipcRenderer.invoke('qqq:boot:retry'),
        probe: () => ipcRenderer.invoke('qqq:boot:probe'),
    },
};

contextBridge.exposeInMainWorld('qqq', QQQ);
