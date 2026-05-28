// ============================================================================
// qqq-video.js - Video download via yt-dlp (through ghrun/qz)
//
// Detects video URLs in /\ url \/ markers, provides CodeLens "download" button.
// Spawns yt-dlp via bridge.engine.invoke → ghrun qz spawn.
// Shows progress in statusbar.
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqBridge;

  // URL patterns recognized as downloadable video
  const VIDEO_URL_PATTERNS = [
    /https?:\/\/(www\.)?youtube\.com\/watch\?v=/i,
    /https?:\/\/youtu\.be\//i,
    /https?:\/\/(www\.)?bilibili\.com\/video\//i,
    /https?:\/\/(www\.)?twitter\.com\/.*\/status\//i,
    /https?:\/\/(www\.)?x\.com\/.*\/status\//i,
    /https?:\/\/(www\.)?vimeo\.com\//i,
    /https?:\/\/(www\.)?dailymotion\.com\//i,
    /https?:\/\/(www\.)?twitch\.tv\//i,
    /https?:\/\/.*\.(mp4|mkv|webm|m3u8)/i,
  ];

  function isVideoUrl(url) {
    if (!url) return false;
    for (let i = 0; i < VIDEO_URL_PATTERNS.length; i++) {
      if (VIDEO_URL_PATTERNS[i].test(url)) return true;
    }
    return false;
  }

  const CMD_DOWNLOAD_VIDEO = 'qqq.video.download';
  let _disposables = [];
  let _downloading = false;

  function updateStatus(text) {
    const el = document.getElementById('qqq-status-engine');
    if (el) el.textContent = text;
  }

  async function downloadVideo(url) {
    if (_downloading) {
      updateStatus('⚠️ download busy');
      return;
    }
    _downloading = true;
    updateStatus('⬇️ downloading...');

    // Determine output directory (same as current file or fallback)
    let outputDir = '.';
    const currentFile = window.qqqEditor.currentFile();
    if (currentFile) {
      const sep = currentFile.includes('\\') ? '\\' : '/';
      outputDir = currentFile.slice(0, currentFile.lastIndexOf(sep));
    }

    try {
      // Invoke via engine/ghrun - spawn yt-dlp
      const result = await bridge.engine.invoke('spawn', {
        cmd: 'yt-dlp',
        args: [
          '--no-playlist',
          '-o', outputDir + '/%(title)s.%(ext)s',
          url
        ],
        timeout: 600000, // 10 minutes max
      });

      if (result && result.exitCode === 0) {
        updateStatus('✅ download done');
        // Insert path reference if we got output filename
        if (result.stdout) {
          const destMatch = result.stdout.match(/Destination:\s*(.+)/);
          const mergeMatch = result.stdout.match(/Merging formats into "(.+?)"/);
          const alreadyMatch = result.stdout.match(/has already been downloaded/);
          const outputPath = mergeMatch?.[1] || destMatch?.[1] || null;
          if (outputPath) {
            window.qqqEditor.insertAtCursor('/\\ ' + outputPath.trim() + ' \\/\n');
          }
        }
      } else {
        const errMsg = result?.stderr?.slice(0, 100) || 'unknown error';
        updateStatus('❌ ' + errMsg);
        console.error('[qqq-video] download failed:', result);
      }
    } catch (e) {
      updateStatus('❌ ' + (e.message || 'spawn failed'));
      console.error('[qqq-video] error:', e);
    } finally {
      _downloading = false;
      // Clear status after 5s
      setTimeout(function () {
        updateStatus('engine ✓');
      }, 5000);
    }
  }

  function init() {
    const monaco = window.qqqEditor.getMonaco();
    const ed = window.qqqEditor.getEditorInstance();
    if (!monaco || !ed) {
      setTimeout(init, 500);
      return;
    }

    // Register download action
    ed.addAction({
      id: CMD_DOWNLOAD_VIDEO,
      label: 'QQQ: Download Video',
      run: function (_ed, url) {
        if (url) {
          downloadVideo(url);
        }
      }
    });

    // Register CodeLens provider that detects video URLs
    const PATH_REGEX = /\/\\\s*([\s\S]*?)\s*\\\//gi;

    const provider = monaco.languages.registerCodeLensProvider('*', {
      provideCodeLenses: function (model, _token) {
        const lenses = [];
        const text = model.getValue();
        const regex = new RegExp(PATH_REGEX.source, PATH_REGEX.flags);
        let match;

        while ((match = regex.exec(text)) !== null) {
          const rawContent = (match[1] || '').trim();
          if (!rawContent) continue;
          if (!isVideoUrl(rawContent)) continue;

          const offset = match.index;
          const pos = model.getPositionAt(offset);
          const line = pos.lineNumber;

          lenses.push({
            range: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: 1,
            },
            command: {
              id: CMD_DOWNLOAD_VIDEO,
              title: '⬇️ download video',
              arguments: [rawContent],
            }
          });
        }

        return { lenses: lenses, dispose: function () {} };
      },
      resolveCodeLens: function (_model, codeLens, _token) {
        return codeLens;
      }
    });

    _disposables.push(provider);
    console.log('[qqq-video] registered');
  }

  function dispose() {
    _disposables.forEach(function (d) { d.dispose(); });
    _disposables = [];
    _downloading = false;
  }

  window.qqqVideo = { init, dispose, downloadVideo };

  // rage service protocol
  window.qqqRageVideo = {
    start: function (ctx) { init(); },
    stop: function () { dispose(); },
  };
})();
