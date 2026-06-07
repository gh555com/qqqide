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
  var bestFloor = null, bestDist = Infinity;
  for (var i = 0; i < userMsgs.length; i++) {
    var el = userMsgs[i];
    var absTop = 0, cur = el;
    while (cur && cur !== container) { absTop += cur.offsetTop || 0; cur = cur.offsetParent; }
    var dist = Math.abs(viewCenter - absTop);
    if (dist < bestDist) { bestDist = dist; bestFloor = el._floor; }
  }
  if (bestFloor !== null && bestFloor !== undefined) {
    var timingStr = '';
    var dom = card.floorDOM[bestFloor];
    if (dom && dom.aiEl) {
      var minEl = dom.aiEl._clockMin;
      var secEl = dom.aiEl._clockSec;
      if (minEl && secEl) {
        var mt = (minEl.textContent || '').replace(/m.*$/, '');
        var st = (secEl.textContent || '').replace(/^[^\d]*/, '').replace(/s.*$/, '');
        if (mt || st) timingStr = ' · ' + (mt || '0') + 'm' + (st || '0') + 's';
      }
    }
    _floorIndicatorEl.querySelector('.floor-ind-tofu').textContent = 'F' + bestFloor + timingStr;
  }
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

// 监听滚动 + 滚轮 → 显示指示器
$messages.addEventListener('scroll', function () {
  _updateFloorIndicator();
  _showFloorIndicatorBriefly();
});
$messages.addEventListener('wheel', function () {
  _showFloorIndicatorBriefly();
});
