// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// sash.js - QQQ Shell v2 sash engine — 两分区守恒（2026-09-04 定案，级联压缩废除）
//
// API: window.qqqideSash = { bindV, bindH }
//
// bindV(sashEl, left, right) / bindH(sashEl, top, bottom)
//   每侧参数 = 单面板描述对象 { getW/getH, setW/setH, min, max? }
//   （兼容旧数组形态：语义 = 紧邻面板 —— 左/上侧取末项，右/下侧取首项）
//
// ★ 闭环不变量（2026-09-04）:
//   任何分区宽度 ∈ [min, max]；拖拽只重分配紧邻两分区之间滴空间——
//   远端分区数学上不可能被波及（拖 G1⎮G2 左拉永远吃不到 G0）。
//   数学:
//     C = wA + wB                      （拖拽期间两分区之和守恒）
//     wA' = clamp(wA + d,  max(minA, C − maxB),   min(maxA, C − minB))
//     wB' = C − wA'                     （余量自动守恒）
//   结构性上限 C − minB = 相邻分区保底永不被吃；结构性下限 C − maxB 对称。
//   容器 C 内任意拖距两侧 min/max 恒成立；窗口过窄（C < minA+minB）→ 冻结不动。
//   拖到边界即饱和（qqq-sash-saturated 红条提示，视觉反馈保留）。
// ============================================================================
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function layoutMin() {
    var c = window.__LAYOUT_CONST;
    return (c && c.PANEL_MIN) || 123;
  }

  // 归一化一侧为单个紧邻面板描述对象（数组兼容：紧邻 = 左/上末项、右/下首项）
  function pick(side, fromEnd) {
    if (!side) return null;
    var arr = Array.isArray(side) ? side : [side];
    if (!arr.length) return null;
    return fromEnd ? arr[arr.length - 1] : arr[0];
  }

  function overlay() {
    const o = document.createElement('div');
    o.className = 'qqq-drag-overlay';
    document.body.appendChild(o);
    return o;
  }

  function dragDone(sashEl, ov) {
    sashEl.classList.remove('qqq-sash-dragging', 'qqq-sash-saturated');
    if (ov && ov.parentNode) ov.remove();
    if (window.qqqLayout && window.qqqLayout.persist) window.qqqLayout.persist();
  }

  // 通用两分区守恒拖拽：A = 左(上)面板、B = 右(下)面板；d>0 = 边界向 B 侧移动 = A 增大
  function bindGeneric(sashEl, sideA, sideB, vertical) {
    var A = pick(sideA, true);   // 左/上：取紧邻（末项）
    var B = pick(sideB, false);  // 右/下：取紧邻（首项）
    if (!A || !B) return;
    sashEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var start = vertical ? e.clientY : e.clientX;
      var minA = (A.min != null) ? A.min : layoutMin();
      var maxA = (A.max != null) ? A.max : Infinity;
      var minB = (B.min != null) ? B.min : layoutMin();
      var maxB = (B.max != null) ? B.max : Infinity;
      var wA0 = A.getW ? A.getW() : A.getH();
      var wB0 = B.getW ? B.getW() : B.getH();
      var C = wA0 + wB0; // 守恒快照（拖拽期间恒定）
      var lo = Math.max(minA, C - maxB); // 结构性下限
      var hi = Math.min(maxA, C - minB); // 结构性上限

      sashEl.classList.add('qqq-sash-dragging');
      var ov = overlay();

      var onMove = function (ev) {
        var d = (vertical ? ev.clientY : ev.clientX) - start;
        var saturated = false;
        if (d !== 0 && C > 0 && hi >= lo) {
          var nw = clamp(wA0 + d, lo, hi);
          if (Math.abs(nw - wA0) > 0.5) {
            if (A.setW) A.setW(nw); else A.setH(nw);
            if (B.setW) B.setW(C - nw); else B.setH(C - nw);
          }
          if (nw <= lo + 0.5 || nw >= hi - 0.5) saturated = true;
        } else {
          saturated = true; // 冻结态（容器装不下双方底线）：保持现状，红条提示饱和
        }
        sashEl.classList.toggle('qqq-sash-saturated', saturated);
      };

      var onUp = function () {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        dragDone(sashEl, ov);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---- vertical sash (ew-resize, adjusts widths) ----
  function bindV(sashEl, leftPanels, rightPanels) {
    bindGeneric(sashEl, leftPanels, rightPanels, false);
  }

  // ---- horizontal sash (ns-resize, adjusts heights) ----
  function bindH(sashEl, topPanels, bottomPanels) {
    bindGeneric(sashEl, topPanels, bottomPanels, true);
  }

  window.qqqideSash = { bindV, bindH, MIN: 123 };
})();
