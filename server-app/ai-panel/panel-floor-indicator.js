'use strict';

// ═══ 滚动楼层指示器（豆腐块 + 探针）═══
// 触发：滚轮 / 1/2/q/w 键 → 视口垂直中心出现豆腐块
// 豆腐块通过 postMessage 渲染到父窗口，可跨面板定位不遮挡内容
// 停止滚动后固定显示 2s → 1s CSS 渐隐消失

var _floorIndicatorTimeout = null;

function _updateFloorIndicator() {
  if (!cardPool) return null;
  var card = cardPool.getActive();
  if (!card || !card._contentWrap) return null;
  var userMsgs = card._contentWrap.querySelectorAll('.msg-user');
  if (userMsgs.length === 0) return null;
  var container = $messages;
  var viewCenter = container.scrollTop + container.clientHeight * 0.5;
  var bestFloor = null;
  for (var i = 0; i < userMsgs.length; i++) {
    var el = userMsgs[i];
    var absTop = 0, cur = el;
    while (cur && cur !== container) { absTop += cur.offsetTop || 0; cur = cur.offsetParent; }
    if (absTop <= viewCenter) {
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
        tsStr = ' ● ' + d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' +
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        break;
      }
    }
  }
  var html = '<span style="font-weight:bold;font-size:14px">F' + escHtml(String(bestFloor)) + '</span>' + escHtml(tsStr + timingStr);
  return { html: html, panel: typeof _panelId !== 'undefined' ? _panelId : 1 };
}

function _showFloorIndicatorBriefly() {
  var data = _updateFloorIndicator();
  if (!data) {
    // 无有效楼层 → 通知父窗口隐藏
    _postToHost({ type: 'qqq-floor-indicator', action: 'hide' });
    return;
  }
  _postToHost({ type: 'qqq-floor-indicator', action: 'show', html: data.html, panel: data.panel });
  if (_floorIndicatorTimeout) clearTimeout(_floorIndicatorTimeout);
  _floorIndicatorTimeout = setTimeout(function () {
    _postToHost({ type: 'qqq-floor-indicator', action: 'hide' });
    _floorIndicatorTimeout = null;
  }, 2000);
}

// ★ 用户滚轮滚动即浮现豆腐块
$messages.addEventListener('wheel', function () {
  _showFloorIndicatorBriefly();
});
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
