// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// core/savor.js — Savor moments 机器（老 q3 savor 100% 移植，2026-09-19）
//
// 语义（老项目 q4.js triggerSavor + global.js savor 统计 + kp.py _play_audio 逐条对齐）:
//   · 点卡片（normal）: 随机选曲（1/30 → q.mp3；否则 1.mp3/2.mp3/3.mp3）+ 循环 2~6 次
//   · Loop 按钮: 无限循环（count=0）
//   · Stop 按钮: 停止 + 结算时长
//   · 电台接管: 电台在线（渲染层 5min 轮询 /radio/status 下发壳层）→ 播电台而非本地曲
//     （normal=随机 5~15 分钟自动停；loop=无限）——判定在壳层桥内完成（老 kp.py 语义）
//   · 2.mp3 自动前奏 a2.mp3（同目录，老语义）
//   · 统计: 次数在播放触发瞬间记 + 时长每 63 秒刷（老 global.js _recordSavorCount/_recordSavorDuration）
//   · 偿还 ping: 播放 → 壳层 wq-ping 携带 playing=true（服务端 last_playing_at / active_playing）
//   · 展示: 播放中 label = "Savoring..." / "Looping..."；电台在线 label 恒暗金色 (#8b6914)
//
// 多窗口: 事件广播全窗口；仅发起窗口记录统计（防跨窗口重复计数），其余窗口仅展示同步。
// API: window.qqqSavor = { play, stop, getState, getStats, refreshRadio, syncFromEngine, onState }
// 消费方: 菜单行2 qqq 下拉（core/qqq-tools.js）。
// ============================================================================

; (function () {
  'use strict';

  var RADIO_STATUS_URLS = [
    'https://direct-cn.gh555.com/radio/status',
    'https://www.gh555.com/radio/status',
    'https://gh555.com/radio/status'
  ];
  var RADIO_STREAM_URL = 'https://www.gh555.com/radio/stream';
  var RADIO_M3U8_URL = 'https://www.gh555.com/radio/live.m3u8';
  var RADIO_POLL_MS = 5 * 60 * 1000;   // 5min（老语义）
  var DUR_TICK_MS = 63000;             // 63s 时长刷（老语义）
  var WQ_TICK_MS = 5 * 60 * 1000;      // 播放中每 5min 补一次 playing ping

  var _st = {
    playing: false, displayOnly: false, isLoop: false, isRadio: false,
    startTime: 0, durTimer: null, wqTimer: null, expectOwn: false,
    radioLive: false, radioKnownAt: 0
  };
  var _stats = null;      // {count,totalMs,firstUse,radioCount,radioTotalMs,radioFirstUse}
  var _listeners = [];
  var _booted = false;
  var _qgs = null;

  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (e) { } }

  function _audio() { try { return (window.qqqideBridge && window.qqqideBridge.audio) || null; } catch (e) { return null; } }
  function _invoke(action, params) {
    var b = _audio();
    if (!b || !b.invoke) { return Promise.reject(new Error('音频桥不可用（需重启实例）')); }
    return b.invoke(action, params || {});
  }
  function _wqPing(on) {
    try {
      var w = window.qqqideBridge && window.qqqideBridge.wq;
      if (w && w.playing) { w.playing(!!on).catch(function () { }); }
    } catch (e) { }
  }

  // ── 统计存储（qgs.simple('qqq.savor')，程序级 global.sq3）──
  function _store() {
    if (_qgs) { return _qgs; }
    try { _qgs = (window.qgs && window.qgs.simple) ? window.qgs.simple('qqq.savor') : null; } catch (e) { _qgs = null; }
    return _qgs;
  }
  function _saveStats() {
    var h = _store();
    if (!h || !_stats) { return; }
    try { h.setNow('stats', JSON.stringify(_stats)); } catch (e) { }
    _vigMirror();
  }
  // ★ VIG 履历镜像（2026-09-19）：全量值同步壳层采集机（vig.set 覆盖语义）。
  //   qgs 统计仍为本地显示真理源；镜像为上报通道，每次变化全量覆盖零漂移。
  function _vigMirror() {
    try {
      var b = window.qqqideBridge && window.qqqideBridge.vig;
      if (!b || !b.set || !_stats) { return; }
      b.set('savor', {
        n: Number(_stats.count) || 0,
        ms: Number(_stats.totalMs) || 0,
        t0: _stats.firstUse ? Math.floor(_stats.firstUse / 1000) : 0
      });
      b.set('savor_radio', {
        n: Number(_stats.radioCount) || 0,
        ms: Number(_stats.radioTotalMs) || 0,
        t0: _stats.radioFirstUse ? Math.floor(_stats.radioFirstUse / 1000) : 0
      });
    } catch (e) { }
  }
  function _loadStats() {
    var h = _store();
    if (!h) { return Promise.resolve(); }
    return h.get('stats').then(function (raw) {
      try { _stats = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch (e) { _stats = null; }
      _emit();
    }).catch(function () { });
  }
  function _ensureStats() {
    if (!_stats) { _stats = {}; }
    if (!_stats.firstUse) { _stats.firstUse = Date.now(); }
    return _stats;
  }
  function _recCount(isRadio) {
    var s = _ensureStats();
    if (isRadio) {
      s.radioCount = (Number(s.radioCount) || 0) + 1;
      if (!s.radioFirstUse) { s.radioFirstUse = Date.now(); }
    } else {
      s.count = (Number(s.count) || 0) + 1;
    }
    _saveStats();
  }
  function _addDuration(ms, isRadio) {
    if (!ms || ms < 500) { return; }
    var s = _ensureStats();
    if (isRadio) { s.radioTotalMs = (Number(s.radioTotalMs) || 0) + ms; }
    else { s.totalMs = (Number(s.totalMs) || 0) + ms; }
    _saveStats();
  }

  // ── 随机（老语义：getRand(min,max) 上界开区间）──
  function _rand(min, max) {
    try {
      var a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return min + (a[0] % (max - min));
    } catch (e) {
      return Math.floor(Math.random() * (max - min)) + min;
    }
  }
  function _pickFile() {
    return _rand(0, 30) === 0 ? 'q.mp3' : (_rand(0, 3) + 1) + '.mp3';
  }

  // ── 电台状态机（老语义：渲染层轮询 → 下发壳层缓存 → 壳层决定是否接管）──
  function _fetchJsonTimeout(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var ctrl = null;
      try { ctrl = new AbortController(); } catch (e) { }
      var timer = setTimeout(function () { if (!done) { done = true; try { ctrl && ctrl.abort(); } catch (e) { } reject(new Error('timeout')); } }, ms);
      fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
        if (!r.ok) { throw new Error('http ' + r.status); }
        return r.json();
      }).then(function (d) {
        if (!done) { done = true; clearTimeout(timer); resolve(d); }
      }).catch(function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }
  function _pushRadioToBridge(live) {
    return _invoke('set_radio_status', {
      live: !!live,
      m3u8: live ? RADIO_M3U8_URL : '',
      stream: live ? RADIO_STREAM_URL : ''
    }).catch(function () { });
  }
  function _refreshRadio() {
    var i = 0;
    function tryNext() {
      if (i >= RADIO_STATUS_URLS.length) {
        _st.radioKnownAt = Date.now();  // 失败保留旧值，等下轮
        return Promise.resolve();
      }
      var url = RADIO_STATUS_URLS[i++] + '?_=' + Date.now();
      return _fetchJsonTimeout(url, 4000).then(function (d) {
        if (d && typeof d.live === 'boolean') {
          _applyRadio(!!d.live);
          _st.radioKnownAt = Date.now();
          return _pushRadioToBridge(!!d.live);
        }
        throw new Error('bad payload');
      }).catch(tryNext);
    }
    return tryNext();
  }
  function _applyRadio(live) {
    if (_st.radioLive !== live) { _st.radioLive = live; _emit(); }
  }
  function _ensureRadio() {
    var now = Date.now();
    if (_st.radioKnownAt && (now - _st.radioKnownAt) < RADIO_POLL_MS) { return Promise.resolve(); }
    return _refreshRadio();
  }

  // ── 会话（本地统计与状态；仅发起窗口记数）──
  function _startDurTimer() {
    _stopDurTimer();
    _st.durTimer = setInterval(function () {
      if (_st.startTime > 0) {
        _addDuration(DUR_TICK_MS, _st.isRadio);
        _st.startTime += DUR_TICK_MS;
        _emit();
      }
    }, DUR_TICK_MS);
  }
  function _stopDurTimer() {
    if (_st.durTimer) { clearInterval(_st.durTimer); _st.durTimer = null; }
  }
  function _startWqTimer() {
    if (!_st.wqTimer) {
      _st.wqTimer = setInterval(function () { _wqPing(true); }, WQ_TICK_MS);
    }
    _wqPing(true);
  }
  function _stopWqTimer() {
    if (_st.wqTimer) { clearInterval(_st.wqTimer); _st.wqTimer = null; }
  }

  function _adoptPlayback(own, isRadio, displayLoop) {
    if (_st.playing) { return; }
    _st.playing = true;
    _st.displayOnly = !own;
    _st.isRadio = !!isRadio;
    _st.isLoop = !!displayLoop;
    _st.startTime = Date.now();
    if (own) {
      _recCount(_st.isRadio);   // 老语义：次数在播放触发瞬间记
      _startDurTimer();
    }
    _startWqTimer();
    _emit();
  }
  function _endSession(flush) {
    var wasPlaying = _st.playing;
    var wasOwn = wasPlaying && !_st.displayOnly;
    var isRadio = _st.isRadio;
    if (flush && wasOwn && _st.startTime > 0) {
      _addDuration(Date.now() - _st.startTime, isRadio);   // 老语义：结算零头
    }
    _stopDurTimer();
    _stopWqTimer();
    _st.playing = false;
    _st.displayOnly = false;
    _st.isLoop = false;
    _st.isRadio = false;
    _st.startTime = 0;
    if (wasPlaying) {
      _wqPing(false);
      _emit();
    }
  }

  function _onAudioEvent(evt) {
    if (!evt || typeof evt !== 'object' || evt.event !== 'audio_state_changed') { return; }
    if (evt.playing) {
      if (_st.playing) { return; }
      var own = !!_st.expectOwn;
      if (own) { _st.expectOwn = false; }
      _adoptPlayback(own, evt.source === 'radio', evt.displayLoop === true);
    } else {
      _st.expectOwn = false;
      _endSession(true);
    }
  }

  // ── 播放控制（老 triggerSavor 语义：先停再播）──
  function play(mode) {
    mode = (mode === 'loop') ? 'loop' : 'normal';
    if (!_audio()) {
      _qoast('Savor: 音频桥不可用（需重启实例）', { type: 'error', duration: 9000 });
      return Promise.resolve();
    }
    _endSession(true);
    _st.expectOwn = true;
    var isLoop = (mode === 'loop');
    var file = _pickFile();
    var count = isLoop ? 0 : _rand(2, 7);   // 老语义：2..6
    return _invoke('stop_music').catch(function () { }).then(function () {
      return _ensureRadio();
    }).then(function () {
      return _invoke('play_music', { path: 'assets/savor/' + file, count: count });
    }).then(function (res) {
      if (res && res.ok === true) {
        var own = !!_st.expectOwn;   // 事件未到 → 由响应兜底采纳
        _st.expectOwn = false;
        _adoptPlayback(own, res.source === 'radio', isLoop);
      } else {
        _st.expectOwn = false;
        _qoast('Savor: ' + ((res && res.error) || '播放失败（需重启实例）'), { type: 'error', duration: 9000 });
      }
    }).catch(function (e) {
      _st.expectOwn = false;
      _qoast('Savor: ' + String((e && e.message) || e), { type: 'error', duration: 9000 });
    });
  }

  function stop() {
    _endSession(true);
    return _invoke('stop_music').catch(function () { });
  }

  // ── 从壳层同步现状（窗口重载/多窗口入场）──
  function _syncFromEngine() {
    return _invoke('get_audio_state').then(function (res) {
      if (res && res.ok === true && res.playing && !_st.playing) {
        _adoptPlayback(false, !!res.isRadio, !!res.displayLoop);
      }
    }).catch(function () { });
  }

  // ★ 原始统计快照（hover 清晰版展示消费——qqq-tools 组装本地语言；2026-09-22 用户定案）
  function getStats() {
    var s = _stats;
    if (!s) { return null; }
    var count = Number(s.count) || 0;
    var totalMs = Number(s.totalMs) || 0;
    var radioCount = Number(s.radioCount) || 0;
    var radioTotalMs = Number(s.radioTotalMs) || 0;
    var combined = totalMs + radioTotalMs;
    var firstUse = Math.min(s.firstUse || Date.now(), s.radioFirstUse || Date.now());
    var days = Math.max(1, Math.ceil((Date.now() - firstUse) / 86400000));
    var avgMs = Math.floor(combined / days);
    return { count: count, totalMs: totalMs, radioCount: radioCount, radioTotalMs: radioTotalMs, avgMs: avgMs };
  }
  // ── 订阅（qqq-tools 下拉打开时刷新）──
  function _emit() {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](getState()); } catch (e) { }
    }
  }
  function onState(cb) {
    if (typeof cb !== 'function') { return function () { }; }
    if (_listeners.indexOf(cb) < 0) { _listeners.push(cb); }
    return function () {
      var i = _listeners.indexOf(cb);
      if (i >= 0) { _listeners.splice(i, 1); }
    };
  }
  function getState() {
    return {
      playing: _st.playing,
      isLoop: _st.isLoop,
      isRadio: _st.isRadio,
      displayOnly: _st.displayOnly,
      radioLive: _st.radioLive
    };
  }

  // ── 启动 ──
  function _boot() {
    if (_booted) { return; }
    _booted = true;
    setTimeout(function () {
      _loadStats();
      _refreshRadio();
      var b = _audio();
      if (b && b.onEvent) {
        try { b.onEvent(_onAudioEvent); } catch (e) { }
      }
      setTimeout(_syncFromEngine, 1500);
      setInterval(function () { _refreshRadio(); }, RADIO_POLL_MS);
    }, 800);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }
  window.addEventListener('beforeunload', function () {
    try { _endSession(true); } catch (e) { }
  });

  window.qqqSavor = {
    play: play,
    stop: stop,
    getState: getState,
    getStats: getStats,
    refreshRadio: _refreshRadio,
    syncFromEngine: _syncFromEngine,
    onState: onState
  };
})();
