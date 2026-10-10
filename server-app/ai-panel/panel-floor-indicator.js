// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// ═══ 滚动楼层指示器（豆腐块 + 探针）═══
// 触发：滚轮 / 1/2/q/w 键 → 视口垂直中心出现豆腐块
// 豆腐块通过 postMessage 渲染到父窗口，基于 iframe 实际位置定位在 sash 区
// 停止滚动后固定显示 2s → 1s CSS 渐隐消失

var _floorIndicatorTimeout = null;

// ★ 探针锚点容差（px）：抵消矩形换算的子像素取整（LayoutUnit 1/64px），边界处读数不抖动
var _FI_TOL_PX = 2;

function _updateFloorIndicator() {
  if (!cardPool) return null;
  var card = cardPool.getActive();
  if (!card || !card._contentWrap) return null;
  var userMsgs = card._contentWrap.querySelectorAll('.msg-user');
  if (userMsgs.length === 0) return null;
  // ★ 锚点 = 豆腐块探针视觉位（面板视口中线）——父窗把探针放在 iframe 中线（≠ #messages 中线，相差 (input-area−header)/2，
  //   随布局变化）；取楼必按探针位，否则读数相对探针系统性偏移（偏高 → 读少一楼）。
  // ★ 取楼一律矩形换算（面板视口系，子像素精确）：免 offsetParent 链整数取整 + scrollTop 量化双重失真
  //   （offsetTop 取整上偏 + scrollTop 写入截断下偏叠加，q/w 落脚恰在边界时即翻出一楼）。
  var centerY = window.innerHeight / 2;
  var bestFloor = null;
  for (var i = 0; i < userMsgs.length; i++) {
    var el = userMsgs[i];
    if (el.getBoundingClientRect().top <= centerY + _FI_TOL_PX) {
      bestFloor = el._floor;
    }
  }
  if (typeof bestFloor !== 'number' || bestFloor < 1) return null;

  var timingStr = '';
  var dom = card.floorDOM[bestFloor];
  if (dom && dom.aiEl) {
    var minEl = dom.aiEl._clockMin;
    var secEl = dom.aiEl._clockSec;
    if (minEl && secEl) {
      var mt = (minEl.textContent || '').replace(/m.*$/, '');
      var st = (secEl.textContent || '').replace(/^[^\d]*/, '').replace(/s.*$/, '');
      if (mt || st) timingStr = ' ● ' + (mt || '0') + 'm:' + (st || '0') + 's';
    }
  }
  var tsStr = '';
  var ag = typeof _activeAgent !== 'undefined' ? _activeAgent : null;
  if (ag && ag._floorTimings) {
    for (var ti = ag._floorTimings.length - 1; ti >= 0; ti--) {
      var ft = ag._floorTimings[ti];
      if (ft.floorIndex === bestFloor && ft.finishedAt) {
        var startMs = ft.durationMs ? new Date(ft.finishedAt).getTime() - ft.durationMs : new Date(ft.finishedAt).getTime();
        var d = new Date(startMs);
        var pad = function(n) { return (n < 10 ? '0' : '') + n; };
        var mo = pad(d.getMonth()+1);
        var dy = pad(d.getDate());
        tsStr = ' ● ' + d.getFullYear() + '-<span style="font-size:21px">' + mo + '</span>-<span style="font-size:21px">' + dy + '</span> ' +
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        break;
      }
    }
  }
  var floorSpan = '<span style="font-weight:bold;font-size:24px;color:#dc322f">' + escHtml(String(bestFloor)) + '</span>';
  var _pid = typeof _panelId !== 'undefined' ? _panelId : 1;
  // ★ 中/右面板：文字顺序翻转（计时在前，楼层在尾）；左面板保持原序
  var html;
  if (_pid === 0) {
    // tsStr 内含 HTML 标签（月日加粗），不转义
    html = floorSpan + tsStr + escHtml(timingStr);
  } else {
    // 反转：计时 ● 日期 ● F26
    var _tsClean = tsStr.replace(/^ ● /, '');
    var _timingClean = timingStr.replace(/^ ● /, '');
    html = escHtml(_timingClean) + ' ● ' + _tsClean + ' ● ' + floorSpan;
  }
  return { html: html, panel: _pid };
}

function _showFloorIndicatorBriefly() {
  // ★ 建楼中（AI 正在回复）不显示指示器：流式渲染/自动滚屏不打扰，仅闲置时用户滚动才浮现
  if (_sending || streaming) {
    if (_floorIndicatorTimeout) { clearTimeout(_floorIndicatorTimeout); _floorIndicatorTimeout = null; }
    _postToHost({ type: 'qqq-floor-indicator', action: 'hide' });
    return;
  }
  var data = _updateFloorIndicator();
  if (!data) {
    _postToHost({ type: 'qqq-floor-indicator', action: 'hide' });
  } else {
    _postToHost({ type: 'qqq-floor-indicator', action: 'show', html: data.html, panel: data.panel });
  }
  if (_floorIndicatorTimeout) clearTimeout(_floorIndicatorTimeout);
  _floorIndicatorTimeout = setTimeout(function () {
    _postToHost({ type: 'qqq-floor-indicator', action: 'hide' });
    _floorIndicatorTimeout = null;
  }, 2000);
}

// ★ 滚动/滚轮/拖拽滚动条 → 浮现
$messages.addEventListener('wheel', _showFloorIndicatorBriefly);
$messages.addEventListener('scroll', _showFloorIndicatorBriefly);
// ★ 1/2/q/w 键：仅在非编辑框内触发
document.addEventListener('keydown', function (e) {
  var tag = document.activeElement ? document.activeElement.tagName : '';
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable;
  if (isInput) return;
  var k = e.key;
  if (k === '1' || k === '2' || k === 'q' || k === 'w') {
    _showFloorIndicatorBriefly();
  }
});
