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

  // ═══════════ 音效开关（2026-09-04）═══════════
  // 场景表唯一真理：设置面板「1 by 1」卡片 + 禁用集推送都由此表驱动，零双表漂移。
  // 状态持久化 qgs('qqq.settings'/'audio.sfx')（与音量同库），默认全部启用。
  // 机制：本模块算禁用集（文件子串）→ bridge.audio.invoke('setSfxDisabled',{patterns})
  //   → 主进程 ipc-audio.ts 闸门 —— 一切播放点（AI 面板 endfloor/muyu/子弹、Roam/kmd、
  //   LV 升级、编队召回 summon）统一被拦，播放点代码零侵入。
  // match 串 = 播放点调用主进程时携带的原始 file 参数子串（yz: 前缀恒定），禁裸文件名
  //   防误伤（如 '4.mp3' 会命中任何 xxx4.mp3；'yz:4.mp3' 精确）。
  var SFX_SCENES = [
    { key: 'floor-ok',  label: '楼层正常完成音', file: 'ok endfloor',    match: ['ok endfloor.mp3'],  desc: '每层楼正常建完那一下' },
    { key: 'floor-bad', label: '楼层异常结束音', file: 'bad endfloor',   match: ['bad endfloor.mp3'], desc: '异常/停止/停滞收尾' },
    { key: 'muyu',      label: '木鱼·免费时段报喜', file: 'muyu',       match: ['muyu.mp3'],         desc: '每次进入免费时段瞬间' },
    { key: 'roam',      label: '文件操作音',     file: 'a2 4 rou1 a1 kj2 zs861', match: ['yz:a2.mp3', 'yz:4.mp3', 'yz:rou1.mp3', 'yz:a1.mp3', 'yz:kj2.mp3', 'yz:zs861.mp3'], desc: 'Roam 进入/删除/清空/固定/取消固定 + 终端' },
    { key: 'bullet',    label: '子弹问答枪声',   file: 'bullet 组',      match: ['bullet/'],          desc: 'AI 回答后子弹按钮' },
    { key: 'lv',        label: '等级升级音',     file: 'lv-up',          match: ['lv-up'],            desc: '等级条升段与里程碑' },
    { key: 'summon',    label: '窗口召回音',     file: 'kj3',            match: ['kj3.mp3'],          desc: '编队热键召回窗口成功' }
  ];
  var _sfxState = {};   // sceneKey → 'true' | 'false'（缺省 = 启用）
  var _sfxLoaded = false;

  function _sfxOn(key) { return _sfxState[key] !== 'false'; }
  function _sfxQgs() {
    try { return (window.qgs && window.qgs.simple) ? window.qgs.simple('qqq.settings', { cloud: false }) : null; } catch (_) { return null; }
  }
  function _sfxDisabledPatterns() {
    var out = [];
    for (var i = 0; i < SFX_SCENES.length; i++) {
      if (_sfxOn(SFX_SCENES[i].key)) continue;
      for (var j = 0; j < SFX_SCENES[i].match.length; j++) out.push(SFX_SCENES[i].match[j]);
    }
    return out;
  }
  function _syncSfxToMain() {
    try {
      var b = window.qqqideBridge && window.qqqideBridge.audio;
      if (b && b.invoke) { b.invoke('setSfxDisabled', { patterns: _sfxDisabledPatterns() }).catch(function () { }); }
    } catch (_) { }
  }
  function _sfxSet(key, on) {
    _sfxState[key] = on ? 'true' : 'false';
    var h = _sfxQgs();
    if (h) { try { h.set('audio.sfx', JSON.stringify(_sfxState)); } catch (_) { } }
    _syncSfxToMain();
  }
  function _sfxLoad() {
    var h = _sfxQgs();
    if (!h) { setTimeout(_sfxLoad, 500); return; }
    h.get('audio.sfx').then(function (raw) {
      try {
        if (raw) {
          var obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
          for (var k in obj) {
            var known = false;
            for (var i = 0; i < SFX_SCENES.length; i++) { if (SFX_SCENES[i].key === k) { known = true; break; } }
            if (known) _sfxState[k] = (obj[k] === 'false' || obj[k] === false) ? 'false' : 'true';
          }
        }
      } catch (_) { }
      _syncSfxToMain();
    }).catch(function () { _syncSfxToMain(); });
  }

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
    isIndependent: isIndependent,
    // ── 音效开关（1 by 1 卡片消费）──
    sfxScenes: function () { return SFX_SCENES; },
    sfxOn: _sfxOn,
    sfxSet: _sfxSet
  };

  // ★ 启动即拉取用户设置并推送主进程闸门（抢在任何播放前）；qgs 未就绪自动重试
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_sfxLoad, 100); });
  } else {
    setTimeout(_sfxLoad, 100);
  }

})();
