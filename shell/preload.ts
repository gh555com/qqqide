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

    // ---- file system (proxied to engine subprocess) ----
    fs: {
        read: (p: string) => ipcRenderer.invoke('qqqide:fs:read', p),
        readBase64: (p: string) => ipcRenderer.invoke('qqqide:fs:readBase64', p),
        write: (p: string, content: string | Buffer) => ipcRenderer.invoke('qqqide:fs:write', p, content),
        writeBase64: (p: string, base64: string) => ipcRenderer.invoke('qqqide:fs:writeBase64', p, base64),
        list: async (p: string) => {
            const result: string[] = await ipcRenderer.invoke('qqqide:fs:list', p, new Error('fs.list caller').stack);
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
        isMaximized: () => ipcRenderer.invoke('qqqide:window:isMaximized'),
        setTitle: (s: string) => ipcRenderer.invoke('qqqide:window:setTitle', s),
        toggleDevTools: () => ipcRenderer.invoke('qqqide:window:toggleDevTools'),
        new: (folderPath?: string) => ipcRenderer.invoke('qqqide:window:new', folderPath),
        claimProject: (projectRoot: string) => ipcRenderer.invoke('qqqide:window:claimProject', projectRoot),
        releaseProject: (projectRoot: string) => ipcRenderer.invoke('qqqide:window:releaseProject', projectRoot),
        adjustBounds: (deltaLeft: number, deltaRight: number) => ipcRenderer.invoke('qqqide:window:adjust-bounds', deltaLeft, deltaRight),
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

    // ---- clipboard ----
    clipboard: {
        readText: () => ipcRenderer.invoke('qqqide:clipboard:readText'),
        writeText: (s: string) => ipcRenderer.invoke('qqqide:clipboard:writeText', s),
        readImage: () => ipcRenderer.invoke('qqqide:clipboard:readImage'),
        hasImage: () => ipcRenderer.invoke('qqqide:clipboard:hasImage'),
    },

    // ---- ghrun (qz process manager) ----
    ghrun: {
        exec: (cmd: string, args: string[], opts?: any) => ipcRenderer.invoke('qqqide:ghrun:exec', cmd, args, opts),
        isAlive: () => ipcRenderer.invoke('qqqide:ghrun:isAlive'),
    },

    // ---- qz unified spawn (canonical entry; ghrun/runner.py/node fallback) ----
    qz: {
        spawn: (brief: any) => ipcRenderer.invoke('qqqide:qz:spawn', brief),
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
        replace: (opts: { replacements: Array<{ file: string; line: number; col: number; matchLen: number; replacement: string }> }) => ipcRenderer.invoke('qqqide:search:replace', opts),
    },

    // ---- ai (one-shot AI calls for hover, inline completions, etc.) ----
    ai: {
        hover: (context: string) => ipcRenderer.invoke('qqqide:ai:hover', context),
        search_text: (args: { query: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqqide:ai:search_text', args),
        find_files: (args: { pattern: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqqide:ai:find_files', args),
        list_files: (args: { path: string; maxResults?: number; timeoutMs?: number }) => ipcRenderer.invoke('qqqide:ai:list_files', args),
        read_file: (args: { path: string; start_line?: number; end_line?: number }) => ipcRenderer.invoke('qqqide:ai:read_file', args),
        edit_file: (args: { path: string; edits: Array<{ find: string; replace: string; replace_all?: boolean }> }) => ipcRenderer.invoke('qqqide:ai:edit_file', args),
        create_file: (args: { path: string; content: string }) => ipcRenderer.invoke('qqqide:ai:create_file', args),
        delete_file: (args: { path: string }) => ipcRenderer.invoke('qqqide:ai:delete_file', args),
        write_file: (args: { path: string; content: string }) => ipcRenderer.invoke('qqqide:ai:write_file', args),
        generate_image: (args: { prompt: string; style?: string; size?: string; n?: number; out_dir?: string }) => ipcRenderer.invoke('qqqide:ai:generate_image', args),
        analyze_image: (args: { image: string; action: string; detail?: string; targets?: string; question?: string }) => ipcRenderer.invoke('qqqide:ai:analyze_image', args),
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

    // ---- state (唯一真理持久化机器: doc/blob/log via shell/state-store.ts) ----
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

    // ---- qg (FS project-level state, per-project .qqq/qg/ instances) ----
    qg: {
        register: (rootDir: string, ns: string, schema: any) => ipcRenderer.invoke('qqqide:qg:register', rootDir, ns, schema),
        get: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:qg:get', rootDir, ns, key),
        set: (rootDir: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:qg:set', rootDir, ns, key, value),
        setNow: (rootDir: string, ns: string, key: string, value: any) => ipcRenderer.invoke('qqqide:qg:setNow', rootDir, ns, key, value),
        append: (rootDir: string, ns: string, key: string, event: any) => ipcRenderer.invoke('qqqide:qg:append', rootDir, ns, key, event),
        del: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:qg:del', rootDir, ns, key),
        list: (rootDir: string, ns: string) => ipcRenderer.invoke('qqqide:qg:list', rootDir, ns),
        flush: (rootDir: string) => ipcRenderer.invoke('qqqide:qg:flush', rootDir),
        stats: (rootDir: string) => ipcRenderer.invoke('qqqide:qg:stats', rootDir),
        flushOne: (rootDir: string, ns: string, key: string) => ipcRenderer.invoke('qqqide:qg:flushOne', rootDir, ns, key),
        onChange: (cb: (msg: { rootDir: string; ns: string; key: string; value: any; deleted: boolean }) => void) => {
            const handler = (_e: any, msg: any) => { try { cb(msg); } catch (err) { console.warn('[qg.onChange]', err); } };
            ipcRenderer.on('qqqide:qg:changed', handler);
            return () => ipcRenderer.removeListener('qqqide:qg:changed', handler);
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
        openDiffWindow: (args: { filePath: string; beforeBlobHash?: string; afterBlobHash?: string; projectRoot: string }) => ipcRenderer.invoke('qqqide:open-diff-window', args),
        // 监听主进程推送的 diff 更新（复用已有窗口时触发）
        onDiffUpdate: (cb: (data: { beforeBlobHash?: string; afterBlobHash?: string }) => void) => {
            const handler = (_e: any, data: any) => { try { cb(data); } catch (err) { console.warn('[timeline.onDiffUpdate]', err); } };
            ipcRenderer.on('qqqide:diff:update', handler);
            return () => ipcRenderer.removeListener('qqqide:diff:update', handler);
        },
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
};

contextBridge.exposeInMainWorld('qqqideBridge', QQQ);
