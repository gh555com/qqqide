// ============================================================================
// core/audio-volume.js — 统一音频音量管理
//
// 入口：
//   window.qqqAudio.getVolume(goodsId)  — 返回 0.0-1.0
//
// 策略：
//   goods 可声明 audio.mode:
//     'ide' (默认) — 跟随 IDE 音量滑块，qqqSettings.get('audio.volume') / 100
//     'independent' — goods 自有音量，不受 IDE 滑块影响。goods 通过 gaea state 存储
//
// 铁律：
//   · IDE 自带音效（升级/子弹）不走此模块，硬编码各自音量
//   · goods 的音效必须通过此模块获取音量，禁自行 new Audio 后直接设 volume
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

  function getVolume(goodsId) {
    var cfg = _registered[goodsId];
    if (!cfg || cfg.mode !== 'independent') {
      // 'ide' mode — always follow the IDE slider
      var raw = window.qqqSettings ? window.qqqSettings.get('audio.volume', '100') : '100';
      return parseInt(raw, 10) / 100;
    }
    // 'independent' mode — goods sets its own volume via its state store
    // Default 1.0 (100%) if not set
    return 1.0;
  }

  function isIndependent(goodsId) {
    var cfg = _registered[goodsId];
    return !!(cfg && cfg.mode === 'independent');
  }

  window.qqqAudio = {
    register: register,
    unregister: unregister,
    getVolume: getVolume,
    isIndependent: isIndependent
  };

})();
