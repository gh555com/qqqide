// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// media-kinds.js — 「qd 能直开哪些媒体」唯一真理源
//
// 四张表恒为唯一权威（任何消费方禁再抄一份）：
//   NATIVE_IMAGE  悬浮预览层原生直显（Chromium 解码，零转码）
//   IMAGE         悬浮预览层可显示全集 = NATIVE_IMAGE + psd/tif/tiff（壳层 ffmpeg 抽帧转码）
//   VIDEO         独立播放器窗可播（原生组 + 转码兜底组）
//   AUDIO         独立播放器窗可播（原生组 + 转码兜底组）
//
// 表外格式 = qd 不负责打开（调用方回退系统默认程序）。
// .ts 恒排除 = TypeScript 文本，绝不能被视频分支误吞。
// 消费方：core/qqq-codelens.js（文件信息行点击）· goods/file-explorer/q2-roam.js（Q 键/右键/批量/加入播放列表）
// 暴露: window.qqqMediaKinds
// ============================================================================

(function () {
  'use strict';

  // ── 原生直显组（Chromium 解码）：png/jpg 全家/gif/bmp/webp/ico/svg/avif/apng ──
  var NATIVE_IMAGE = {
    '.png': 1, '.jpg': 1, '.jpeg': 1, '.jpe': 1, '.jfif': 1, '.jif': 1, '.gif': 1, '.bmp': 1,
    '.webp': 1, '.ico': 1, '.svg': 1, '.avif': 1, '.apng': 1,
  };

  // ── 悬浮预览层可显示全集 = 原生组 + ffmpeg 抽帧组（psd/tif/tiff；转码路由唯一在 shell-overlay）──
  var IMAGE = {};
  (function () {
    var k;
    for (k in NATIVE_IMAGE) {
      if (Object.prototype.hasOwnProperty.call(NATIVE_IMAGE, k)) IMAGE[k] = 1;
    }
    IMAGE['.psd'] = 1;
    IMAGE['.tif'] = 1;
    IMAGE['.tiff'] = 1;
  })();

  // ── 播放器可播（视频）：原生组已实测全解码 + 转码兜底组（avi/wmv/flv/rmvb/… = ffmpeg 重封装或重编码）──
  var VIDEO = {
    '.mp4': 1, '.m4v': 1, '.webm': 1, '.mkv': 1, '.mov': 1, '.ogv': 1, '.avi': 1, '.wmv': 1,
    '.flv': 1, '.rmvb': 1, '.rm': 1, '.mpg': 1, '.mpeg': 1, '.m2ts': 1, '.mts': 1, '.3gp': 1,
    '.vob': 1, '.asf': 1, '.f4v': 1, '.ogm': 1,
  };

  // ── 播放器可播（音频）：原生组（mp3/aac/ogg/opus/flac/wav…）+ 转码兜底组（wma/ape/ac3/amr/aiff/mka…）──
  var AUDIO = {
    '.mp3': 1, '.wav': 1, '.flac': 1, '.m4a': 1, '.aac': 1, '.ogg': 1, '.oga': 1, '.opus': 1,
    '.weba': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.ape': 1, '.ac3': 1, '.mka': 1, '.amr': 1,
    '.au': 1,
  };

  function extOf(name) {
    if (!name) return '';
    var n = String(name).toLowerCase();
    var dot = n.lastIndexOf('.');
    return dot === -1 ? '' : n.substring(dot);
  }

  /** 路径/文件名 → 'image' | 'video' | 'audio' | ''（空串 = qd 不负责打开） */
  function kindOf(name) {
    var e = extOf(name);
    if (!e) return '';
    if (IMAGE[e]) return 'image';
    if (VIDEO[e]) return 'video';
    if (AUDIO[e]) return 'audio';
    return '';
  }

  var api = {
    NATIVE_IMAGE: NATIVE_IMAGE,
    IMAGE: IMAGE,
    VIDEO: VIDEO,
    AUDIO: AUDIO,
    extOf: extOf,
    kindOf: kindOf,
    /** Chromium 原生可解（直显零转码） */
    isNativeImage: function (ext) { return !!NATIVE_IMAGE[extOf(ext)]; },
    /** 图片里必须过 ffmpeg 抽帧的三类（psd/tif/tiff；ffmpeg 未就绪 = 打不开） */
    needsTranscodeImage: function (ext) {
      var e = extOf(ext);
      return !!IMAGE[e] && !NATIVE_IMAGE[e];
    },
  };

  try { window.qqqMediaKinds = api; } catch (e) { /* Node 单测环境（无 window） */ }
  // 单测入口（ci/tests/media-kinds.test.js）；浏览器里 module 不存在，恒不执行
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e2) { /* */ }

})();
