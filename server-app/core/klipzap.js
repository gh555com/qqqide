// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// klipzap.js — 跨平台中心剪贴板机（唯一真理源）
//
// 架构：
//   klipzap (统一入口) → bridge.clipboard.* (主进程)
//   主进程后端: Windows=Electron内置+PowerShell CF_HDROP / macOS=内置 / Linux=xclip
//
// 暴露: window.qqqideKlipzap
//
// 核心原则:
//   · probe() — 零 spawn，sub-ms（走 Electron clipboard.availableFormats）
//   · 纯文本粘贴路径不经过任何 FFI/spawn
//   · readFiles/writeFiles — 仅当 probe 确认 hasFile 后才调用（低频路径）
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;

  // ═══ probe — 零 spawn 探针 ═══
  // 返回 ClipProbeResult: { hasText, hasImage, hasFile, hasHtml, _rawFormats }
  async function probe() {
    if (bridge && bridge.clipboard && bridge.clipboard.probe) {
      try {
        return await bridge.clipboard.probe();
      } catch (e) {
        console.warn('[klipzap] probe failed:', e && e.message);
      }
    }
    return { hasText: false, hasImage: false, hasFile: false, hasHtml: false, _rawFormats: [] };
  }

  // ═══ 读取（按需，异步） ═══
  async function readText() {
    if (bridge && bridge.clipboard && bridge.clipboard.readText) {
      try { return await bridge.clipboard.readText(); } catch { }
    }
    return '';
  }

  async function readHtml() {
    if (bridge && bridge.clipboard && bridge.clipboard.readHtml) {
      try { return await bridge.clipboard.readHtml(); } catch { }
    }
    return '';
  }

  async function readImage() {
    if (bridge && bridge.clipboard && bridge.clipboard.readImage) {
      try { return await bridge.clipboard.readImage(); } catch { }
    }
    return null; // dataURL or null
  }

  async function readFiles() {
    if (bridge && bridge.clipboard && bridge.clipboard.readFiles) {
      try { return await bridge.clipboard.readFiles(); } catch { }
    }
    return [];
  }

  // ═══ 写入 ═══
  async function writeFiles(paths) {
    if (!paths || paths.length === 0) return false;
    if (bridge && bridge.clipboard && bridge.clipboard.writeFiles) {
      try { return await bridge.clipboard.writeFiles(paths); } catch { }
    }
    return false;
  }

  async function writeText(text) {
    if (bridge && bridge.clipboard && bridge.clipboard.writeText) {
      try { await bridge.clipboard.writeText(text); return true; } catch { }
    }
    return false;
  }

  // ═══ 便捷方法 ═══
  // pasteType: 根据 probe 结果返回粘贴类型（用于路由决策）
  // 返回: 'text' | 'image' | 'file' | 'html' | 'mixed' | 'empty'
  async function pasteType() {
    var p = await probe();
    if (!p.hasText && !p.hasImage && !p.hasFile && !p.hasHtml) return 'empty';
    var types = [];
    if (p.hasFile) types.push('file');
    if (p.hasImage) types.push('image');
    if (p.hasHtml) types.push('html');
    if (p.hasText) types.push('text');
    if (types.length > 1) return 'mixed';
    return types[0] || 'empty';
  }

  window.qqqideKlipzap = {
    probe: probe,
    readText: readText,
    readHtml: readHtml,
    readImage: readImage,
    readFiles: readFiles,
    writeFiles: writeFiles,
    writeText: writeText,
    pasteType: pasteType,
  };

})();
