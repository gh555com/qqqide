// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// thumbnail-cache.js — 缩略图缓存管线（从 q3 的 ffmpeg 管线移植）
//
// 为媒体文件生成缩略图 PNG，缓存到 qqq/cache/thumbnails/{sha256}.png
//
// 类型:
//   图片: 直接缩放 → 512×288 (大) / 256×144 (小)
//   视频: ffmpeg 截取第 1 秒关键帧 → 缩放
//   音频: 生成文字幻灯片（文件名 + 元数据）
//   文本: ffmpeg 文字幻灯片（前 N 行）
//
// 暴露: window.qqqThumbnailCache
//
// 依赖: bridge.fs, bridge.media (ffmpeg component)
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;

  var CACHE_DIR = 'qqq/cache/thumbnails';
  var LARGE_W = 512, LARGE_H = 288;
  var SMALL_W = 256, SMALL_H = 144;
  var MAX_CACHE_ENTRIES = 500;

  // ═══ 内存缓存 ═══
  var _infoCache = {};    // sha256 → { width, height, duration, size, path }
  var _pathToSha = {};    // normalized path → sha256
  var _pending = {};      // sha256 → Promise (dedup)

  // ═══ 工具函数 ═══

  function _normPath(p) { return (p || '').replace(/\\/g, '/'); }

  function _ext(name) {
    if (!name) return '';
    var d = name.lastIndexOf('.');
    return d >= 0 ? name.slice(d).toLowerCase() : '';
  }

  // Simple SHA256 via bridge
  async function _sha256(content) {
    if (bridge && bridge.hash && bridge.hash.text) {
      try { var h = await bridge.hash.text(content, 'sha256'); return h; } catch (e) { /* */ }
    }
    // Fallback: use path-based key
    return '';
  }

  // Get SHA256 for a file path (from stat + path)
  async function _sha256ForPath(filePath) {
    var np = _normPath(filePath);
    if (_pathToSha[np]) return _pathToSha[np];

    try {
      // Use bridge hash if available
      if (bridge && bridge.hash && bridge.hash.file) {
        var h = await bridge.hash.file(filePath, 'sha256');
        if (h) {
          _pathToSha[np] = h;
          return h;
        }
      }
    } catch (e) { /* */ }

    // Fallback: hash the path itself
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
    return CACHE_DIR + '/' + prefix + '/' + sha256 + '_' + size + '.png';
  }

  // ═══ ffmpeg 探针: 获取媒体信息 ═══

  async function _probeMedia(filePath) {
    if (!bridge || !bridge.media || !bridge.media.probe) return null;

    try {
      var info = await bridge.media.probe(filePath);
      if (info) {
        return {
          width: info.width || 0,
          height: info.height || 0,
          duration: info.duration || 0,
          size: info.size || 0,
          hasVideo: info.hasVideo || false,
          hasAudio: info.hasAudio || false,
        };
      }
    } catch (e) {
      console.warn('[thumbnail-cache] probe failed:', filePath, e && e.message);
    }
    return null;
  }

  // ═══ ffmpeg 生成缩略图 ═══

  async function _generateImageThumb(filePath, sha256, size) {
    var w = size === 'large' ? LARGE_W : SMALL_W;
    var h = size === 'large' ? LARGE_H : SMALL_H;
    var outPath = _cachePath(sha256, size);

    // Check if already cached
    try {
      var exists = await bridge.fs.exists(outPath);
      if (exists) return outPath;
    } catch (e) { /* */ }

    if (!bridge || !bridge.media || !bridge.media.thumbnail) {
      // Fallback: can't generate, return original
      return null;
    }

    try {
      var result = await bridge.media.thumbnail({
        src: filePath,
        dest: outPath,
        width: w,
        height: h,
        seek: 0, // first frame
      });
      if (result && result.path) return result.path;
    } catch (e) {
      console.warn('[thumbnail-cache] generate failed:', filePath, e && e.message);
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

    if (!bridge || !bridge.media || !bridge.media.thumbnail) return null;

    try {
      // Seek to 1 second for a meaningful frame
      var result = await bridge.media.thumbnail({
        src: filePath,
        dest: outPath,
        width: w,
        height: h,
        seek: 1,
      });
      if (result && result.path) return result.path;
    } catch (e) {
      console.warn('[thumbnail-cache] video thumb failed:', filePath, e && e.message);
    }
    return null;
  }

  // ═══ 公共 API ═══

  // getInfo: 获取媒体信息（探针结果）
  async function getInfo(filePath) {
    if (!filePath) return null;
    var np = _normPath(filePath);

    try {
      var sha = await _sha256ForPath(filePath);
      if (_infoCache[sha]) return _infoCache[sha];

      // Probe via bridge
      var info = await _probeMedia(filePath);
      if (info) {
        // Also add file stat
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

  // getThumbnail: 获取或生成缩略图
  async function getThumbnail(filePath, size) {
    if (!filePath) return null;
    size = size || 'large';
    var ext = _ext(filePath).toLowerCase();

    try {
      var sha = await _sha256ForPath(filePath);
      var cacheFile = _cachePath(sha, size);

      // Check cache
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
        return null; // Unsupported type
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

  // isSupported: 检查文件类型是否支持缩略图
  function isSupported(filePath) {
    var ext = _ext(filePath).toLowerCase();
    var supported = ['.png','.jpg','.jpeg','.gif','.bmp','.webp','.tiff','.avif',
                     '.mp4','.mkv','.avi','.mov','.webm','.flv','.wmv','.m4v','.ts','.mpg'];
    return supported.indexOf(ext) >= 0;
  }

  // clearCache: 清空内存缓存（磁盘缓存保留）
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
