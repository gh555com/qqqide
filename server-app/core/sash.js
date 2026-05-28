// ============================================================================
// sash.js - QQQ Shell v2 sash engine with cascading compression
//
// API: window.qqqSash = { bindV, bindH }
//
// bindV(sashEl, leftFn, rightFn, opts):
//   leftFn()  -> { el, getW, setW, min }   (can return array for cascade)
//   rightFn() -> { el, getW, setW, min }
//
// Cascading: drag compresses immediate neighbor; when neighbor hits min,
// excess compresses the next neighbor, and so on.
// ============================================================================
(function () {
  'use strict';

  const MIN = 123;

  // ---- helpers ----
  function overlay(cursor) {
    const o = document.createElement('div');
    o.className = 'qqq-drag-overlay';
    o.style.cursor = cursor;
    document.body.appendChild(o);
    return o;
  }

  // ---- vertical sash (ew-resize, adjusts widths) ----
  // leftPanels / rightPanels: arrays of { el, getW, setW, min }
  // When dragging right: shrink right panels (cascade from first to last)
  // When dragging left:  shrink left  panels (cascade from last to first)
  function bindV(sashEl, leftPanels, rightPanels) {
    sashEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;

      // snapshot starting widths
      const lSnap = leftPanels.map(p => ({ w: p.getW(), min: p.min || MIN }));
      const rSnap = rightPanels.map(p => ({ w: p.getW(), min: p.min || MIN }));

      sashEl.classList.add('qqq-sash-dragging');
      const ov = overlay('ew-resize');

      const onMove = ev => {
        let dx = ev.clientX - startX;
        let saturated = false;

        if (dx > 0) {
          // dragging right -> grow left (last), shrink right (first to last)
          let remaining = dx;
          // shrink rights
          for (let i = 0; i < rSnap.length && remaining > 0; i++) {
            const newW = Math.max(rSnap[i].min, rSnap[i].w - remaining);
            const consumed = rSnap[i].w - newW;
            rightPanels[i].setW(newW);
            remaining -= consumed;
            if (newW <= rSnap[i].min) saturated = true;
          }
          // give consumed to left (last to first)
          const totalConsumed = dx - remaining;
          leftPanels[leftPanels.length - 1].setW(lSnap[lSnap.length - 1].w + totalConsumed);
        } else if (dx < 0) {
          // dragging left -> shrink left (last to first), grow right (first)
          let remaining = -dx;
          for (let i = lSnap.length - 1; i >= 0 && remaining > 0; i--) {
            const newW = Math.max(lSnap[i].min, lSnap[i].w - remaining);
            const consumed = lSnap[i].w - newW;
            leftPanels[i].setW(newW);
            remaining -= consumed;
            if (newW <= lSnap[i].min) saturated = true;
          }
          const totalConsumed = -dx - remaining;
          rightPanels[0].setW(rSnap[0].w + totalConsumed);
        }

        sashEl.classList.toggle('qqq-sash-saturated', saturated);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        sashEl.classList.remove('qqq-sash-dragging', 'qqq-sash-saturated');
        ov.remove();
        // persist layout after drag
        if (window.qqqLayout && window.qqqLayout.persist) window.qqqLayout.persist();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---- horizontal sash (ns-resize, adjusts heights) ----
  // topPanels / bottomPanels: arrays of { el, getH, setH, min }
  function bindH(sashEl, topPanels, bottomPanels) {
    sashEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;

      const tSnap = topPanels.map(p => ({ h: p.getH(), min: p.min || MIN }));
      const bSnap = bottomPanels.map(p => ({ h: p.getH(), min: p.min || MIN }));

      sashEl.classList.add('qqq-sash-dragging');
      const ov = overlay('ns-resize');

      const onMove = ev => {
        let dy = ev.clientY - startY;
        let saturated = false;

        if (dy > 0) {
          // dragging down -> grow top (last), shrink bottom (first to last)
          let remaining = dy;
          for (let i = 0; i < bSnap.length && remaining > 0; i++) {
            const newH = Math.max(bSnap[i].min, bSnap[i].h - remaining);
            const consumed = bSnap[i].h - newH;
            bottomPanels[i].setH(newH);
            remaining -= consumed;
            if (newH <= bSnap[i].min) saturated = true;
          }
          const totalConsumed = dy - remaining;
          topPanels[topPanels.length - 1].setH(tSnap[tSnap.length - 1].h + totalConsumed);
        } else if (dy < 0) {
          // dragging up -> shrink top (last to first), grow bottom (first)
          let remaining = -dy;
          for (let i = tSnap.length - 1; i >= 0 && remaining > 0; i--) {
            const newH = Math.max(tSnap[i].min, tSnap[i].h - remaining);
            const consumed = tSnap[i].h - newH;
            topPanels[i].setH(newH);
            remaining -= consumed;
            if (newH <= tSnap[i].min) saturated = true;
          }
          const totalConsumed = -dy - remaining;
          bottomPanels[0].setH(bSnap[0].h + totalConsumed);
        }

        sashEl.classList.toggle('qqq-sash-saturated', saturated);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        sashEl.classList.remove('qqq-sash-dragging', 'qqq-sash-saturated');
        ov.remove();
        if (window.qqqLayout && window.qqqLayout.persist) window.qqqLayout.persist();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  window.qqqSash = { bindV, bindH, MIN };
})();
