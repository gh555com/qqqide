// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// thumbnail-cache.js — Thumbnail cache pipeline (from q3 ffmpeg pipeline)
//
// Generates thumbnail PNGs for media files, cached to qqq/cache/thumbnails/
//
// Types:
//   images: direct scale to 512x288 (large) / 256x144 (small)
//   video:  ffmpeg extract 1s keyframe then scale
//   audio:  text slide (filename + metadata)
//   text:   ffmpeg text slide (first N lines)
//
// Exposes: window.qqqThumbnailCache
//
// Depends: bridge.fs, bridge.media (ffmpeg component via media-service.ts)
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;

  // ★ 锚定 workspace root（不死绑 CWD，CWD 可能是 app 目录而非项目根目录）
  function _cacheDir() {
    var root = (window._workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
    return root ? root + '/_qqq/cache/thumbnails' : '_qqq/cache/thumbnails';
  }
  var LARGE_W = 512, LARGE_H = 288;
  var SMALL_W = 256, SMALL_H = 144;
  var MAX_CACHE_ENTRIES = 500;

  // In-memory cache
  var _infoCache = {};
  var _pathToSha = {};
  var _pending = {};

  // ═══ Utilities ═══

  function _normPath(p) { return (p || '').replace(/\\/g, '/'); }

  function _ext(name) {
    if (!name) return '';
    var d = name.lastIndexOf('.');
    return d >= 0 ? name.slice(d).toLowerCase() : '';
  }

  // Get SHA256 for a file path
  async function _sha256ForPath(filePath) {
    var np = _normPath(filePath);
    if (_pathToSha[np]) return _pathToSha[np];

    try {
      if (bridge && bridge.hash && bridge.hash.file) {
        var h = await bridge.hash.file(filePath, 'sha256');
        if (h) {
          _pathToSha[np] = h;
          return h;
        }
      }
    } catch (e) { /* */ }

    // Fallback: hash the path
    var hash = '';
    var s = np;
    for (var i = 0; i < s.length; i++) {
      hash += ((s.charCodeAt(i) * 31 + i) & 0xFFFF).toString(16);
    }
    _pathToSha[np] = hash;
    return hash;
  }

  function _cachePath(sha256, size) {
    var prefix = sha256.slice(0, 2);
    return _cacheDir() + '/' + prefix + '/' + sha256 + '_' + size + '.jpg';
  }

  // ═══ Media probe via bridge ═══

  async function _probeMedia(filePath) {
    if (!bridge || !bridge.media || !bridge.media.probe) return null;

    try {
      var info = await bridge.media.probe(filePath);
      if (info && info.ok) {
        return {
          width: info.width || 0,
          height: info.height || 0,
          duration: info.duration || 0,
          size: info.size || 0,
          codec: info.codec || '',
          hasVideo: !!(info.width && info.height),
          hasAudio: !!(info.duration && !info.width),
        };
      }
    } catch (e) {
      console.warn('[thumbnail-cache] probe failed:', filePath, e && e.message);
    }
    return null;
  }

  // ═══ Thumbnail generation via bridge.media.thumb ═══

  async function _generateImageThumb(filePath, sha256, size) {
    var w = size === 'large' ? LARGE_W : SMALL_W;
    var h = size === 'large' ? LARGE_H : SMALL_H;
    var outPath = _cachePath(sha256, size);

    // Check if already cached
    try {
      var exists = await bridge.fs.exists(outPath);
      if (exists) return outPath;
    } catch (e) { /* */ }

    if (!bridge || !bridge.media || !bridge.media.thumb) {
      return null;
    }

    try {
      var result = await bridge.media.thumb({
        src: filePath,
        w: w,
        h: h,
        ts: 0,
        format: 'jpg',
      });
      if (result && result.ok && result.path) return result.path;
    } catch (e) {
      console.warn('[thumbnail-cache] image thumb failed:', filePath, e && e.message);
    }
    return null;
  }

  async function _generateVideoThumb(filePath, sha256, size) {
    var w = size === 'large' ? LARGE_W : SMALL_W;
    var h = size === 'large' ? LARGE_H : SMALL_H;
    var outPath = _cachePath(sha256, size);

    try {
      var exists = await bridge.fs.exists(outPath);
      if (exists) return outPath;
    } catch (e) { /* */ }

    if (!bridge || !bridge.media || !bridge.media.thumb) return null;

    try {
      var result = await bridge.media.thumb({
        src: filePath,
        w: w,
        h: h,
        ts: 1,
        format: 'jpg',
      });
      if (result && result.ok && result.path) return result.path;
    } catch (e) {
      console.warn('[thumbnail-cache] video thumb failed:', filePath, e && e.message);
    }
    return null;
  }

  // ═══ Public API ═══

  // getInfo: probe media file for dimensions/duration/codec
  async function getInfo(filePath) {
    if (!filePath) return null;
    var np = _normPath(filePath);

    try {
      var sha = await _sha256ForPath(filePath);
      if (_infoCache[sha]) return _infoCache[sha];

      var info = await _probeMedia(filePath);
      if (info) {
        try {
          var st = await bridge.fs.stat(filePath);
          if (st && st.size) info.size = st.size;
        } catch (e) { /* */ }
        _infoCache[sha] = info;
        return info;
      }
    } catch (e) {
      console.warn('[thumbnail-cache] getInfo error:', e && e.message);
    }
    return null;
  }

  // getThumbnail: get or generate thumbnail for a media file
  async function getThumbnail(filePath, size) {
    if (!filePath) return null;
    size = size || 'large';
    var ext = _ext(filePath).toLowerCase();

    try {
      var sha = await _sha256ForPath(filePath);
      var cacheFile = _cachePath(sha, size);

      // Check disk cache
      try {
        var exists = await bridge.fs.exists(cacheFile);
        if (exists) return cacheFile;
      } catch (e) { /* */ }

      // Dedup pending generations
      var dedupKey = sha + '_' + size;
      if (_pending[dedupKey]) return _pending[dedupKey];

      var imgExts = ['.png','.jpg','.jpeg','.gif','.bmp','.webp','.tiff','.avif'];
      var vidExts = ['.mp4','.mkv','.avi','.mov','.webm','.flv','.wmv','.m4v','.ts','.mpg'];

      var promise;
      if (imgExts.indexOf(ext) >= 0) {
        promise = _generateImageThumb(filePath, sha, size);
      } else if (vidExts.indexOf(ext) >= 0) {
        promise = _generateVideoThumb(filePath, sha, size);
      } else {
        return null;
      }

      _pending[dedupKey] = promise;
      var result = await promise;
      delete _pending[dedupKey];
      return result;
    } catch (e) {
      console.warn('[thumbnail-cache] getThumbnail error:', e && e.message);
      return null;
    }
  }

  // isSupported: check if file type supports thumbnails
  function isSupported(filePath) {
    var ext = _ext(filePath).toLowerCase();
    var supported = ['.png','.jpg','.jpeg','.gif','.bmp','.webp','.tiff','.avif',
                     '.mp4','.mkv','.avi','.mov','.webm','.flv','.wmv','.m4v','.ts','.mpg'];
    return supported.indexOf(ext) >= 0;
  }

  // clearCache: clear in-memory caches (disk cache preserved)
  function clearCache() {
    _infoCache = {};
    _pathToSha = {};
    _pending = {};
  }

  window.qqqThumbnailCache = {
    getInfo: getInfo,
    getThumbnail: getThumbnail,
    isSupported: isSupported,
    clearCache: clearCache,
  };

})();
