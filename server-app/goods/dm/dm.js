// ============================================================================
// goods/dm/dm.js — inbox goods manifest
//
// X 区 file 分组 custom tab（中间/右侧 editor 分组，同 kmd 范式）——不占用左侧 gaea 分组。
//   打开入口 = qqqGaea.open('inbox') → def.opener → qqqTabs.openFileCustomTab('inbox', …)。
//   多开：右键标签「在右侧再开 / 在左侧再开」（onReopen）→ 中间+右侧各可开一个
//   （组级单例：目标组已有 inbox → 激活返回）→ 一个人可同时与几个人聊天。
//   标签标题随会话实时同步（dm-ui → dm:title，携 peer → setCustomTabTitle + getState）。
//   可见性：tab-manager.activateTab → tab._onVisible → iframe {type:'dm:visible'}（非活动 tab 静默）。
//   持久化：qqqTabs.registerCustomTabRestorer('inbox', …) —— 多开布局 + 会话随重启还原。
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
    //   opt.side     'right'/'left' → 右键菜单「在右/左组再开」目标组；缺省（工具栏）= 第一个文件组
    //   opt.groupIdx 恢复路径：回原组（绝对组序号）
    //   opt.peer     恢复路径：直接打开某会话（doerID / 群 key g<gid>）
    //   组级去重：target 组已有 inbox → 激活返回（「中间和右侧一边开一个」）。
    function openInboxTab(opt) {
      if (!window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
      var o = (typeof opt === 'string') ? { side: opt } : (opt || {});
      var side = o.side || null;
      var curPeer = o.peer || '';   // 会话身份（持久化用：tab.getState → {peer}）
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
      } else if (!side && typeof o.groupIdx !== 'number') {
        // 工具栏/默认：任意已有 inbox → 激活（含右组）
        for (var gi = 0; gi < gs.length; gi++) {
          var e2 = findIn(gs[gi]);
          if (e2) { try { window.qqqTabs.activateTab(gs[gi], e2.id); } catch (_) { } return true; }
        }
      }
      var tab = window.qqqTabs.openFileCustomTab('inbox', o.title || 'inbox', function (pane, _tab) {
        tab = _tab || tab;   // 时序陷阱（同 kmd）：renderFn 在 return 前同步执行，闭包 tab 此刻可能未赋值
        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
        var iframe = document.createElement('iframe');
        // 恢复路径：?peer= 直接打开上次的会话（dm-ui 载入后消费）
        iframe.src = '/qqqide/goods/dm/dm-ui.html' + (o.peer ? ('?peer=' + encodeURIComponent(o.peer)) : '');
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        iframe.setAttribute('frameborder', '0');
        pane.appendChild(iframe);
        window.addEventListener('message', function (e) {
          if (!e.data || e.source !== iframe.contentWindow) return;
          var tb = _tab || tab;
          if (e.data.type === 'dm:title') {
            // 标题同步：打开会话/改备注 → dm:title（携 peer）→ 标签实时显示对方/群名（多开时一眼分辨）
            curPeer = String(e.data.peer || '');
            if (tb && window.qqqTabs.setCustomTabTitle) {
              window.qqqTabs.setCustomTabTitle(tb.id, String(e.data.title || ''));
            }
          } else if (e.data.type === 'dm:ready') {
            // iframe 就绪回执 → 下发真实可见性（后台恢复的 tab 出生即非活动，初始态不能猜 true）
            try { iframe.contentWindow.postMessage({ type: 'dm:visible', visible: !!(tb && tb.active) }, '*'); } catch (_) { }
          }
        });
        // tab 可见性事件驱动（tab-manager.activateTab 唯一派发）——非活动 tab 零渲染零轮询
        var self = _tab || tab;
        if (self) {
          self._onVisible = function (v) {
            try { iframe.contentWindow.postMessage({ type: 'dm:visible', visible: !!v }, '*'); } catch (_) { }
          };
        }
      }, { closable: true, allowMulti: true, group: side || null,
           groupIdx: (typeof o.groupIdx === 'number') ? o.groupIdx : undefined });
      if (tab) {
        // ★ 右键菜单「在右/左组再开」——goods 自管重开（组级去重由 openInboxTab 内部裁决）
        tab.onReopen = function (s) { return openInboxTab({ side: s }); };
        // ★ 持久化快照（tab-manager 收集 → 重启还原多开布局与会话）
        tab.getState = function () { return { peer: curPeer }; };
      }
      return !!tab;
    }

    // ★ 多开 tab 恢复器（tab-manager 启动恢复唯一通道；未注册 = 不持久化）
    if (window.qqqTabs && window.qqqTabs.registerCustomTabRestorer) {
      window.qqqTabs.registerCustomTabRestorer('inbox', function (o) {
        return openInboxTab({
          groupIdx: o && o.groupIdx,
          title: (o && o.title) || 'inbox',
          peer: (o && o.state && o.state.peer) || ''
        });
      });
    }

    window.qqqGaea.register({
      id: 'inbox',
      title: 'inbox',
      version: '2.5.0',  // 多开布局持久化（getState/恢复器）+ 可见性事件（非活动 tab 静默）
      protoVer: 2,

      // ★ 打开路由：gaea-host.open('inbox') → opener → file 分组 custom tab（中间/右侧）
      opener: function () { return openInboxTab(); },

      uses: []
    });
  }
})();
