// ============================================================================
// goods/dm/dm.js — inbox goods manifest
//
// ★ 2026-09-14: X 区 file 分组 custom tab（中间/右侧 editor 分组，同 kmd 范式）——
//   不再占用左侧 gaea 分组。打开入口 = qqqGaea.open('inbox') → def.opener →
//   qqqTabs.openFileCustomTab('inbox', ...)。
//   ★ 多开：右键标签「在右侧再开 / 在左侧再开」（onReopen）→ 中间+右侧各可开一个
//   （组级单例：目标组已有 inbox → 激活返回）→ 一个人可同时与几个人聊天。
//   ★ 标签标题随会话实时同步（dm-ui → dm:title 消息 → setCustomTabTitle）。
// 工具栏 inbox 按钮 + 未读徽章由 gaea-host.js 管理（open('inbox') 走本 opener）。
// ============================================================================
(function () {
  'use strict';

  if (!window.qqqGaea) {
    window.addEventListener('DOMContentLoaded', function () {
      if (window.qqqGaea) registerInbox();
    });
    return;
  }

  registerInbox();

  function registerInbox() {
    // ── 打开 inbox：X 区 file 分组 custom tab（中间/右侧 editor 分组，外观同普通文件标签） ──
    //   side: 'right'/'left' → 右键菜单「在右/左组再开」目标组；缺省（工具栏）= 第一个文件组。
    //   组级去重：target 组已有 inbox → 激活返回（「中间和右侧一边开一个」）。
    function openInboxTab(side) {
      if (!window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
      var gs = [];
      try { gs = (window.qqqTabs.getGroups() || []).filter(function (g) { return g.type === 'file'; }); } catch (_) { }
      var target = null;
      if (side === 'right') { target = gs.length >= 2 ? gs[gs.length - 1] : null; }
      else if (side === 'left') { target = gs.length >= 1 ? gs[0] : null; }
      function findIn(grp) {
        if (!grp || !grp.tabs) return null;
        for (var i = 0; i < grp.tabs.length; i++) { if (grp.tabs[i].customId === 'inbox') return grp.tabs[i]; }
        return null;
      }
      if (target) {
        var ex = findIn(target);
        if (ex) { try { window.qqqTabs.activateTab(target, ex.id); } catch (_) { } return true; }
      } else if (!side) {
        // 工具栏/默认：任意已有 inbox → 激活（含右组）
        for (var gi = 0; gi < gs.length; gi++) {
          var e2 = findIn(gs[gi]);
          if (e2) { try { window.qqqTabs.activateTab(gs[gi], e2.id); } catch (_) { } return true; }
        }
      }
      var tab = window.qqqTabs.openFileCustomTab('inbox', '📬 inbox', function (pane, _tab) {
        tab = _tab || tab;   // 时序陷阱（同 kmd）：renderFn 在 return 前同步执行，闭包 tab 此刻可能未赋值
        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
        var iframe = document.createElement('iframe');
        iframe.src = '/qqqide/goods/dm/dm-ui.html';
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        iframe.setAttribute('frameborder', '0');
        pane.appendChild(iframe);
        // 标题同步：dm-ui 打开会话/改备注 → dm:title → 标签实时显示对方/群名（多开时一眼分辨）
        window.addEventListener('message', function (e) {
          if (!e.data || e.source !== iframe.contentWindow) return;
          if (e.data.type !== 'dm:title') return;
          if (tab && window.qqqTabs.setCustomTabTitle) {
            window.qqqTabs.setCustomTabTitle(tab.id, String(e.data.title || ''));
          }
        });
      }, { closable: true, allowMulti: true, group: side || null });
      // ★ 右键菜单「在右/左组再开」——goods 自管重开（组级去重由 openInboxTab 内部裁决）
      if (tab) { tab.onReopen = function (s) { return openInboxTab(s); }; }
      return !!tab;
    }

    window.qqqGaea.register({
      id: 'inbox',
      title: 'inbox',
      version: '2.4.0',  // 2026-09-14: X 区 file 分组多开（右键在右/左组再开）+ 标签标题随会话同步
      protoVer: 2,

      // ★ 打开路由：gaea-host.open('inbox') → opener → file 分组 custom tab（中间/右侧）
      opener: function () { return openInboxTab(); },

      uses: []
    });
  }
})();
