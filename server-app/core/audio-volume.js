// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// core/audio-volume.js — 统一音频音量管理（主路/旁路双通路模型）
//
// 入口：
//   window.qqqAudio.getMainVolume()        — 返回 0.0-1.0，IDE 窗口 + goods 默认共用
//   window.qqqAudio.getVolume(goodsId)     — 返回 0.0-1.0，带 goods 旁路感知
//
// 双通路模型：
//   主路（默认）— IDE 窗口一切音效 + 一切 goods 音效默认走此通路。
//                设置面板「音量」拉杆只作用于主路。
//   旁路（independent）— goods 声明 audio.mode='independent' 时启用。
//                旁路 goods 自有音量控制体系，完全不受主路拉杆影响。
//                目前尚无旁路 goods 实例，仅为协议预留。
//
// 铁律：
//   · IDE 自带音效（升级/子弹）→ 通过 getMainVolume() 读主路音量
//   · goods 的音效 → 通过 getVolume(goodsId) 获取音量，禁自行 new Audio 后直接设 volume
//   · 旁路 goods 自行管理音量，此模块仅返回 1.0（不干预）
// ============================================================================
(function () {
  'use strict';

  var _registered = {}; // goodsId → { mode: 'ide'|'independent' }

  function register(goodsId, cfg) {
    _registered[goodsId] = cfg && cfg.audio ? cfg.audio : { mode: 'ide' };
  }

  function unregister(goodsId) {
    delete _registered[goodsId];
  }

  /** 主路音量 — IDE 窗口 + goods 默认共用。设置面板拉杆控制。 */
  function getMainVolume() {
    var raw = window.qqqSettings ? window.qqqSettings.get('audio.volume', '25') : '25';
    return parseInt(raw, 10) / 100;
  }

  /** goods 音量 — 自动判断主路/旁路 */
  function getVolume(goodsId) {
    var cfg = _registered[goodsId];
    if (cfg && cfg.mode === 'independent') {
      // 旁路 — goods 自有音量控制，此处不干预
      return 1.0;
    }
    // 主路（默认）— 跟随 IDE 音量拉杆
    return getMainVolume();
  }

  function isIndependent(goodsId) {
    var cfg = _registered[goodsId];
    return !!(cfg && cfg.mode === 'independent');
  }

  window.qqqAudio = {
    register: register,
    unregister: unregister,
    getMainVolume: getMainVolume,
    getVolume: getVolume,
    isIndependent: isIndependent
  };

})();
