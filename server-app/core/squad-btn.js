// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// squad-btn.js — 窗口编队按钮（菜单行2，LV 进度条左侧）
//   · 按钮显示当前窗口编队字符（1 2 q w a s z x 之一）；无编队（>8 窗口）显示灰色 ■
//   · 点击 → 下拉 8 槽位：已占用（红/灰禁用，title=所属窗口标题）/ 空闲（可点切换）/ 当前（金色）
//   · 同步: main 进程广播 'qqqide:squad:changed' → 重新 get → 秒级刷新
//   · 真理源: %LOCALAPPDATA%/qqqide/squads.json（主进程 squad-manager.ts）
// ============================================================================
(function () {
  'use strict';

  var ORDER = ['1', '2', 'q', 'w', 'a', 's', 'z', 'x'];
  var _btn = null;
  var _dd = null;
  var _state = null;
  var _retries = 0;
  var _NO_DRAG = '-webkit-app-region:no-drag;';
  var _unsub = null;

  function _bridge() {
    return window.qqqideBridge && window.qqqideBridge.squad;
  }

  // ── 注入：等 login.js 注入 LV 条之后，插到其左侧 ──
  function _inject() {
    if (_btn) return;
    if (!_bridge()) { if (++_retries <= 20) setTimeout(_inject, 400); return; }
    var $lv = document.querySelector('.qqq-lv-bar');
    if (!$lv) { if (++_retries <= 20) setTimeout(_inject, 400); return; }

    _btn = document.createElement('button');
    _btn.className = 'qqq-squad-btn';
    _btn.style.cssText = _NO_DRAG + 'border:1px solid var(--border-color,#444);border-radius:4px;background:transparent;cursor:pointer;padding:0 10px;height:24px;font-size:16px;margin-right:6px;position:relative;font-variant-numeric:tabular-nums;white-space:nowrap;';
    _btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); _toggle(); });
    $lv.parentNode.insertBefore(_btn, $lv);

    _refresh();
    try { _unsub = _bridge().onChanged(function () { _refresh(); }); } catch (_) { }
  }

  // ── 状态拉取 + 渲染 ──
  function _refresh() {
    if (!_bridge() || !_btn) return;
    _bridge().get().then(function (r) {
      if (!r || !r.ok) return;
      _state = r.state;
      _render();
    }).catch(function () { /* ignore */ });
  }

  function _render() {
    var sq = _state && _state.squad;
    if (!_btn) return;
    _btn.textContent = sq ? sq : '\u25A0';  // 1/8按钮: 只显示编队字符, 不带 ■
    _btn.style.color = sq ? 'var(--text-primary,#e8e8e8)' : 'var(--text-secondary,#777)';
    _btn.title = sq
      ? ('编队 ' + sq + ' — 空格+' + sq + ' 召回（点击更换编队）')
      : '无编队（不可召回）— 点击选择分组';
    if (_dd) _renderDd();
  }

  // ── 下拉 ──
  function _toggle() {
    if (_dd) { _close(); return; }
    if (!_state) { _refresh(); return; }
    _dd = document.createElement('div');
    _dd.className = 'qqq-squad-dropdown';
    _dd.style.cssText = 'position:absolute;top:calc(100% + 2px);left:0;background:var(--background-color);border:2px dashed var(--border-color);border-radius:0 0 8px 8px;box-shadow:0 6px 20px rgba(0,0,0,0.15);z-index:99999;min-width:180px;max-width:320px;padding:4px 0;';
    _renderDd();
    _btn.appendChild(_dd);
    setTimeout(function () {
      document.addEventListener('mousedown', _onDocDown, true);
      window.addEventListener('blur', _onWinBlur);
    }, 0);
  }

  function _renderDd() {
    if (!_dd || !_state) return;
    _dd.innerHTML = '';
    var slots = _state.slots || {};
    for (var i = 0; i < ORDER.length; i++) {
      var k = ORDER[i];
      var e = slots[k];
      var isCur = _state.squad === k;
      (function (slot, entry, current) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;height:28px;line-height:28px;padding:0 12px;font-size:12px;white-space:nowrap;';
        var tag = document.createElement('span');
        tag.textContent = slot;
        tag.style.cssText = 'font-weight:bold;width:20px;text-align:center;flex-shrink:0;font-size:13px;color:' + (current ? '#b58900' : (entry ? '#dc322f' : '#859900')) + ';';
        var label = document.createElement('span');
        label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary,#e8e8e8);';
        // 中列: 带编队前缀（x■ + 标题/文件夹名/窗口#N 兜底）
        var labelText = '空闲';
        if (entry) {
          var t = String(entry.title || '').replace(/^[1-2qwaszx]\u25A0/, '');
          var f = String(entry.folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
          var name = t || (f ? (f.split('/').pop() || f) : ('窗口#' + entry.winId));
          labelText = slot + '\u25A0' + name;
        }
        label.textContent = labelText;
        var curTag = document.createElement('span');
        if (current) {
          curTag.textContent = '当前';
          curTag.style.cssText = 'color:#b58900;font-size:11px;flex-shrink:0;';
        }
        row.appendChild(tag); row.appendChild(label); row.appendChild(curTag);
        if (entry && !current) {
          row.style.cursor = 'not-allowed';
          row.style.opacity = '0.55';
          row.title = '已被占用：' + (entry.folder || entry.title || '');
        } else if (current) {
          row.style.cursor = 'default';
        } else {
          row.style.cursor = 'pointer';
          row.addEventListener('mouseenter', function () { this.style.background = 'var(--gold-hover-bg)'; });
          row.addEventListener('mouseleave', function () { this.style.background = ''; });
          row.addEventListener('click', function (ev) { ev.stopPropagation(); _pick(slot); });
        }
        _dd.appendChild(row);
      })(k, e, isCur);
    }
    // ── none 行: 不指定任何分组（解除编队, 不可召回）──
    var sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--border-color);margin:3px 8px;';
    _dd.appendChild(sep);
    (function (current) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;height:28px;line-height:28px;padding:0 12px;font-size:12px;white-space:nowrap;';
      var tag = document.createElement('span');
      tag.textContent = '\u2014';
      tag.style.cssText = 'font-weight:bold;width:20px;text-align:center;flex-shrink:0;font-size:13px;color:' + (current ? '#b58900' : 'var(--text-secondary,#777)') + ';';
      var label = document.createElement('span');
      label.textContent = 'none（不指定分组）';
      label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary,#e8e8e8);';
      var curTag = document.createElement('span');
      if (current) {
        curTag.textContent = '当前';
        curTag.style.cssText = 'color:#b58900;font-size:11px;flex-shrink:0;';
      }
      row.appendChild(tag); row.appendChild(label); row.appendChild(curTag);
      if (current) {
        row.style.cursor = 'default';
      } else {
        row.style.cursor = 'pointer';
        row.addEventListener('mouseenter', function () { this.style.background = 'var(--gold-hover-bg)'; });
        row.addEventListener('mouseleave', function () { this.style.background = ''; });
        row.addEventListener('click', function (ev) { ev.stopPropagation(); _pick('none'); });
      }
      _dd.appendChild(row);
    })(!_state.squad);
  }

  function _pick(slot) {
    var b = _bridge();
    if (!b) { _close(); return; }
    b.set(slot).then(function (r) {
      if (r && !r.ok && r.reason && r.reason === 'occupied') {
        try { window.qqqideQoast.show('该编队已被占用', { type: 'warn', duration: 3000 }); } catch (_) { }
      }
      _close();
      _refresh();
    }).catch(function () { _close(); _refresh(); });
  }

  function _onDocDown(ev2) {
    if (_dd && !_dd.contains(ev2.target) && ev2.target !== _btn) _close();
  }
  function _onWinBlur() { _close(); }

  function _close() {
    document.removeEventListener('mousedown', _onDocDown, true);
    window.removeEventListener('blur', _onWinBlur);
    if (_dd) { try { _dd.remove(); } catch (_) { } }
    _dd = null;
  }

  // ── boot ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_inject, 300); });
  } else {
    setTimeout(_inject, 300);
  }
})();
