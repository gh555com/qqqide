'use strict';

// ═══ 滚动楼层指示器（豆腐块 + 探针）═══
// 触发：滚动/wheel/1/2/q/w 键 → 视口垂直中心出现豆腐块
// 豆腐块上显示该楼层编号 + 建楼用时（从 floorDOM 读取时钟 DOM）
// 停止滚动后固定显示 2s → 1s CSS 渐隐消失

var _floorIndicatorTimeout = null;
var _floorIndicatorEl = document.getElementById('floor-indicator');

function _updateFloorIndicator() {
  if (!_floorIndicatorEl || !cardPool) return;
  var card = cardPool.getActive();
  if (!card || !card._contentWrap) return;
  var userMsgs = card._contentWrap.querySelectorAll('.msg-user');
  if (userMsgs.length === 0) { _floorIndicatorEl.classList.remove('visible'); return; }
  var container = $messages;
  var viewCenter = container.scrollTop + container.clientHeight * 0.5;
  // ★ 探针精准判定：找到 viewCenter 垂直穿过的楼层（最后一个 msg-user 顶部在视口中心线以上）
  var bestFloor = null;
  for (var i = 0; i < userMsgs.length; i++) {
    var el = userMsgs[i];
    var absTop = 0, cur = el;
    while (cur && cur !== container) { absTop += cur.offsetTop || 0; cur = cur.offsetParent; }
    if (absTop <= viewCenter) {
      bestFloor = el._floor;
    }
  }
  // ★ 楼层必须 ≥1（无 F0）；无效楼层直接隐藏指示器
  if (typeof bestFloor !== 'number' || bestFloor < 1) {
    _floorIndicatorEl.classList.remove('visible');
    return;
  }
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
  // ★ 楼层时间戳（从 agent._floorTimings 查找）
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
  _floorIndicatorEl.querySelector('.floor-ind-tofu').innerHTML = '<span style="font-weight:bold;font-size:14px">F' + escHtml(String(bestFloor)) + '</span>' + escHtml(tsStr + timingStr);
}

function _showFloorIndicatorBriefly() {
  if (!_floorIndicatorEl) return;
  _updateFloorIndicator();
  _floorIndicatorEl.classList.add('visible');
  if (_floorIndicatorTimeout) clearTimeout(_floorIndicatorTimeout);
  // 2s 后开始 1s 渐隐（CSS transition: opacity 1s ease）
  _floorIndicatorTimeout = setTimeout(function () {
    _floorIndicatorEl.classList.remove('visible');
    _floorIndicatorTimeout = null;
  }, 2000);
}

// ★ 仅用户主动快速滚动时才浮现豆腐块；慢速逐行滚（阅读态）不弹
var _wheelBurstTimer = null;
var _wheelBurstCount = 0;
var _WHEEL_BURST_THRESHOLD = 3;   // 300ms 内 ≥3 次滚轮事件 = 快速滚动
var _WHEEL_BURST_WINDOW = 300;
$messages.addEventListener('wheel', function () {
  _wheelBurstCount++;
  if (_wheelBurstCount >= _WHEEL_BURST_THRESHOLD) {
    _showFloorIndicatorBriefly();
  }
  if (_wheelBurstTimer) clearTimeout(_wheelBurstTimer);
  _wheelBurstTimer = setTimeout(function () {
    _wheelBurstCount = 0;
    _wheelBurstTimer = null;
  }, _WHEEL_BURST_WINDOW);
});
// ★ 1/2/q/w 键：仅在非编辑框内触发（避免在输入框中键入时误弹）
document.addEventListener('keydown', function (e) {
  var tag = document.activeElement ? document.activeElement.tagName : '';
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable;
  if (isInput) return;
  var k = e.key;
  if (k === '1' || k === '2' || k === 'q' || k === 'w') {
    _showFloorIndicatorBriefly();
  }
});
