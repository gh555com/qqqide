// ============================================================================
// qqq-codelens.js - Monaco CodeLens provider for path recognition
//
// Scans editor content for /\ path \/ markers and shows action buttons above.
// Uses monaco.languages.registerCodeLensProvider (native Monaco API, no ext host).
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqideBridge;

  // The qqq path delimiter regex: /\ content \/
  const PATH_REGEX = /\/\\\s*([\s\S]*?)\s*\\\//gi;

  // File extension categories
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.avif']);
  const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.ts', '.mpg']);
  const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus']);

  function isImageExt(ext) { return IMAGE_EXTS.has(ext); }
  function isVideoExt(ext) { return VIDEO_EXTS.has(ext); }
  function isAudioExt(ext) { return AUDIO_EXTS.has(ext); }
  function isMediaExt(ext) { return isImageExt(ext) || isVideoExt(ext) || isAudioExt(ext); }

  function getExt(filePath) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0) return '';
    return filePath.slice(dot).toLowerCase();
  }

  // Resolve path: if relative, resolve against current file's directory
  function resolvePath(rawPath) {
    const trimmed = rawPath.trim().replace(/\r?\n/g, '');
    if (!trimmed) return null;
    // If it's already absolute (Windows or Unix)
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
      return trimmed;
    }
    // Relative path: resolve against current file
    const currentFile = window.qqqEditor.currentFile();
    if (!currentFile) return null;
    const sep = currentFile.includes('\\') ? '\\' : '/';
    const dir = currentFile.slice(0, currentFile.lastIndexOf(sep));
    return dir + sep + trimmed.replace(/[/\\]/g, sep);
  }

  // Format bytes to human readable
  function formatBytes(bytes) {
    if (bytes == null) return '?';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  // Command IDs
  const CMD_OPEN_FILE = 'qqq.codelens.openFile';
  const CMD_REVEAL_FOLDER = 'qqq.codelens.revealFolder';
  const CMD_COPY_PATH = 'qqq.codelens.copyPath';
  const CMD_DOWNLOAD = 'qqq.codelens.download';
  const CMD_TRANSCODE = 'qqq.codelens.transcode';

  // Statusbar helper for download progress
  function updateCodeLensStatus(text) {
    var el = document.getElementById('qqq-status-engine');
    if (el) el.textContent = text || 'engine ✓';
  }

  let _disposables = [];
  let _commandsRegistered = false;

  function registerCommands(editor, monaco) {
    if (_commandsRegistered) return;
    _commandsRegistered = true;

    // Open file command
    editor.addAction({
      id: CMD_OPEN_FILE,
      label: 'QQQ: Open File',
      run: function (_ed, absPath) {
        if (!absPath) return;
        const ext = getExt(absPath);
        if (isImageExt(ext) || isVideoExt(ext)) {
          // Open externally for media
          if (bridge.shell && bridge.shell.openPath) {
            bridge.shell.openPath(absPath);
          }
        } else {
          // Open in editor
          window.qqqEditor.open(absPath);
        }
      }
    });

    // Reveal folder command
    editor.addAction({
      id: CMD_REVEAL_FOLDER,
      label: 'QQQ: Reveal in Folder',
      run: function (_ed, absPath) {
        if (!absPath) return;
        if (bridge.shell && bridge.shell.openPath) {
          // Open the containing folder
          const sep = absPath.includes('\\') ? '\\' : '/';
          const folder = absPath.slice(0, absPath.lastIndexOf(sep));
          bridge.shell.openPath(folder);
        }
      }
    });

    // Copy path command
    editor.addAction({
      id: CMD_COPY_PATH,
      label: 'QQQ: Copy Path',
      run: function (_ed, absPath) {
        if (!absPath) return;
        navigator.clipboard.writeText(absPath).catch(() => {});
      }
    });

    // Download (video URL): via bridge.download (shell/download-service.ts)
    editor.addAction({
      id: CMD_DOWNLOAD,
      label: 'QQQ: Download Video',
      run: function (_ed, url) {
        if (!url) return;
        if (!bridge.download || !bridge.download.start) {
          if (bridge.shell && bridge.shell.openExternal) bridge.shell.openExternal(url);
          return;
        }
        var entry = bridge.download.start({ url: url });
        if (!entry) return;
        updateCodeLensStatus('⬇ downloading... ' + (entry.filePath || '').split(/[\\/]/).pop());
        // Watch progress; when done, insert token
        var off = bridge.download.onProgress(function (e) {
          if (e.id !== entry.id) return;
          if (e.error) {
            updateCodeLensStatus('❌ ' + e.error.slice(0, 60));
            if (off) off();
            return;
          }
          if (e.done) {
            updateCodeLensStatus('✅ download done');
            if (e.filePath && window.qqqEditor && window.qqqEditor.insertAtCursor) {
              window.qqqEditor.insertAtCursor('/\\ ' + e.filePath + ' \\/\n');
            }
            if (off) off();
            setTimeout(function () { updateCodeLensStatus(''); }, 5000);
            return;
          }
          var pct = e.totalBytes > 0 ? Math.round(e.bytesDone / e.totalBytes * 100) : '?';
          updateCodeLensStatus('⬇ ' + pct + '% ' + (e.filePath || '').split(/[\\/]/).pop());
        });
      }
    });

    // Transcode (audio / video): pop a save dialog and invoke media.transcode
    editor.addAction({
      id: CMD_TRANSCODE,
      label: 'QQQ: Transcode (ffmpeg)',
      run: async function (_ed, absPath) {
        if (!absPath || !bridge.media || !bridge.media.transcode) return;
        try {
          const ext = getExt(absPath);
          const target = isAudioExt(ext) ? 'mp3' : 'mp4';
          const out = await bridge.media.transcode({ src: absPath, format: target });
          if (out && out.path) {
            // [silent] qqq-codelens transcoded
            navigator.clipboard.writeText(out.path).catch(() => {});
          }
        } catch (e) { console.warn('[qqq-codelens] transcode:', e); }
      }
    });
  }

  function init() {
    const monaco = window.qqqEditor.getMonaco();
    const ed = window.qqqEditor.getEditorInstance();
    if (!monaco || !ed) {
      // Retry after a short delay (editor may not be ready yet)
      setTimeout(init, 500);
      return;
    }

    attach(ed);
  }

  // attach(editor): register commands on this editor; provider is global once.
  let _providerRegistered = false;
  function attach(ed) {
    const monaco = window.qqqEditor.getMonaco();
    if (!monaco || !ed) return null;
    registerCommands(ed, monaco);
    if (_providerRegistered) return null;
    _providerRegistered = true;

    // Register CodeLens provider for all languages
    const provider = monaco.languages.registerCodeLensProvider('*', {
      provideCodeLenses: function (model, _token) {
        const lenses = [];
        const text = model.getValue();
        const regex = new RegExp(PATH_REGEX.source, PATH_REGEX.flags);
        let match;

        while ((match = regex.exec(text)) !== null) {
          const rawPath = (match[1] || '').trim();
          if (!rawPath) continue;

          const absPath = resolvePath(rawPath);
          if (!absPath) continue;

          // Calculate line number from match index
          const offset = match.index;
          const pos = model.getPositionAt(offset);
          const line = pos.lineNumber;

          const ext = getExt(absPath);
          let icon = '📄';
          if (isImageExt(ext)) icon = '🖼️';
          else if (isVideoExt(ext)) icon = '🎬';
          else if (isAudioExt(ext)) icon = '🎵';

          const mkLens = (title, cmdId, args) => ({
            range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
            command: { id: cmdId, title, arguments: args },
          });

          lenses.push(mkLens(icon + ' open', CMD_OPEN_FILE, [absPath]));
          lenses.push(mkLens('🗀 folder', CMD_REVEAL_FOLDER, [absPath]));
          lenses.push(mkLens('📋 copy', CMD_COPY_PATH, [absPath]));
          if (isVideoExt(ext) || isAudioExt(ext)) {
            lenses.push(mkLens('🎛 transcode', CMD_TRANSCODE, [absPath]));
          }
          // Download lens: if the raw token looks like an http/https URL
          if (/^https?:\/\//i.test(rawPath) && (isVideoExt(getExt(rawPath)) || /youtube\.com|youtu\.be|bilibili/.test(rawPath))) {
            lenses.push(mkLens('⬇ download', CMD_DOWNLOAD, [rawPath]));
          }
        }

        return { lenses: lenses, dispose: function () {} };
      },

      resolveCodeLens: function (_model, codeLens, _token) {
        return codeLens;
      }
    });

    _disposables.push(provider);
    // [silent] qqq-codelens registered
    return { dispose: () => provider.dispose() };
  }

  function dispose() {
    _disposables.forEach(function (d) { d.dispose(); });
    _disposables = [];
    _commandsRegistered = false;
    _providerRegistered = false;
  }

  window.qqqCodeLens = { init, attach, dispose };

  // rage service protocol
  window.qqqRageCodelens = {
    start: function (ctx) { init(); },
    stop: function () { dispose(); },
  };
})();
