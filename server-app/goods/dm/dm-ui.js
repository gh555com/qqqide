(function () {
  'use strict';

  // i18n 小助手：_kk(key, fallback[, v0[, v1...]]) —— {0}/{1}... 用 split/join 替换（防 $ 特殊字符）
  var _kk = function (key, fb) { var s = window._i ? window._i(key, fb) : fb; for (var i = 2; i < arguments.length; i++) { s = String(s).split('{' + (i - 2) + '}').join(arguments[i]); } return s; };

  // ═══ STATE ═══
  var _token = '';
  var _doerID = '';
  var _doerName = '';
  var _ws = null;
  var _wsReconnectTimer = null;
  var _wsReconnectDelay = 0;   // 指数退避基数（0/5s/10s/20s/30s…），连上即清零
  var _convMap = {};       // peerID → {unread,lastMsg,lastTime,peerName}
  var _activePeer = null;
  var _msgCache = {};      // peerID → [{id,sender_id,content,created_at}]
  var _searchFilter = '';
  var _bgMode = false;       // 节能模式：窗口不可见 → 断 WS，60s REST 轮询仅未读数
  var _bgPollTimer = null;
  var _loadingMore = false;      // 历史分页加载中（防重复点击）
  var _noMoreOld = {};           // peerID → 已翻到最早，不再显示「加载更早」
  // 待发送附件 — per-peer 独立（切会话不串不残留，2026-09-14 重写）
  // chip = {id, file, name, size, loaded, mime, url(缩略图objectURL), status: pending|uploading|done|failed, att(上传成功结果), err}
  var _pendingByPeer = {};       // peerKey → [chip]（先传后发：发送时逐文件上传 bed 1ge/10MB）
  var _sending = false;          // 附件上传+发送中（防 Enter 重入）
  var _sendCtl = null;           // 当前上传会话 {peer, canceled, failed, active, xhrs[], t0, phase, taskId}
  var _chipSeq = 0;
  var _doerPhoneMask = '';       // 自己手机号（JWT payload.phone 脱敏格式 158****8204，自投拦截用）

  var $convList   = document.getElementById('conv-list');
  var $chatHeader = document.getElementById('chat-header');
  var $chatHdrName= document.getElementById('chat-header-name');
  var $chatHdrStat= document.getElementById('chat-header-status');
  var $msgList    = document.getElementById('msg-list');
  var $inputArea  = document.getElementById('input-area');
  var $msgInput   = document.getElementById('msg-input');
  var $sendBtn    = document.getElementById('send-btn');
  var $emptyState = document.getElementById('empty-state');
  var $connDot    = document.getElementById('connection-dot');
  var $connText   = document.getElementById('connection-text');
  var $searchInput= document.getElementById('search-input');
  var $newPeerIn  = document.getElementById('new-peer-input');
  var $btnNewMsg  = document.getElementById('btn-new-msg');
  var $btnNewGroup= document.getElementById('btn-new-group');
  var $modalMask  = document.getElementById('modal-mask');
  var $modalTitle = document.getElementById('modal-title');
  var $modalBody  = document.getElementById('modal-body');
  var $modalOk    = document.getElementById('modal-ok');
  var $modalCancel= document.getElementById('modal-cancel');
  var $attachBar  = document.getElementById('attach-bar');
  var $bedEntry   = document.getElementById('bed-entry');
  var $bedFiles   = document.getElementById('bed-files');
  var $bedSize    = document.getElementById('bed-size');

  // ═══ 逐字回退（唯一真理机器接管 Ctrl+Z/Y，AI 面板同款）═══
  if (window.qqqCharUndo && typeof window.qqqCharUndo.attach === 'function') {
    window.qqqCharUndo.attach($msgInput);
  }

  // 群会话 key = 'g' + gid（与私聊 doerID/手机号天然不冲突）
  function gkey(gid) { return 'g' + gid; }
  function isGroupKey(key) { return key && key.charAt(0) === 'g' && /^g\d+$/.test(key); }

  // ═══ SPLITTER — 左右比例拖动（160-640px 钳制，宽度持久化 localStorage）═══
  var $sidebar = document.getElementById('sidebar');
  var $splitter = document.getElementById('splitter');
  function applySidebarW(w) {
    w = Math.max(160, Math.min(640, w));
    $sidebar.style.width = w + 'px';
  }
  try {
    var savedW = parseInt(localStorage.getItem('dm.sidebarW') || '', 10);
    if (savedW) applySidebarW(savedW);
  } catch(_) {}
  $splitter.addEventListener('mousedown', function(e) {
    e.preventDefault();
    $splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    var startX = e.clientX;
    var startW = $sidebar.getBoundingClientRect().width;
    function onMove(ev) { applySidebarW(startW + (ev.clientX - startX)); }
    function onUp() {
      $splitter.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('dm.sidebarW', String(Math.round($sidebar.getBoundingClientRect().width))); } catch(_) {}
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ═══ LOCAL CACHE — 会话/消息本地缓存（localStorage 防抖落盘）═══
  // 设计: 服务器 PG 为唯一真理源，本地仅作「秒开 + 离线可读 + 历史分页累积」加速层
  //   · 启动: 缓存先渲染 → loadConversations/loadMessages 增量合并修正（服务器权威覆盖未读数）
  //   · 历史: 服务器 ?before=<id> 游标分页（handler 已支持），本地按 id 合并去重
  //   · 容量: 单会话 300 条 / 全会话 3000 条，超限按最后活跃裁剪（localStorage 5MB 安全余量）
  var _CACHE_KEY = 'dm.cache.v1';
  var _CACHE_MAX_PER_CONV = 300;
  var _CACHE_MAX_TOTAL = 3000;
  var _cacheTimer = null;

  function _mergeMsgs(a, b) {
    var byId = {};
    (a||[]).forEach(function(m){ if (m && m.id) byId[m.id] = m; });
    (b||[]).forEach(function(m){ if (m && m.id) byId[m.id] = m; });
    return Object.keys(byId).map(function(id){ return byId[id]; })
      .sort(function(x,y){ return x.id - y.id; });
  }

  function _cacheSaveSoon() {
    if (_cacheTimer) clearTimeout(_cacheTimer);
    _cacheTimer = setTimeout(_cacheSave, 600);
  }

  function _cacheSave() {
    _cacheTimer = null;
    try {
      var msgs = {}, convs = {}, total = 0;
      Object.keys(_msgCache).forEach(function(pid){
        var arr = _msgCache[pid];
        if (!Array.isArray(arr) || !arr.length) return;
        msgs[pid] = arr.slice(-_CACHE_MAX_PER_CONV);   // 单会话只保最近 N 条
        total += msgs[pid].length;
      });
      // 全局超限 → 按最后活跃裁剪最不活跃会话
      if (total > _CACHE_MAX_TOTAL) {
        var order = Object.keys(msgs).sort(function(x,y){
          var tx = msgs[x][msgs[x].length-1].created_at || '';
          var ty = msgs[y][msgs[y].length-1].created_at || '';
          return tx < ty ? -1 : 1;
        });
        while (total > _CACHE_MAX_TOTAL && order.length > 1) {
          var victim = order.shift();
          total -= msgs[victim].length;
          delete msgs[victim];
        }
      }
      Object.keys(_convMap).forEach(function(pid){
        var c = _convMap[pid] || {};
        convs[pid] = {kind:c.kind||'dm', gid:c.gid||0, gname:c.gname||'', memberCnt:c.memberCnt||0,
                      lastSender:c.lastSender||'', unread:c.unread||0, lastMsg:c.lastMsg||'',
                      lastTime:c.lastTime||'', peerName:c.peerName||'', phone:c.phone||'', country:c.country||'',
                      nickname:c.nickname||''};
      });
      localStorage.setItem(_CACHE_KEY, JSON.stringify({convs:convs, msgs:msgs, savedAt:Date.now()}));
    } catch(_) {}   // 超限/不可用 → 放弃缓存，绝不阻塞运行
  }

  function _cacheLoad() {
    try {
      var raw = localStorage.getItem(_CACHE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || !d.convs) return;
      _convMap = d.convs || {};
      _msgCache = d.msgs || {};
    } catch(_) {}
  }

  // ═══ THEME（2026-09-14 重写：父窗口直读 + MutationObserver + qqqide-theme-change 广播 三路同步）═══
  // 旧版只监听 'theme-change' 消息（无人发送）→ IDE 切暗色永不生效；现对齐 conv/search 同款机制
  function applyTheme(dark) {
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }
  function readParentDark() {
    try {
      var el = parent.document.documentElement;
      if (el.getAttribute('data-theme') === 'dark') return true;
      if (el.classList && el.classList.contains('dark')) return true;
      return false;   // 能读到父文档 → 权威判定：无 dark 标记即亮色
    } catch(_) {}
    try {
      if (parent.qqqideTheme && typeof parent.qqqideTheme.isDark === 'function') return !!parent.qqqideTheme.isDark();
    } catch(_) {}
    return null;      // 无法判定（跨源）→ 交由 request 回包/广播驱动
  }
  function syncTheme() {
    var d = readParentDark();
    if (d !== null) applyTheme(d);
  }
  syncTheme();
  try {
    new MutationObserver(syncTheme).observe(parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  } catch(_) {}
  window.addEventListener('message', function(e) {
    var d = e.data || {};
    if (d.type === 'qqqide-theme-change') {          // 标准广播（qqqide-theme.js / gaea-host.js）
      if (typeof d.dark === 'boolean') applyTheme(d.dark);
      else syncTheme();
    } else if (d.type === 'theme-change') {          // 旧版兼容
      if (d.theme !== undefined) applyTheme(d.theme === 'dark');
      else if (typeof d.dark === 'boolean') applyTheme(d.dark);
    }
  });
  // 冷启动竞态兜底：主动请求一次当前主题（qqqide-theme.js 回应 qqqide-theme-request）
  try { parent.postMessage({ type: 'qqqide-theme-request' }, '*'); } catch(_) {}

  // ═══ FLAG — 照抄登录区国旗机制（本地 assets/flags/{cc}.png，一次拿到永久使用）═══
  // 国旗由服务器随国家码（country_iso2）下发，账号不变国旗永不变 → 零更新逻辑
  // iframe 位于 /qqqide/goods/dm/ → 国旗根 = location.pathname 截取 /goods/ 前缀
  var _flagBase = (function(){
    try {
      var p = location.pathname || '';
      var idx = p.indexOf('/goods/');
      return (idx > 0 ? p.slice(0, idx) : '') + '/assets/flags/';
    } catch(_) { return 'assets/flags/'; }
  })();
  function flagImg(cc) {
    if (!cc || cc.length !== 2) return '';
    var c = cc.toLowerCase();
    return '<img src="'+_flagBase+c+'.png" width="18" height="13" loading="lazy" ' +
      'style="vertical-align:-2px;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,0.1);object-fit:cover;" ' +
      'alt="" title="'+cc.toUpperCase()+'" onerror="this.style.display=\'none\'">';
  }

  // ═══ WS 心跳（应用层 keepalive：防 CF/中间设备静默断开，5s 无响应则主动重连）═══
  var _beatTimer = null;
  var _beatMiss = 0;
  function startBeat() {
    stopBeat();
    _beatTimer = setInterval(function(){
      if (!_ws || _ws.readyState !== 1) return;
      try { _ws.send(JSON.stringify({type:'ping'})); _beatMiss = 0; } catch(_) {}
    }, 30000);
  }
  function stopBeat() {
    if (_beatTimer) { clearInterval(_beatTimer); _beatTimer = null; }
  }

  // ═══ INIT ═══
  init();
  function init() {
    getAuth(function(tok, did, name) {
      if (!tok) { setConnStatus(false, _kk('goods.dm.notLoggedIn', '未登录')); return; }
      _token = tok;
      _doerID = did;
      _doerName = name || did;
      _doerPhoneMask = (name && name.indexOf('****') >= 0) ? name : '';
      if (!_doerID) { setConnStatus(false, _kk('goods.dm.authAbnormal', '登录信息异常')); return; }
      _cacheLoad();   // 本地缓存秒开（离线也能看历史，服务器随后增量修正）
      if (Object.keys(_convMap).length) {
        renderConvList();
        setConnStatus(false, _kk('goods.dm.cacheSync', '缓存模式 · 同步中…'));
      }
      connectWS();
      loadConversations();
      loadGroups();
      loadBedStats();
      bindVisibility();
    });
  }

  function getAuth(cb) {
    try {
      var L = parent.window.qqqLogin;
      if (L) {
        var tok = L.getAuthToken();
        if (tok) {
          try {
            var parts = tok.split('.');
            if (parts.length === 3) {
              var payload = JSON.parse(atob(parts[1]));
              var did = (payload.uid || payload.doer_id || '').replace(/^\+/,'');
              cb(tok, did, payload.phone || '');
              return;
            }
          } catch(_) {}
          cb(tok, '', '');
          return;
        }
      }
    } catch(_) {}
    // Fallback: try grandparent (AI panel nesting)
    try {
      var L2 = parent.parent.window.qqqLogin;
      if (L2) {
        var tok2 = L2.getAuthToken();
        if (tok2) {
          try {
            var p2 = tok2.split('.');
            var pl = JSON.parse(atob(p2[1]));
          var did2 = (pl.uid || pl.doer_id || '').replace(/^\+/,'');
          cb(tok2, did2, pl.phone || '');
          return;
          } catch(_) {}
          cb(tok2, '', '');
          return;
        }
      }
    } catch(_) {}
    cb('', '', '');
  }

  // ═══ WS ═══
  function connectWS() {
    if (!_doerID) return;
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    // ★ 断线重连指数退避（30s 上限）：服务器重启时 5s 固定重连风暴打满 502 → 永远连不上
    _wsReconnectDelay = Math.min((_wsReconnectDelay || 0) + 5000, 30000);

    var wsUrl = 'wss://cnk.gh555.com/ws?token=' + encodeURIComponent(_token);
    var ws = _ws = new WebSocket(wsUrl);
    setConnStatus(false, _kk('goods.dm.connecting', '连接中…'));

    ws.onopen = function() {
      // ★ 节能握手窗口废弃（2026-09-14）：窗口隐藏时连接仍在 CONNECTING → 不立即 close（Chrome 打
      //   "closed before the connection is established" 噪音）→ 置 _qqqDead 标记，握手完成瞬间在此自关，零噪音零副作用
      if (ws._qqqDead) { try { ws.close(); } catch(_) {} return; }
      _wsReconnectDelay = 0;  // 连上即重置退避
      setConnStatus(true, _kk('goods.dm.connected', '已连接'));
      ws.send(JSON.stringify({type:'sub',ch:'inbox:'+_doerID}));
      startBeat();
    };

    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'dm_msg' && msg.data) {
          handlePush(msg.data);
        } else if (msg.type === 'group_msg' && msg.data) {
          handleGroupPush(msg.data);
        } else if (msg.type === 'ok' && msg.ref === 'sub') {
          setConnStatus(true, _kk('goods.dm.inboxReady', '收件箱已就绪'));
 		}
		// 在线状态唯一真理 = 服务端 wq.doer_state 最近1h ping（随 conversations 批量下发）
		// WS 不再携带任何在线/离线事件
      } catch(_) {}
    };

    ws.onclose = function() {
      stopBeat();
      if (_bgMode) { setConnStatus(false, _kk('goods.dm.bgMode', '节能 · 后台仅未读数')); return; }  // 节能不重连
      setConnStatus(false, _kk('goods.dm.reconnecting', '断开 · {0}s 重连', Math.round(_wsReconnectDelay/1000)));
      _wsReconnectTimer = setTimeout(connectWS, _wsReconnectDelay);
    };

    ws.onerror = function() { /* onclose fires next */ };
  }

  function setConnStatus(ok, text) {
    $connDot.className = ok ? '' : 'offline';
    $connText.textContent = text;
  }

  // ═══ 节能模式（窗口不可见 → 断 WS 长连接，60s REST 轮询只维护未读数）═══
  // 开销对比: 常驻 WS = 服务器长连接 + 30s 心跳; 后台轮询 = 服务器零驻留 + 60s 一次 ~1KB HTTP
  function isHidden() {
    try { if (document.hidden) return true; } catch(_) {}
    try { if (parent.document && parent.document.hidden) return true; } catch(_) {}
    return false;
  }
  function enterBg() {
    if (_bgMode) return;
    _bgMode = true;
    stopBeat();
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    // ★ 安全关闭（2026-09-14）：CONNECTING 状态直接 close 会打 Chrome「closed before established」噪音
    //   → 只置废弃标记（连上后由 onopen dead 分支自关）；仅 OPEN 状态才立即 close
    if (_ws) {
      var _w = _ws; _ws = null;
      try { _w.onclose = null; } catch(_) {}
      try { _w._qqqDead = true; } catch(_) {}
      try { if (_w.readyState === WebSocket.OPEN) _w.close(); } catch(_) {}
    }
    setConnStatus(false, _kk('goods.dm.bgMode', '节能 · 后台仅未读数'));
    startBgPoll();
  }
  function exitBg() {
    if (!_bgMode) return;
    _bgMode = false;
    stopBgPoll();
    _wsReconnectDelay = 0;   // 前台恢复 → 重连退避归零
    connectWS();             // 恢复实时推送
    loadConversations();     // 补后台错过的会话（含在线状态，回来时自动刷新头部）
    if (_activePeer) {
      loadMessages(_activePeer);  // 后台期间到达的消息正文
    }
  }
  function startBgPoll() {
    stopBgPoll();
    bgPoll();
    _bgPollTimer = setInterval(bgPoll, 60000);
  }
  function stopBgPoll() {
    if (_bgPollTimer) { clearInterval(_bgPollTimer); _bgPollTimer = null; }
  }
  function bgPoll() {
    if (!_token) return;
    fetch('https://cnk.gh555.com/api/dm/conversations', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (!d.conversations) return;
         d.conversations.forEach(function(cv){
          var c = _convMap[cv.peer_id];
          if (!c) { c = _convMap[cv.peer_id] = {unread:0,lastMsg:'',lastTime:'',peerName:'',phone:'',country:''}; }
          c.unread = cv.unread_count || 0;
          if (cv.last_msg) c.lastMsg = cv.last_msg;
          if (cv.last_time) c.lastTime = cv.last_time;
          if (cv.peer_name) c.peerName = cv.peer_name;
          if (cv.peer_phone) c.phone = cv.peer_phone;
          if (cv.peer_country) c.country = cv.peer_country;
          c.nickname = cv.nickname || '';
        });
      // 窗口级徽章由 gaea-host 自己的 WS/轮询管理；此处免 DOM 渲染（不可见无意义）
      _cacheSaveSoon();   // 后台轮询拿到的未读数/预览也入缓存 → 重启后启动即准
    }).catch(function(){});
    // 群未读同样轮询（仅数据，不渲染）
    fetch('https://cnk.gh555.com/api/group/list', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (d.groups) {
        d.groups.forEach(function(g){
          var key = gkey(g.gid);
          var c = _convMap[key];
          if (!c) { c = _convMap[key] = {kind:'group', gid:g.gid, gname:g.gname||_kk('goods.dm.group', '群'), memberCnt:g.member_cnt||0, unread:0, lastMsg:'', lastTime:''}; }
          c.unread = g.unread_count || 0;
          if (g.last_msg) c.lastMsg = g.last_msg;
          if (g.last_time) c.lastTime = g.last_time;
          if (g.last_sender) c.lastSender = g.last_sender;
        });
        _cacheSaveSoon();
      }
    }).catch(function(){});
  }
  function bindVisibility() {
    function onVis() { if (isHidden()) enterBg(); else exitBg(); }
    document.addEventListener('visibilitychange', onVis);
    try { parent.document.addEventListener('visibilitychange', onVis); } catch(_) {}
    onVis();  // 初始状态直接判定：启动即最小化 → 立即节能
  }

  // ═══ PUSH HANDLER ═══
  function handlePush(dm) {
    var peerID = dm.sender_id === _doerID ? dm.recipient_id : dm.sender_id;
    // id 去重：REST 响应与 WS 回显（发送方）可能携带同一条消息
    var dup = cacheHas(peerID, dm.id);

    // Init conversation
    if (!_convMap[peerID]) {
      _convMap[peerID] = {unread:0,lastMsg:'',lastTime:'',peerName:'',phone:'',country:''};
    }
    var cv = _convMap[peerID];
    cv.lastMsg = dm.content || ((Array.isArray(dm.attachments) && dm.attachments.length) ? ((dm.attachments[0].mime||'').indexOf('image/')===0 ? _kk('goods.dm.previewImage', '[图片]') : _kk('goods.dm.previewFile', '[文件]')) : '');
    cv.lastTime = dm.created_at;

    // 联系人手机号/国旗回填（推送携带双方信息 → 首次建联即带国旗）
    if (!cv.phone) cv.phone = dm.sender_id === _doerID ? (dm.recipient_phone||'') : (dm.sender_phone||'');
    if (!cv.country) cv.country = dm.sender_id === _doerID ? (dm.recipient_country||'') : (dm.sender_country||'');

    if (dm.sender_id === _doerID) {
      cv.peerName = cv.peerName || dm.recipient_phone || dm.recipient_id;
    } else {
      cv.peerName = dm.sender_name || dm.sender_phone || dm.sender_id;
 	      if (_activePeer !== peerID) {
        if (!dup) cv.unread = (cv.unread||0) + 1;
 	      }
    }

    // Cache（去重后写入）
    if (!_msgCache[peerID]) _msgCache[peerID] = [];
    if (!dup) _msgCache[peerID].push(dm);

    renderConvList();

    if (_activePeer === peerID && !dup) {
      appendBubble(dm);
      scrollBottom();
      if (dm.sender_id !== _doerID) {
        // Tell parent to reset unread badge
        try { if (parent.qqqGaea && parent.qqqGaea.resetInboxUnread) parent.qqqGaea.resetInboxUnread(); } catch(_) {}
      }
    }
    _cacheSaveSoon();
  }

  // ═══ 群会话 REST ═══
  function loadGroups() {
    if (!_token) return;
    fetch('https://cnk.gh555.com/api/group/list', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (d.groups) {
        d.groups.forEach(function(g){
          var key = gkey(g.gid);
          var c = _convMap[key] || {kind:'group', gid:g.gid};
          c.kind = 'group';
          c.gid = g.gid;
          c.gname = g.gname || c.gname || _kk('goods.dm.group', '群');
          c.memberCnt = g.member_cnt || 0;
          c.unread = g.unread_count || 0;
          if (g.last_msg) c.lastMsg = g.last_msg;
          if (g.last_time) c.lastTime = g.last_time;
          if (g.last_sender) c.lastSender = g.last_sender;
          _convMap[key] = c;
        });
        renderConvList();
        _cacheSaveSoon();
      }
    }).catch(function(){});
  }

  // ═══ 群消息推送（WS group_msg → inbox 频道）═══
  function handleGroupPush(d) {
    var key = gkey(d.gid);
    var dup = cacheHas(key, d.id);

    if (!_convMap[key]) {
      _convMap[key] = {kind:'group', gid:d.gid, gname:d.gname||_kk('goods.dm.group', '群'), unread:0, lastMsg:'', lastTime:'', memberCnt:0};
    }
    var cv = _convMap[key];
    cv.lastMsg = d.content || ((Array.isArray(d.attachments) && d.attachments.length) ? ((d.attachments[0].mime||'').indexOf('image/')===0 ? _kk('goods.dm.previewImage', '[图片]') : _kk('goods.dm.previewFile', '[文件]')) : '');
    cv.lastTime = d.created_at;
    if (d.sender_name) cv.lastSender = d.sender_name;
    if (d.gname && !cv.gname) cv.gname = d.gname;

    var isSelf = d.sender_id === _doerID;
    if (!isSelf && _activePeer !== key && !dup) {
      cv.unread = (cv.unread||0) + 1;
    }

    if (!_msgCache[key]) _msgCache[key] = [];
    if (!dup) _msgCache[key].push(d);

    renderConvList();
    if (_activePeer === key && !dup) {
      appendBubble(d);
      scrollBottom();
      if (!isSelf) {
        try { if (parent.qqqGaea && parent.qqqGaea.resetInboxUnread) parent.qqqGaea.resetInboxUnread(); } catch(_) {}
      }
    }
    _cacheSaveSoon();
  }

  // ═══ REST ═══
  function loadConversations() {
    if (!_token) return;
    fetch('https://cnk.gh555.com/api/dm/conversations', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (d.conversations) {
        d.conversations.forEach(function(cv){
          // ★ 永久联系人：服务器 PG 为唯一真理源，重启 IDE 后此列表原样恢复
          _convMap[cv.peer_id] = {
            unread: cv.unread_count||0,
            lastMsg: cv.last_msg||'',
            lastTime: cv.last_time||'',
            peerName: cv.peer_name||cv.peer_phone||cv.peer_id,
            phone: cv.peer_phone||'',
            country: cv.peer_country||'',  // ISO2 → 国旗
            nickname: cv.nickname||''      // 我对此人的备注（对方不可见）
          };
        });
        renderConvList();
        _cacheSaveSoon();
        // Notify parent to reset badge after initial load
        try { if (parent.qqqGaea && parent.qqqGaea.resetInboxUnread) parent.qqqGaea.resetInboxUnread(); } catch(_) {}
      }
    }).catch(function(){});
  }

  function loadMessages(peerID) {
    if (!_token) return;
    fetch('https://cnk.gh555.com/api/dm/messages?peer='+encodeURIComponent(peerID)+'&limit=99', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (d.messages) {
        // 服务器已解析 peer 为 doer ID → 迁移 key（手机号→doerID，联系人归一）
        if (d.peer && d.peer !== peerID) {
          if (_convMap[peerID] && !_convMap[d.peer]) {
            _convMap[d.peer] = _convMap[peerID];
            delete _convMap[peerID];
          }
          if (_msgCache[peerID] && !_msgCache[d.peer]) {
            _msgCache[d.peer] = _msgCache[peerID];
            delete _msgCache[peerID];
          }
          if (_activePeer === peerID) _activePeer = d.peer;
          peerID = d.peer;
        }
        _msgCache[peerID] = _mergeMsgs(_msgCache[peerID] || [], d.messages);   // 服务器最新段 + 本地更早分页历史，按 id 合并去重
        // 联系人回填：历史消息携带双方手机号/国家码 → 建立联系人+国旗
        d.messages.forEach(function(m){
          var isPeerSide = m.sender_id !== _doerID;
          var c = _convMap[isPeerSide ? m.sender_id : m.recipient_id];
          if (!c) return;
          var ph = isPeerSide ? (m.sender_phone||'') : (m.recipient_phone||'');
          var cc = isPeerSide ? (m.sender_country||'') : (m.recipient_country||'');
          if (ph && !c.phone) c.phone = ph;
          if (cc && !c.country) c.country = cc;
          if (!c.peerName) c.peerName = ph || (isPeerSide ? (m.sender_name||m.sender_id) : m.recipient_id);
        });
        renderConvList();
        // 联系人回填后刷新头部国旗/名字（曾用手机号打开 → 现在有国家码了）
        if (_activePeer === peerID) refreshChatHeader();
        renderMessages(peerID);
        _cacheSaveSoon();
      } else if (_activePeer === peerID && (!_msgCache[peerID] || !_msgCache[peerID].length)) {
        // HTTP 400：收件人不存在等 → 明确提示（原静默无反馈）；已有缓存视图则不覆盖（离线可继续读历史）
        $msgList.innerHTML = '<div data-empty-hint style="text-align:center;padding:40px;color:var(--text-dim);">' + escHtml(_kk('goods.dm.loadConvFailTip', '无法加载对话：{0}', d.tip || d.code || _kk('goods.dm.peerNotFound', '收件人不存在，请检查号码'))) + '</div>';
      }
    }).catch(function(){
      // 已有缓存视图时不覆盖（断网继续读历史），仅无缓存时提示错误
      if (_activePeer === peerID && (!_msgCache[peerID] || !_msgCache[peerID].length)) {
        $msgList.innerHTML = '<div data-empty-hint style="text-align:center;padding:40px;color:var(--text-dim);">' + _kk('goods.dm.netErrorConv', '网络错误，无法加载对话') + '</div>';
      }
    });
  }

  // ═══ 群消息历史（?gid=&before= 游标，同私聊分页逻辑）═══
  function loadGroupMessages(peerID) {
    if (!_token) return;
    var cv = _convMap[peerID] || {};
    fetch('https://cnk.gh555.com/api/group/messages?gid='+cv.gid+'&limit=99', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (d.messages) {
        _msgCache[peerID] = _mergeMsgs(_msgCache[peerID] || [], d.messages);
        renderMessages(peerID);
        _cacheSaveSoon();
      } else if (!_msgCache[peerID] || !_msgCache[peerID].length) {
        $msgList.innerHTML = '<div data-empty-hint style="text-align:center;padding:40px;color:var(--text-dim);">' + escHtml(_kk('goods.dm.loadGroupFailTip', '无法加载群聊：{0}', d.tip || d.code || _kk('goods.dm.groupNotFound', '非群成员或群不存在'))) + '</div>';
      }
    }).catch(function(){
      if (!_msgCache[peerID] || !_msgCache[peerID].length) {
        $msgList.innerHTML = '<div data-empty-hint style="text-align:center;padding:40px;color:var(--text-dim);">' + _kk('goods.dm.netErrorGroup', '网络错误，无法加载群聊') + '</div>';
      }
    });
  }

  // ═══ 历史分页 — 加载更早消息（?before=<最老id> 游标，本地前插合并）═══
  function loadMoreMessages(peerID) {
    if (_loadingMore || !_token) return;
    var cv = _convMap[peerID] || {};
    var isG = cv.kind === 'group';
    var msgs = _msgCache[peerID] || [];
    var oldest = msgs.length ? msgs[0].id : 0;
    if (oldest <= 1) { _noMoreOld[peerID] = true; return; }
    _loadingMore = true;
    var btn = document.getElementById('btn-load-more');
    if (btn) { btn.disabled = true; btn.textContent = _kk('common.loading', '加载中…'); }
    var url = isG
      ? 'https://cnk.gh555.com/api/group/messages?gid=' + cv.gid + '&before=' + oldest + '&limit=99'
      : 'https://cnk.gh555.com/api/dm/messages?peer='+encodeURIComponent(peerID)+'&before='+oldest+'&limit=99';
    fetch(url, {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (d.messages && d.messages.length) {
        _msgCache[peerID] = _mergeMsgs(msgs, d.messages);
        if (d.messages.length < 99) _noMoreOld[peerID] = true;   // 不满一页 = 已到底
        renderMessages(peerID);
        _cacheSaveSoon();
      } else {
        _noMoreOld[peerID] = true;   // 没有更早（id 空洞）→ 按钮消失
        renderMessages(peerID);
      }
    }).catch(function(){
      var b = document.getElementById('btn-load-more');
      if (b) { b.disabled = false; b.textContent = _kk('goods.dm.loadEarlier', '加载更早消息'); }
    }).finally(function(){ _loadingMore = false; });
  }

  // ═══ 显示名机器（2026-09-14）：私聊 = 备注/名字 + 脱敏电话（158****8204，中间 **** 微型渲染）═══
  function isPhoneLike(s) {
    if (!s) return false;
    if (String(s).indexOf('****') >= 0) return true;
    return /^\+?\d[\d\s-]{6,}$/.test(String(s));
  }
  function maskLocal(s) {
    s = String(s || '');
    if (!s || s.indexOf('****') >= 0) return s;
    var d = s.replace(/\D/g, '');
    if (!d) return s;
    if (d.length <= 4) return '****';
    var pre = (d.length - 4) >> 1, suf = d.length - pre - 4;
    return d.slice(0, pre) + '****' + d.slice(d.length - suf);
  }
  // 电话 HTML 唯一渲染出口（恒微型 ****）：列表名/头部尾/群成员/群发送者共用
  function phoneHtml(phone) {
    var s = maskLocal(String(phone || ''));
    if (!s) return '';
    return escHtml(s).replace('****', '<i class="ph-mask">****</i>');
  }
  // 群消息发送者名：平台名原样；电话类（含旧缓存全号）→ 微型 ****
  function senderNameHtml(m) {
    var nm = String(m.sender_name || '');
    if (nm && !isPhoneLike(nm)) return escHtml(nm);
    var ph = String(m.sender_phone || nm || '');
    return ph ? phoneHtml(ph) : escHtml(String(m.sender_id || ''));
  }
  // 返回 { name(已转义), tail(电话 HTML，可能为空) }；cv.phone = 服务器脱敏值（resolveDoerContact 唯一出口）
  function dispName(cv, peerID) {
    var phone = maskLocal(cv.phone || '');   // 服务器已脱敏原样透传；旧缓存裸全号就地补脱敏
    var primary = cv.nickname || cv.peerName || phone || peerID || '';
    if (isPhoneLike(primary)) primary = phone || maskLocal(primary);   // 裸号/旧缓存全号 → 统一脱敏格式
    // ★ 2026-09-14：纯电话名（无备注）同样走微型 ****（与尾部电话同款渲染）
    var nameOut = isPhoneLike(primary) ? phoneHtml(primary) : escHtml(primary);
    var tail = '';
    if (phone && phone !== primary) tail = phoneHtml(phone);
    return { name: nameOut, tail: tail };
  }
  // 标签标题用纯文本名（多开 inbox 时标签实时显示对方/群名）
  function dispPlain(cv, peerID) {
    var phone = maskLocal(cv.phone || '');
    var primary = cv.nickname || cv.peerName || phone || peerID || '';
    if (isPhoneLike(primary)) primary = phone || maskLocal(primary);
    return String(primary || '');
  }
  function pushTabTitle() {
    try {
      var cv = _convMap[_activePeer] || {};
      var nm = cv.kind === 'group' ? (cv.gname || _kk('goods.dm.group', '群')) : (_activePeer ? dispPlain(cv, _activePeer) : '');
      parent.postMessage({ type: 'dm:title', title: nm ? nm : 'inbox' }, '*');
    } catch (_) {}
  }

  // ═══ RENDER ═══
  function renderConvList() {
    var peers = Object.keys(_convMap).sort(function(a,b){
      return (_convMap[b].lastTime||'') > (_convMap[a].lastTime||'') ? 1 : -1;
    });
    var filter = _searchFilter.trim().toLowerCase();

    var html = '';
    peers.forEach(function(pid){
      var cv = _convMap[pid];
      var isG = cv.kind === 'group';
      var name = isG ? (cv.gname || _kk('goods.dm.group', '群')) : (cv.nickname || cv.peerName || cv.phone || pid);
      if (filter && name.toLowerCase().indexOf(filter) === -1 && pid.indexOf(filter) === -1) return;

      var cls = _activePeer === pid ? ' active' : '';
      var badge = cv.unread > 0 ? '<span class="conv-badge">'+(cv.unread>99?'99+':cv.unread)+'</span>' : '';
      // 群 → 👥 图标；私聊 → 国家码国旗（照抄登录区）
      var icon = isG ? '<span class="qqi qqi-users" style="font-size:15px"></span>' : flagImg(cv.country);
      var preview = isG && cv.lastSender ? cv.lastSender + '：' + trunc(cv.lastMsg,28) : trunc(cv.lastMsg,40);
      var nm = isG ? {name:escHtml(name), tail:''} : dispName(cv, pid);   // ★ 备注/名字旁恒打印脱敏电话

      html += '<div class="conv-item'+cls+'" data-peer="'+escHtml(pid)+'">';
      // 私聊行尾 ✏️（备注昵称入口；群聊无此概念）
      var nickBtn = isG ? '' : '<button class="conv-nick-btn" data-peer="'+escHtml(pid)+'" title="' + _kk('goods.dm.nickname', '备注昵称') + '">✏️</button>';
      html += '<div class="conv-body"><div class="conv-name">'+(icon?icon+' ':'')+nm.name+(nm.tail?' <span class="peer-phone">'+nm.tail+'</span>':'')+nickBtn+'</div>';
      html += '<div class="conv-preview">'+escHtml(preview)+'</div></div>';
      html += '<div class="conv-meta"><div class="conv-time">'+fmtBrief(cv.lastTime)+'</div>'+badge+'</div>';
      html += '</div>';
    });

    $convList.innerHTML = html || '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">' + _kk('goods.dm.noConv', '暂无对话') + '</div>';

    // Bind clicks
    $convList.querySelectorAll('.conv-item').forEach(function(el){
      el.addEventListener('click',function(){ openChat(el.dataset.peer); });
    });
    // ✏️ 备注按钮（点击不冒泡进 openChat）
    $convList.querySelectorAll('.conv-nick-btn').forEach(function(el){
      el.addEventListener('click',function(e){
        e.stopPropagation();
        editNicknameModal(el.dataset.peer);
      });
    });
  }

  function renderMessages(peerID) {
    $msgList.innerHTML = '';
    var msgs = _msgCache[peerID] || [];
    if (msgs.length === 0) {
      $msgList.innerHTML = '<div data-empty-hint style="text-align:center;padding:40px;color:var(--text-dim);">' + _kk('goods.dm.noMsg', '暂无消息，发送第一条吧') + '</div>';
      return;
    }

    // 顶部「加载更早消息」（游标分页入口：本地最老 id > 1 且未翻到底）
    var oldestId = msgs[0].id;
    if (oldestId > 1 && !_noMoreOld[peerID]) {
      var moreWrap = document.createElement('div');
      moreWrap.className = 'msg-load-more';
      moreWrap.innerHTML = '<button id="btn-load-more"' + (_loadingMore ? ' disabled' : '') + '>' + (_loadingMore ? _kk('common.loading', '加载中…') : _kk('goods.dm.loadEarlier', '加载更早消息')) + '</button>';
      $msgList.appendChild(moreWrap);
      moreWrap.querySelector('button').addEventListener('click', function(){ loadMoreMessages(peerID); });
    }

    var lastDay = '';
    var lastSender = '';
    var lastTime = 0;

    msgs.forEach(function(m, i){
      var d = new Date(m.created_at);
      var dayKey = d.toDateString();
      if (dayKey !== lastDay) {
        var daySep = document.createElement('div');
        daySep.className = 'msg-day-sep';
        daySep.textContent = fmtDay(d);
        $msgList.appendChild(daySep);
        lastDay = dayKey;
        lastSender = '';
      }

      var isSelf = m.sender_id === _doerID;
      var row = document.createElement('div');
      var mTime = d.getTime();

      // 群聊：对方消息每条显示发送者名且不分组（多人对话可读性优先）
      var isG = (_convMap[peerID]||{}).kind === 'group';
      var grouped = !isG && (m.sender_id === lastSender && (mTime - lastTime) < 180000);
      row.className = 'msg-row ' + (isSelf ? 'self' : 'other') + (grouped ? (isSelf?' self-grouped':' other-grouped') : '');
      var senderHtml = (isG && !isSelf) ? '<div class="msg-sender">'+senderNameHtml(m)+'</div>' : '';
      // 已读回执（仅私聊自己的消息）：read_at 由对方拉取会话时服务端标记
      var readHtml = (!isG && isSelf) ? '<span class="msg-read">'+(m.read_at?_kk('goods.dm.read','已读'):_kk('goods.dm.unread','未读'))+'</span>' : '';
      row.innerHTML = senderHtml + '<div class="msg-bubble">'+attachHtml(m.attachments)+escHtml(m.content)+'</div>' +
        (grouped ? '' : '<div class="msg-time">'+fmtTime(d)+'</div>'+readHtml);
      $msgList.appendChild(row);

      lastSender = m.sender_id;
      lastTime = mTime;
    });

    scrollBottom();
  }

  function appendBubble(m) {
    // 空态/错误占位 → 新消息到达即移除（防「暂无消息」压在已发消息上方）
    var hintEl = $msgList.querySelector('[data-empty-hint]');
    if (hintEl) hintEl.remove();
    var msgs = _msgCache[_activePeer] || [];
    var prev = msgs.length > 1 ? msgs[msgs.length-2] : null;
    var isSelf = m.sender_id === _doerID;
    var d = new Date(m.created_at);
    var mTime = d.getTime();
    var isG = (_convMap[_activePeer]||{}).kind === 'group';
    var grouped = !isG && prev && prev.sender_id === m.sender_id && (mTime - new Date(prev.created_at).getTime()) < 180000;

    var row = document.createElement('div');
    row.className = 'msg-row '+(isSelf?'self':'other')+(grouped?(isSelf?' self-grouped':' other-grouped'):'');
    var senderHtml = (isG && !isSelf) ? '<div class="msg-sender">'+senderNameHtml(m)+'</div>' : '';
    var readHtml = (!isG && isSelf) ? '<span class="msg-read">'+(m.read_at?_kk('goods.dm.read','已读'):_kk('goods.dm.unread','未读'))+'</span>' : '';
    row.innerHTML = senderHtml + '<div class="msg-bubble">'+attachHtml(m.attachments)+escHtml(m.content)+'</div>' +
      (grouped?'':'<div class="msg-time">'+fmtTime(d)+'</div>'+readHtml);
    $msgList.appendChild(row);
  }

  // ═══ BED 入口（2026-09-01：文件数/占用/累计消费 → 打开 bed；2×2 布局 2026-09-14）═══
  function loadBedStats() {
    if (!_token) return;
    fetch('https://cnk.gh555.com/api/upload/stats', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      if (!d.ok) return;
      var fee = (d.total_fee_ge || '0');
      $bedFiles.textContent = _kk('goods.dm.bedFiles', '{0} 个文件', d.total);
      $bedSize.textContent = _kk('goods.dm.bedSize', '占用 {0}', fmtBytes(d.total_size));
      $bedEntry.title = _kk('goods.dm.bedTitle', '打开 bed 我的文件 · {0} 个文件 · {1} · 已消费 {2} ge', d.total, fmtBytes(d.total_size), fee);
    }).catch(function(){});
  }
  $bedEntry.addEventListener('click', function(){
    // bed 页面直达 inbox 目录（网站 goods，?folder=inbox）
    var url = 'https://www.gh555.com/gaea/d/bed?lang=zh&folder=inbox';
    try {
      if (parent.qqqideBridge && parent.qqqideBridge.openExternal) { parent.qqqideBridge.openExternal(url); return; }
    } catch(_) {}
    try { if (parent.qqqLogin && parent.qqqLogin.openExternal) { parent.qqqLogin.openExternal(url); return; } } catch(_) {}
    window.open(url, '_blank');
  });

  // ═══ 附件管理（先传后发：bed 1ge/10MB，自动落 inbox/{YYYY}）═══
  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
    return (b/1073741824).toFixed(2) + ' GB';
  }
  function isImg(name) { return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(name); }
  function isImgMime(mime) { return /^image\//.test(mime || ''); }

  // ═══ 附件管理（2026-09-14 重写：per-peer 独立 · Ctrl+V 粘贴一切 · 右键菜单 · 逐文件进度）═══
  var ATTACH_MAX = 20;   // 单条消息附件上限（与服务端 maxMsgAttachments 对齐）

  function pendingList(peer) {
    peer = peer || _activePeer;
    if (!peer) return [];
    if (!_pendingByPeer[peer]) _pendingByPeer[peer] = [];
    return _pendingByPeer[peer];
  }
  function clearPending(peer, revoke) {
    var list = _pendingByPeer[peer];
    if (!list) return;
    if (revoke) {
      list.forEach(function(c){ try { if (c.url) URL.revokeObjectURL(c.url); } catch(_){} });
    }
    delete _pendingByPeer[peer];
  }

  // 加入附件（Ctrl+V / 右键菜单粘贴共用）：全量收集 + 硬帽 + 同名同大小去重
  function addFiles(peer, files) {
    if (!peer) {
      try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.needConvPaste', '先选择一条对话再粘贴文件'), {type:'warn', duration:3500}); } catch(_) {}
      return;
    }
    if (_sending) {
      try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.sendBusy', '正在发送上一条消息，稍后再添加文件'), {type:'warn', duration:3500}); } catch(_) {}
      return;
    }
    var list = pendingList(peer);
    var arr = Array.prototype.slice.call(files || []);
    var added = 0;
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (!f) continue;
      if (list.length >= ATTACH_MAX) {
        try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.attachMax', '单条消息最多 {0} 个附件', ATTACH_MAX), {type:'warn', duration:4000}); } catch(_) {}
        break;
      }
      // 无名字的文件（截图等）补默认名
      if (!f.name) { try { f = new File([f], 'screenshot-' + Date.now() + '.png', {type: f.type || 'image/png'}); } catch(_) { continue; } }
      var dup = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j].name === f.name && list[j].size === f.size) { dup = true; break; }
      }
      if (dup) continue;
      var chip = { id: 'c' + (++_chipSeq), file: f, name: f.name, size: f.size, loaded: 0,
                   mime: f.type || '', url: '', status: 'pending', att: null, err: null };
      if (isImgMime(chip.mime) || isImg(chip.name)) {
        try { chip.url = URL.createObjectURL(f); } catch(_) {}
      }
      list.push(chip);
      added++;
    }
    if (added && _activePeer === peer) renderAttachBar();
  }

  // 移除附件：发送中（上传阶段）→ 取消整个上传批次；已上传未发送 → 同步从 bed 清理（不退费，与 bed 语义一致）
  function removeChip(peer, chipId) {
    if (_sendCtl && _sendCtl.active && _sendCtl.peer === peer && _sendCtl.phase === 'upload') { cancelSend(_sendCtl); return; }
    var list = _pendingByPeer[peer];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === chipId) {
        var c = list[i];
        if (c.att && c.att.r2_key) bedDelete(c.att.r2_key);
        try { if (c.url) URL.revokeObjectURL(c.url); } catch(_) {}
        list.splice(i, 1);
        break;
      }
    }
    renderAttachBar();
  }

  function bedDelete(r2key) {
    fetch('https://cnk.gh555.com/api/upload/' + r2key, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + _token }
    }).catch(function(){});
  }

  function chipSubText(c) {
    if (c.status === 'uploading') return _kk('goods.dm.uploadingPct', '上传中 {0}%', Math.round((c.loaded / (c.size || 1)) * 100));
    if (c.status === 'done') return _kk('goods.dm.uploaded', '已上传 · {0}', fmtBytes(c.size));
    if (c.status === 'failed') return _kk('goods.dm.uploadFailedRetry', '上传失败 · 点发送重试');
    return fmtBytes(c.size);
  }

  function renderAttachBar() {
    var list = _activePeer ? (_pendingByPeer[_activePeer] || []) : [];
    if (!list.length) {
      $attachBar.classList.remove('show');
      $attachBar.innerHTML = '';
      return;
    }
    $attachBar.classList.add('show');
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var thumb = c.url
        ? '<img class="thumb" src="' + c.url + '" alt="">'
        : '<div class="file-ic qqi qqi-file"></div>';
      var pct = c.status === 'done' ? 100 : Math.round((c.loaded / (c.size || 1)) * 100);
      var stCls = c.status === 'failed' ? ' failed' : (c.status === 'done' ? ' done' : (c.status === 'uploading' ? ' uploading' : ''));
      html += '<div class="attach-chip' + stCls + '" title="' + escHtml(c.name) + '">' + thumb +
        '<div class="chip-meta"><div class="chip-name">' + escHtml(c.name) + '</div>' +
        '<div class="chip-size">' + escHtml(chipSubText(c)) + '</div></div>' +
        '<button class="chip-x" data-id="' + c.id + '">✕</button>' +
        (c.status === 'uploading' ? '<div class="chip-bar"><div class="chip-bar-in" style="width:' + pct + '%"></div></div>' : '') +
        '</div>';
    }
    $attachBar.innerHTML = html;
    $attachBar.querySelectorAll('.chip-x').forEach(function(el){
      el.addEventListener('click', function(){ removeChip(_activePeer, el.dataset.id); });
    });
  }

  // 从剪贴板事件收集文件（一切类型，含一批）
  function pasteItemsToFiles(cd) {
    var files = [];
    if (!cd) return files;
    try {
      if (cd.files && cd.files.length) {
        for (var i = 0; i < cd.files.length; i++) files.push(cd.files[i]);
      } else if (cd.items) {
        for (var j = 0; j < cd.items.length; j++) {
          var it = cd.items[j];
          if (it.kind === 'file') { var f = it.getAsFile(); if (f) files.push(f); }
        }
      }
    } catch(_) {}
    return files;
  }

  // ═══ 纯文本插入（唯一实现，2026-10-03）：右键 Ctrl+V / 外拖文本 共用 ═══
  // 口径：输入框持焦点 → 光标处插入（有选区则替换）；未持焦点 → 焦点 + 追加末尾；
  // maxlength 硬帽（超出截断 + qoast——与原生粘贴入字数上限语义对齐）；autoResize 同步。
  function insertMsgText(text) {
    if (!text) return;
    var wasActive = (document.activeElement === $msgInput);
    $msgInput.focus();
    if (!wasActive) {
      try { var L0 = $msgInput.value.length; $msgInput.setSelectionRange(L0, L0); } catch(_) {}
    }
    var nd = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    var cur = nd.get.call($msgInput);
    var ss = $msgInput.selectionStart || 0, se = $msgInput.selectionEnd || 0;
    var max = parseInt($msgInput.getAttribute('maxlength') || '0', 10) || 0;
    var avail = (max > 0) ? Math.max(0, max - (cur.length - (se - ss))) : text.length;
    if (avail <= 0) return;
    var ins = text.length > avail ? text.slice(0, avail) : text;
    nd.set.call($msgInput, cur.substring(0, ss) + ins + cur.substring(se));
    $msgInput.setSelectionRange(ss + ins.length, ss + ins.length);
    autoResize();
    if (ins.length < text.length) {
      try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.pasteTruncated', '已达消息长度上限，多余内容已截断'), {type:'warn', duration:3500}); } catch(_) {}
    }
  }

  // ★ Ctrl+V：粘贴一切文件（图片/文档/压缩包/一批文件）；无文件则放行原生文本粘贴
  document.addEventListener('paste', function(e){
    if (!_activePeer) return;
    var t = e.target;
    if (t && t !== $msgInput && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    var files = pasteItemsToFiles(e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData));
    if (!files.length) return;
    e.preventDefault();
    addFiles(_activePeer, files);
  });

  // 右键菜单（照抄 AI 面板：Ctrl+C / Ctrl+V）
  var _inputCtxMenu = null;
  function _closeInputCtxMenu() {
    if (_inputCtxMenu) { _inputCtxMenu.remove(); _inputCtxMenu = null; }
  }
  $msgInput.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    _closeInputCtxMenu();
    var menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;z-index:99999;visibility:hidden;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.18);padding:0;min-width:120px;font-size:13px;';
    menu.style.left = '-9999px'; menu.style.top = '-9999px';
    document.body.appendChild(menu);
    _inputCtxMenu = menu;
    function _addRow(label, action) {
      var row = document.createElement('div');
      row.textContent = label;
      row.style.cssText = 'padding:6px 16px;white-space:nowrap;color:var(--text-bright);';
      row.addEventListener('mouseenter', function () { row.style.background = 'var(--accent-glow)'; });
      row.addEventListener('mouseleave', function () { row.style.background = ''; });
      row.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); _closeInputCtxMenu(); action(); });
      menu.appendChild(row);
    }
    _addRow('Ctrl+C', function () {
      $msgInput.focus();
      if ($msgInput.selectionStart === $msgInput.selectionEnd) $msgInput.select();
      try { document.execCommand('copy'); } catch (_) { }
    });
    _addRow('Ctrl+V', function () {
      $msgInput.focus();
      pasteFromClipboardApi();
    });
    var mr = menu.getBoundingClientRect();
    var mw = mr.width || 120, mh = mr.height || 56;
    var l = e.clientX, tp = e.clientY - mh / 2;
    if (l + mw > window.innerWidth - 4) l = e.clientX - mw;
    if (tp + mh > window.innerHeight - 4) tp = window.innerHeight - mh - 4;
    menu.style.visibility = 'visible';
    menu.style.left = Math.max(4, l) + 'px';
    menu.style.top = Math.max(4, tp) + 'px';
  });
  document.addEventListener('mousedown', function (e) {
    if (_inputCtxMenu && !_inputCtxMenu.contains(e.target)) _closeInputCtxMenu();
  }, true);
  $msgInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') _closeInputCtxMenu();
  });

  // 菜单「Ctrl+V」：navigator.clipboard.read → 图片入条 + 文本插光标（系统复制的文件请在键入框直接 Ctrl+V）
  function pasteFromClipboardApi() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.pasteInInput', '请在键入框直接 Ctrl+V 粘贴'), {type:'info', duration:3000}); } catch(_) {}
      return;
    }
    navigator.clipboard.read().then(function(items){
      var imageFiles = [], text = '';
      var reads = [];
      for (var i = 0; i < items.length; i++) {
        (function(it, idx){
          for (var t = 0; t < it.types.length; t++) {
            var mt = it.types[t];
            if (mt.indexOf('image/') === 0) {
              reads.push(it.getType(mt).then(function(blob){
                var ext = (mt.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
                imageFiles.push(new File([blob], 'pasted-' + Date.now() + '-' + (idx + 1) + '.' + ext, {type: mt}));
              }).catch(function(){}));
            } else if (mt === 'text/plain') {
              reads.push(it.getType('text/plain').then(function(b){ return b.text(); }).then(function(s){ if (!text) text = s || ''; }).catch(function(){}));
            }
          }
        })(items[i], i);
      }
      Promise.all(reads).then(function(){
        if (imageFiles.length) addFiles(_activePeer, imageFiles);
        if (text) insertMsgText(text);   // 唯一插入机（与拖入文本同源）
        if (!imageFiles.length && !text) {
          try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.clipEmpty', '剪贴板里没有可粘贴的内容（文件请直接在键入框 Ctrl+V）'), {type:'info', duration:3500}); } catch(_) {}
        }
      });
    }).catch(function(){
      try { if (parent.qqqideQoast) parent.qqqideQoast.show(_kk('goods.dm.pasteInInput', '请在键入框直接 Ctrl+V 粘贴'), {type:'info', duration:3000}); } catch(_) {}
    });
  }

  // ═══ 拖放接收（2026-09-14；2026-10-03 网页文本接管）═══
  // 语义（协议与 AI 面板 / Roam 统一）：橙色虚线框覆盖整个 iframe 视口（= 接收范围）。
  //   · 系统文件（types 含 Files）→ 等同 Ctrl+V 加入附件条（图片/文档/压缩包/一批；文件夹 stat 剔除）
  //   · 外拖文本（浏览器选区/链接/任意应用: 无 Files 但有 text/*）→ 等同在键入框 Ctrl+V 纯文本
  //     （insertMsgText——右键菜单同源；持焦点→光标处 / 未持焦点→焦点+追加末尾；maxlength 硬帽）
  //   · 本窗口内部拖拽（原文拖拽/消息图片拖出）→ 零接管（dragstart 守卫让路原生）
  //   · 他方输入框为目标（搜索框/新建号码框等）→ 让路原生，不接管
  //   · 外部拖拽一律 preventDefault（防链接/URL 拖入触发 iframe 默认导航）
  (function () {
    var ov = document.createElement('div');
    ov.id = 'dm-drop-overlay';
    ov.style.cssText =
      'position:fixed;left:0;top:0;right:0;bottom:0;display:none;pointer-events:none;' +
      'z-index:999999;border:3px dashed #e07020;border-radius:4px;' +
      'box-shadow:inset 0 0 0 2px rgba(224,112,32,0.12), 0 0 0 2px rgba(224,112,32,0.18);';
    document.body.appendChild(ov);
    function ovShow() { ov.style.display = 'block'; }
    function ovHide() { ov.style.display = 'none'; }

    // 拖拽分类（唯一真理源 core/drag-text.js；脚本缺失降级为旧「仅系统文件」行为）
    var DT = (typeof window !== 'undefined') ? window.qqqDragText : null;
    var isInternal = DT ? DT.installInternalGuard(document) : function () { return false; };
    function classify(e) {
      if (DT) return DT.classify(e.dataTransfer, isInternal());
      var dt0 = e.dataTransfer;
      if (!dt0 || !dt0.types) return null;
      return Array.prototype.indexOf.call(dt0.types, 'Files') !== -1 ? 'files' : null;
    }
    // 文本分支例外: 落点是他方输入框 → 让路原生，不接管
    function isForeignEditable(t) {
      if (!t || t === $msgInput) return false;
      var tag = t.tagName ? t.tagName.toUpperCase() : '';
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
    }
    var depth = 0;
    var kind = null;
    document.addEventListener('dragenter', function (e) {
      var k = classify(e);
      if (!k) return;
      depth++;
      kind = k;
      if (k === 'text' && isForeignEditable(e.target)) return;   // 他方输入框: 原生全权（无 preventDefault）
      e.preventDefault();
      ovShow();
    }, true);
    document.addEventListener('dragover', function (e) {
      var k = classify(e) || kind;
      if (!k) return;
      if (k === 'text' && isForeignEditable(e.target)) { ovHide(); return; }   // 原生全权
      e.preventDefault();   // 允许 drop + 防链接拖入默认导航
      ovShow();
    }, true);
    document.addEventListener('dragleave', function (e) {
      if (!kind) return;
      depth--;
      if (depth <= 0) { depth = 0; kind = null; ovHide(); }
    }, true);
    // 失焦兜底（ALT+TAB 中途取消拖拽可能无 dragleave）
    window.addEventListener('blur', function () { depth = 0; kind = null; ovHide(); });

    function dragQoast(msg, type, dur) {
      try { if (parent.qqqideQoast) parent.qqqideQoast.show(msg, { type: type || 'warn', duration: dur || 3500 }); } catch (_) {}
    }

    // drop 总入口：先分类，再按分支执行（文件 = 原语义；文本 = 等同键入框 Ctrl+V）
    // 文件夹剔除：File 对象读不到目录内容 → 主进程 stat 精确判定（bridge 不可用则放行，由上传层裁决）
    document.addEventListener('drop', function (e) {
      var k = kind || classify(e);   // 极少数无 dragenter 的直达 drop 兜底
      depth = 0;
      kind = null;
      ovHide();
      if (!k) return;
      if (k === 'text' && isForeignEditable(e.target)) return;    // 让路他方输入框（原生 drop）
      e.preventDefault();
      e.stopPropagation();

      var dt = e.dataTransfer;

      // ══ 文本分支: 等同在键入框 Ctrl+V（插入机与右键菜单同源）══
      if (k === 'text') {
        if (!_activePeer) { dragQoast(_kk('goods.dm.needConvDropText', '先选择一条对话再拖入文字')); return; }
        var text = DT ? DT.extractText(dt) : '';
        if (!text) return;   // 空文本载荷 → 定义为 no-op（默认导航已由 preventDefault 封死）
        insertMsgText(text);
        return;
      }

      // ══ 文件分支（原语义不变）══
      if (!dt || !dt.files || dt.files.length === 0) return;
      var peer = _activePeer;
      if (!peer) { dragQoast(_kk('goods.dm.needConvDrop', '先选择一条对话再拖入文件')); return; }

      var files = Array.prototype.slice.call(dt.files);
      var b = null;
      try { b = window.parent.qqqideBridge; } catch (_) {}
      var statFn = (b && b.fs && typeof b.fs.stat === 'function') ? b.fs.stat : null;
      if (!statFn) { addFiles(peer, files); return; }

      Promise.all(files.map(function (f) {
        if (!f || !f.path) return Promise.resolve(true);   // 无路径 → 放行
        return statFn(f.path).then(function (st) {
          return !(st && st.isDir);                        // 目录 → 剔除
        }, function () { return true; });                  // stat 失败 → 放行
      })).then(function (oks) {
        var keep = [], dirs = 0;
        for (var i = 0; i < files.length; i++) {
          if (oks[i]) keep.push(files[i]); else dirs++;
        }
        if (dirs > 0) dragQoast(_kk('goods.dm.dirsSkipped', '{0} 个文件夹已跳过（暂不支持，请拖入文件夹内的文件）', dirs), 'info', 4200);
        if (keep.length) addFiles(peer, keep);
      });
    }, true);
  })();

  // ═══ 上传引擎（逐文件进度 + ioast 任务卡 + 取消；已传成功文件重试不重复上传/计费）═══
  function ioastRoot() { try { return parent.qqqideIoast; } catch(_) { return null; } }
  function ioastCall(fn, id, opts) { var I = ioastRoot(); if (I && typeof I[fn] === 'function') { try { I[fn](id, opts); } catch(_) {} } }

  function updateUploadTask(ctl) {
    if (!ctl || !ctl.taskId) return;
    var now = Date.now();
    if (now - (ctl._lastUi || 0) < 120) return;
    ctl._lastUi = now;
    var list = _pendingByPeer[ctl.peer] || [];
    var done = 0, total = 0, loadedB = 0, totalB = 0, curName = '';
    list.forEach(function(c){
      total++; totalB += c.size || 0;
      loadedB += (c.status === 'done') ? (c.size || 0) : (c.loaded || 0);
      if (c.status === 'done') done++;
      if (c.status === 'uploading') curName = c.name;
    });
    var elapsed = (Date.now() - ctl.t0) / 1000;
    var speed = (elapsed > 0.8 && loadedB > 0) ? (loadedB / 1048576) / elapsed : 0;
    var prog = totalB > 0 ? Math.min(1, loadedB / totalB) : 0;
    var sub = (curName ? _kk('goods.dm.uploadingFile', '正在上传：{0}', curName) : (ctl.phase === 'send' ? _kk('goods.dm.sendingMsg', '正在发送消息…') : _kk('goods.dm.preparing', '准备中…')));
    if (speed > 0.01 && ctl.phase === 'upload') sub += ' · ' + speed.toFixed(1) + ' MB/s';
    ioastCall('task', ctl.taskId, {
      title: _kk('goods.dm.sendToInbox', '📤 发送到 inbox'),
      subtitle: sub,
      progress: prog,
      count: { done: done, total: total },
      elapsed: elapsed,
      cancelable: ctl.phase === 'upload',
      onCancel: function () { cancelSend(ctl); }
    });
  }

  function cancelSend(ctl) {
    if (!ctl || ctl.canceled || !ctl.active) return;
    ctl.canceled = true;
    (ctl.xhrs || []).forEach(function(x){ try { x.abort(); } catch(_){} });
  }

  function uploadOne(c, ctl) {
    c.status = 'uploading'; c.loaded = 0; c.err = null;
    updateUploadTask(ctl);
    if (_activePeer === ctl.peer) renderAttachBar();
    var year = new Date().getFullYear();
    return fetch('https://cnk.gh555.com/api/upload/init', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
      body:JSON.stringify({filename:c.name, size:c.size, content_type:c.mime || 'application/octet-stream', standalone:true, folder:'inbox/' + year})
    }).then(function(r){ return r.json(); }).then(function(d0){
      if (ctl.canceled) throw { canceled: true };
      if (!d0.ok) {
        var e0 = new Error(d0.error || d0.code || 'init failed');
        if (d0.needed_ge) e0.feeTip = _kk('goods.dm.insufficientBalance', '余额不足，需求 {0} ge（{1}）', d0.needed_ge, c.name);
        else if (d0.error === 'daily_upload_limit') e0.feeTip = _kk('goods.dm.dailyLimit', '今天上传的文件数已达上限（100 个/天）');
        throw e0;
      }
      return new Promise(function(resolve, reject){
        var xhr = new XMLHttpRequest();
        ctl.xhrs.push(xhr);
        xhr.open('PUT', d0.upload_url, true);
        xhr.setRequestHeader('Content-Type', c.mime || 'application/octet-stream');
        xhr.upload.onprogress = function(ev){
          if (ev.lengthComputable) { c.loaded = ev.loaded; if (ev.total) c.size = ev.total; }
          if (_activePeer === ctl.peer) renderAttachBar();
          updateUploadTask(ctl);
        };
        xhr.onload = function(){ if (xhr.status >= 200 && xhr.status < 300) resolve(d0); else reject(new Error(_kk('goods.dm.uploadHttpFail', '上传失败 HTTP {0}', xhr.status))); };
        xhr.onerror = function(){ reject(new Error(_kk('goods.dm.netInterrupt', '网络中断，文件未传完'))); };
        xhr.onabort = function(){ reject({ canceled: true }); };
        xhr.ontimeout = function(){ reject(new Error(_kk('goods.dm.uploadTimeout', '上传超时'))); };
        xhr.send(c.file);
      });
    }).then(function(d0){
      return fetch('https://cnk.gh555.com/api/upload/complete', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
        body:JSON.stringify({r2_key:d0.r2_key})
      }).then(function(r){ return r.json(); }).then(function(d1){
        if (ctl.canceled) throw { canceled: true };
        if (!d1.ok) throw new Error(d1.error || d1.code || 'complete failed');
        c.att = { r2_key: d1.r2_key || d0.r2_key, filename: c.name, size: d1.size || c.size, mime: c.mime };
        c.status = 'done'; c.loaded = c.size;
        if (_activePeer === ctl.peer) renderAttachBar();
        updateUploadTask(ctl);
      });
    });
  }

  // 并发 2 路上传；任一失败 → 中止整批（已传成功的保留，重发不重复上传/计费）
  function uploadAll(chips, ctl) {
    var idx = 0;
    function next() {
      if (ctl.canceled || ctl.failed) return Promise.resolve();
      if (idx >= chips.length) return Promise.resolve();
      var c = chips[idx++];
      if (c.status === 'done') { updateUploadTask(ctl); return next(); }
      return uploadOne(c, ctl).then(function(){ return next(); }, function(err){
        if (err && err.canceled) throw err;
        c.status = 'failed'; c.err = err;
        ctl.failedErr = err;
        ctl.failed = true;   // 一败全停：其余未完成文件不再继续
        (ctl.xhrs || []).forEach(function(x){ try { x.abort(); } catch(_){} });
        if (_activePeer === ctl.peer) renderAttachBar();
        throw err;
      });
    }
    var n = Math.min(2, chips.length);
    var workers = [];
    for (var i = 0; i < n; i++) workers.push(next());
    return Promise.all(workers);
  }

  // ═══ 备注昵称（2026-09-01：per-user 独立，双方互不可见；留空=清除）═══
  function editNicknameModal(peerID) {
    var cv = _convMap[peerID] || {};
    openModal(_kk('goods.dm.nickname', '备注昵称'),
      '<div class="form-row"><label>' + _kk('goods.dm.nickLabel', '给这个对话设置一个备注名（仅自己可见，对方看不到）') + '</label>' +
      '<input id="nick-input" maxlength="32" placeholder="' + _kk('goods.dm.nickPh', '如：老王') + '" value="'+escHtml(cv.nickname||'')+'" autocomplete="off"></div>' +
      '<div class="form-tip">' + _kk('goods.dm.nickTip', '清空后保存 = 取消备注') + '</div>',
      _kk('common.save', '保存'), function(){
        var nick = document.getElementById('nick-input').value.trim();
        if (nick === (cv.nickname||'')) { closeModal(); return; }
        fetch('https://cnk.gh555.com/api/dm/nickname', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
          body:JSON.stringify({peer_id: peerID, nickname: nick})
        }).then(function(r){return r.json();}).then(function(d){
          if (!d.ok) {
            $modalTitle.textContent = _kk('goods.dm.saveFailTip', '保存失败：{0}', d.tip || d.code || _kk('goods.dm.unknownErr', '未知错误'));
            return;
          }
          cv.nickname = nick || '';
          closeModal();
          renderConvList();
          if (_activePeer === peerID) refreshChatHeader();
          _cacheSaveSoon();
        }).catch(function(){
          $modalTitle.textContent = _kk('goods.dm.saveFailNet', '保存失败：网络错误');
        });
      });
    setTimeout(function(){ var el = document.getElementById('nick-input'); if (el) el.focus(); }, 50);
  }

  // 刷新聊天头部（显示名 = 备注 > 平台名 > 手机号；私聊带 ✏️ 入口）
  function refreshChatHeader() {
    var cv = _convMap[_activePeer] || {};
    if (cv.kind === 'group') {
      // 群：👥 群名 · N 人（成员数可点 → 成员管理弹窗）
      $chatHdrName.innerHTML = '<span class="qqi qqi-users" style="font-size:14px"></span> ' + escHtml(cv.gname || _kk('goods.dm.group', '群'));
      $chatHdrStat.style.display = '';
      $chatHdrStat.textContent = (cv.memberCnt ? _kk('goods.dm.memberCount', '{0} 人', cv.memberCnt) : '') + ' · ' + _kk('goods.dm.members', '成员');
      $chatHdrStat.title = _kk('goods.dm.viewMembers', '查看群成员');
    } else {
      // ★ 头部显示名+国旗（恒打印脱敏电话在旁；2026-09-14）
      var nm = dispName(cv, _activePeer);
      $chatHdrStat.title = '';
      $chatHdrStat.style.display = 'none';   // 私聊不显示在线状态（1h ping 窗口有固有滞后，弃用）
      $chatHdrName.innerHTML = flagImg(cv.country) + (cv.country?' ':'') + nm.name +
        (nm.tail ? ' <span class="peer-phone">'+nm.tail+'</span>' : '') +
        ' <button class="hdr-nick-btn" title="' + (cv.nickname ? _kk('goods.dm.editNick', '修改备注') : _kk('goods.dm.nickname', '备注昵称')) + '">✏️</button>';
      var b = document.getElementById('hdr-nick-btn');
      if (b) b.addEventListener('click', function(){ editNicknameModal(_activePeer); });
    }
    pushTabTitle();   // 标签标题随会话同步（2026-09-14：多开 inbox = 同时与几个人聊天）
  }

  // ═══ ACTIONS ═══
  function openChat(peerID) {
    _activePeer = peerID;
    _searchFilter = '';
    $searchInput.value = '';

    $emptyState.style.display = 'none';
    $chatHeader.style.display = 'flex';
    $msgList.style.display = 'block';
    $inputArea.style.display = 'block';

    var cv = _convMap[peerID] || {};

    refreshChatHeader();

    // Reset unread
    cv.unread = 0;
    try { if (parent.qqqGaea && parent.qqqGaea.resetInboxUnread) parent.qqqGaea.resetInboxUnread(); } catch(_) {}

    if (cv.kind === 'group') {
      loadGroupMessages(peerID);
    } else if (Array.isArray(_msgCache[peerID]) && _msgCache[peerID].length > 0) {
      renderMessages(peerID);   // 缓存秒开（弱网/离线也能读）
      loadMessages(peerID);     // 后台拉最新段增量合并修正
    } else {
      loadMessages(peerID);
    }
    renderAttachBar();   // ★ per-peer 附件条：切会话显示对应会话的待发文件（2026-09-14）
    renderConvList();
    setTimeout(function(){ $msgInput.focus(); },100);
  }

  // ═══ 发送（私聊/群聊统一；先传后发 + 逐文件进度 + 取消，2026-09-14 重写）═══
  function sendMessage() {
    var text = $msgInput.value.trim();
    var list = _activePeer ? (_pendingByPeer[_activePeer] || []) : [];
    if ((!text && !list.length) || !_activePeer || !_token || _sending) return;
    var cv = _convMap[_activePeer] || {};
    doSend(text, cv, cv.kind === 'group');
  }

  function doSend(text, cv, isG) {
    var peer = _activePeer;
    var list = _pendingByPeer[peer] || [];
    _sending = true;
    $sendBtn.disabled = true;
    $msgInput.value = '';
    autoResize();

    var ctl = { peer: peer, canceled: false, failed: false, active: true, xhrs: [], t0: Date.now(),
                phase: list.length ? 'upload' : 'send', taskId: 'inbox-send-' + peer };
    _sendCtl = ctl;
    if (list.length) { ioastCall('task', ctl.taskId, { title:_kk('goods.dm.sendToInbox', '📤 发送到 inbox'), subtitle:_kk('goods.dm.preparing', '准备中…'), cancelable:true, onCancel:function(){ cancelSend(ctl); } }); }

    var todo = list.filter(function(c){ return c.status !== 'done'; });
    uploadAll(todo, ctl).then(function(){
      if (ctl.canceled) throw { canceled: true };
      if (ctl.failed) throw (ctl.failedErr || new Error(_kk('goods.dm.uploadFail', '上传失败')));
      ctl.phase = 'send';
      updateUploadTask(ctl);
      var atts = [];
      ((_pendingByPeer[peer]) || []).forEach(function(c){ if (c.status === 'done' && c.att) atts.push(c.att); });
      var url = isG ? 'https://cnk.gh555.com/api/group/send' : 'https://cnk.gh555.com/api/dm/send';
      var body = isG ? {gid: cv.gid, content: text} : {to: peer, content: text};
      body.attachments = atts;
      return fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
        body:JSON.stringify(body)
      }).then(function(r){return r.json();});
    }).then(function(d){
      if (ctl.canceled) throw { canceled: true };
      if (!(d && d.ok && d.msg)) {
        var e = new Error((d && (d.tip || d.code)) || _kk('goods.dm.sendFail', '发送失败'));
        e.resp = d;
        throw e;
      }
      // ★ 成功：清空该 peer 附件（文件已被消息引用，绝不动 bed）+ 迁移解析后的 peer key
      var resolvedID = !isG ? (d.peer_resolved || d.msg.recipient_id) : null;
      clearPending(peer, true);
      if (resolvedID && resolvedID !== peer) {
        if (_convMap[peer] && !_convMap[resolvedID]) { _convMap[resolvedID] = _convMap[peer]; delete _convMap[peer]; }
        if (_msgCache[peer] && !_msgCache[resolvedID]) { _msgCache[resolvedID] = _msgCache[peer]; delete _msgCache[peer]; }
        if (_activePeer === peer) _activePeer = resolvedID;
        peer = resolvedID;
      }
      // 发送成功即建立联系人：回填脱敏手机号/国旗（服务器随响应下发）
      if (!isG) {
        var cvS = _convMap[peer] || {};
        if (d.msg.recipient_phone && !cvS.phone) cvS.phone = d.msg.recipient_phone;
        if (d.msg.recipient_country && !cvS.country) cvS.country = d.msg.recipient_country;
        if (!cvS.peerName) cvS.peerName = cvS.phone || d.msg.recipient_id;
        if (_activePeer === peer) refreshChatHeader();
      }
      if (!_msgCache[peer]) _msgCache[peer] = [];
      if (!cacheHas(peer, d.msg.id)) {
        _msgCache[peer].push(d.msg);
        if (_activePeer === peer) { appendBubble(d.msg); scrollBottom(); }
      }
      if (window.qqqCharUndo) window.qqqCharUndo.reset($msgInput);
      _cacheSaveSoon();
      if (ctl.taskId && list.length) {
        ioastCall('done', ctl.taskId, { summary: _kk('goods.dm.filesSent', '{0} 个文件已发送', list.length) });
      } else if (ctl.taskId) {
        ioastCall('remove', ctl.taskId);
      }
    }).catch(function(err){
      if (err && err.canceled) {
        // 取消发送：未完成文件回退 pending（已传成功的保留，重发免重传）
        (_pendingByPeer[peer] || []).forEach(function(c){ if (c.status === 'uploading') { c.status = 'pending'; c.loaded = 0; } });
        if (ctl.taskId) ioastCall('fail', ctl.taskId, { summary: _kk('common.cancelled', '已取消') });
      } else {
        // 失败：中止途中残影清理（uploading → failed）；已传成功文件保留
        (_pendingByPeer[peer] || []).forEach(function(c){ if (c.status === 'uploading') { c.status = 'failed'; } });
        $msgInput.value = text;
        $msgInput.style.borderColor = '#dc322f';
        setTimeout(function(){ $msgInput.style.borderColor = ''; }, 1500);
        var tip = (err && err.feeTip) ? err.feeTip : ((err && err.resp && (err.resp.tip || err.resp.code)) || (err && err.message) || _kk('goods.dm.sendFail', '发送失败'));
        if (err && err.feeTip) {
          try { if (parent.qqqideQoast) parent.qqqideQoast.show(err.feeTip, {type:'error', duration:6000}); } catch(_) {}
        } else {
          $msgInput.placeholder = tip;
          setTimeout(function(){ $msgInput.placeholder = _kk('goods.dm.inputPhPaperclip', '键入消息… (Enter 发送，Shift+Enter 换行；📎 文件直接 Ctrl+V 粘贴)'); }, 4000);
        }
        if (ctl.taskId && list.length) ioastCall('fail', ctl.taskId, { summary: tip });
      }
    }).finally(function(){
      ctl.active = false;
      _sendCtl = null;
      _sending = false;
      $sendBtn.disabled = false;
      renderAttachBar();
      $msgInput.focus();
    });
  }


  // ═══ EVENTS ═══
  $sendBtn.addEventListener('click', sendMessage);
  $msgInput.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    // Auto-resize
    setTimeout(autoResize, 0);
  });
  $msgInput.addEventListener('input', autoResize);
  function autoResize() {
    $msgInput.style.height = 'auto';
    $msgInput.style.height = Math.min($msgInput.scrollHeight, 120) + 'px';
  }

  $searchInput.addEventListener('input', function(){
    _searchFilter = $searchInput.value;
    renderConvList();
  });

  // ★ 新建对话唯一入口：键入框 Enter 与「新建消息」按钮共用
  // 2026-09-14：自投拦截（本地脱敏比对 + 服务端权威探测双保险）——自己的号码不进入会话，就地提示
  function startNewChat() {
    var raw = $newPeerIn.value.trim();
    if (!raw) { $newPeerIn.focus(); return; }
    var phone = raw.replace(/[^0-9]/g,'');
    if (phone.length < 7 || phone.length > 20) {
      flashPeerError(_kk('goods.dm.badPhone', '号码格式不对：完整手机号（带国家码），如 8615802858204'));
      return;
    }
    if (isSelfPhone(phone)) {
      flashPeerError(_kk('goods.dm.selfPhone', '这是你自己的号码，不能给自己发消息'));
      return;
    }
    probeAndOpen(phone);
  }
  // 本地比对：JWT payload.phone 是脱敏格式（158****8204）→ 前后段匹配；_doerID 直比兜底
  function isSelfPhone(phone) {
    if (phone === _doerID) return true;
    var m = _doerPhoneMask || '';
    if (!m) return false;
    if (m.indexOf('****') === -1) return m.replace(/\D/g,'') === phone;
    var seg = m.split('****');
    var pre = (seg[0]||'').replace(/\D/g,''), suf = (seg[1]||'').replace(/\D/g,'');
    if (suf && phone.slice(-suf.length) !== suf) return false;
    if (!pre) return true;
    var pos = phone.indexOf(pre);
    return pos >= 0 && pos + pre.length <= phone.length - suf.length;
  }
  // 服务端权威探测：dm/messages 解析手机号；自投 → self_msg；成功 → 拿解析后的 doerID 直接开聊
  function probeAndOpen(phone) {
    $newPeerIn.disabled = true;
    fetch('https://cnk.gh555.com/api/dm/messages?peer='+encodeURIComponent(phone)+'&limit=1', {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.code === 'self_msg') {
        flashPeerError(_kk('goods.dm.selfPhone', '这是你自己的号码，不能给自己发消息'));
        return;
      }
      if (d && d.messages && d.peer) {
        if (!_convMap[d.peer]) _convMap[d.peer] = {unread:0,lastMsg:'',lastTime:'',peerName:''};
        $newPeerIn.value = '';
        openChat(d.peer);
        return;
      }
      // 其余情况（收件人不存在等）：保持原行为 — 打开原键，由消息区就地提示
      if (!_convMap[phone]) _convMap[phone] = {unread:0,lastMsg:'',lastTime:'',peerName:phone};
      openChat(phone);
    }).catch(function(){
      if (!_convMap[phone]) _convMap[phone] = {unread:0,lastMsg:'',lastTime:'',peerName:phone};
      openChat(phone);
    }).finally(function(){ $newPeerIn.disabled = false; });
  }
  function flashPeerError(tip) {
    $newPeerIn.style.borderColor = '#dc322f';
    var old = $newPeerIn.placeholder;
    $newPeerIn.placeholder = tip;
    setTimeout(function(){
      $newPeerIn.style.borderColor = '';
      $newPeerIn.placeholder = old;
    }, 3000);
  }
  $newPeerIn.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); startNewChat(); }
  });

  $btnNewMsg.addEventListener('click', function(){
    startNewChat();
  });

  // ═══ 通用弹窗 ═══
  var _modalOnOk = null;
  function openModal(title, bodyHTML, okText, onOk) {
    $modalTitle.textContent = title;
    $modalBody.innerHTML = bodyHTML;
    $modalOk.textContent = okText || _kk('common.confirm', '确定');
    $modalOk.style.display = '';
    _modalOnOk = onOk || null;
    $modalMask.style.display = 'flex';
  }
  function closeModal() {
    $modalMask.style.display = 'none';
    _modalOnOk = null;
  }
  $modalCancel.addEventListener('click', closeModal);
  $modalOk.addEventListener('click', function(){
    if (_modalOnOk) _modalOnOk();
  });
  $modalMask.addEventListener('click', function(e){
    if (e.target === $modalMask) closeModal();
  });

  // ═══ 新建群 ═══
  $btnNewGroup.addEventListener('click', function(){
    openModal(_kk('goods.dm.newGroup', '新建群'),
      '<div class="form-row"><label>' + _kk('goods.dm.groupName', '群名') + '</label><input id="g-name" maxlength="100" placeholder="' + _kk('goods.dm.groupNamePh', '群名，如：开发小分队') + '" autocomplete="off"></div>' +
      '<div class="form-row"><label>' + _kk('goods.dm.groupMembers', '成员手机号（逗号分隔，可留空先建群）') + '</label>' +
      '<textarea id="g-members" placeholder="8619232854249, 8615802858204"></textarea></div>' +
      '<div class="form-tip">' + _kk('goods.dm.groupMembersTip', '仅限已注册用户，非注册号码自动跳过') + '</div>',
      _kk('goods.dm.createBtn', '创建'), function(){
        var name = document.getElementById('g-name').value.trim();
        if (!name) {
          document.getElementById('g-name').style.borderColor = '#dc322f';
          setTimeout(function(){ var el = document.getElementById('g-name'); if (el) el.style.borderColor = ''; }, 1500);
          return;
        }
        fetch('https://cnk.gh555.com/api/group/create', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
          body:JSON.stringify({name:name})
        }).then(function(r){return r.json();}).then(function(d){
          if (!d.ok || !d.gid) {
            $modalTitle.textContent = _kk('goods.dm.createFailTip', '创建失败：{0}', d.tip || d.code || _kk('goods.dm.unknownErr', '未知错误'));
            return;
          }
          var gid = d.gid;
          var members = document.getElementById('g-members').value.split(/[,，\s]+/).filter(Boolean);
          var doAdd = function() {
            // 进入群聊
            _convMap[gkey(gid)] = {kind:'group', gid:gid, gname:name, unread:0, lastMsg:'', lastTime:'', memberCnt:0};
            closeModal();
            loadGroups();
            openChat(gkey(gid));
          };
          if (members.length) {
            fetch('https://cnk.gh555.com/api/group/add', {
              method:'POST',
              headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
              body:JSON.stringify({gid:gid, members:members})
            }).then(function(r){return r.json();}).then(function(addD){
              if (!addD.ok && addD.code === 'group_full') {
                $modalTitle.textContent = _kk('goods.dm.createFailTip', '创建失败：{0}', addD.tip || _kk('goods.dm.groupFull', '群成员超限'));
                return;
              }
              doAdd();
            }).catch(doAdd);
          } else {
            doAdd();
          }
        }).catch(function(){
          $modalTitle.textContent = _kk('goods.dm.createFailNet', '创建失败：网络错误');
        });
      });
  });

  // ═══ 群成员管理（头部「N 人 · 成员」点击）═══
  $chatHdrStat.addEventListener('click', function(){
    var cv = _convMap[_activePeer] || {};
    if (cv.kind !== 'group' || !cv.gid) return;
    renderGroupMembers();
  });

  function renderGroupMembers() {
    var cv = _convMap[_activePeer] || {};
    openModal(cv.gname + ' · ' + _kk('goods.dm.members', '成员'),
      '<div id="gm-list" style="max-height:240px;overflow-y:auto;margin-bottom:10px;">' + _kk('common.loading', '加载中…') + '</div>' +
      '<div class="form-row"><label>' + _kk('goods.dm.addMembers', '添加成员（手机号逗号分隔）') + '</label>' +
      '<input id="gm-add-input" placeholder="8619232854249, 8615802858204" autocomplete="off"></div>',
      _kk('goods.dm.addBtn', '添加'), function(){
        var raw = document.getElementById('gm-add-input').value;
        var members = raw.split(/[,，\s]+/).filter(Boolean);
        if (!members.length) return;
        fetch('https://cnk.gh555.com/api/group/add', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},
          body:JSON.stringify({gid:cv.gid, members:members})
        }).then(function(r){return r.json();}).then(function(d){
          if (d.ok) {
            renderGroupMembers();   // 刷新成员列表
            loadGroups();           // 刷新成员数
          } else {
            $modalTitle.textContent = _kk('goods.dm.addFailTip', '添加失败：{0}', d.tip || d.code || _kk('goods.dm.unknownErr', '未知错误'));
          }
        }).catch(function(){
          $modalTitle.textContent = _kk('goods.dm.addFailNet', '添加失败：网络错误');
        });
      });

    fetch('https://cnk.gh555.com/api/group/members?gid=' + cv.gid, {
      headers:{'Authorization':'Bearer '+_token}
    }).then(function(r){return r.json();}).then(function(d){
      var list = document.getElementById('gm-list');
      if (!list) return;
      if (!d.members) { list.textContent = _kk('goods.dm.loadFailTip', '加载失败：{0}', d.tip || d.code || _kk('goods.dm.unknownErr', '未知错误')); return; }
      list.innerHTML = d.members.map(function(m){
        var flag = flagImg(m.country);
        var gmn = String(m.name || m.phone || m.doer_id || '');
        return '<div class="gm-item">' + flag + ' <span class="gm-name">' + (isPhoneLike(gmn) ? phoneHtml(gmn) : escHtml(gmn)) + '</span>' +
          '<span class="gm-phone">' + phoneHtml(m.phone || '') + '</span>' +
          (m.is_owner ? '<span class="gm-owner">' + _kk('goods.dm.groupOwner', '群主') + '</span>' : '') + '</div>';
      }).join('') || '<div style="color:var(--text-dim);font-size:12px;">' + _kk('goods.dm.noMembers', '暂无成员') + '</div>';
    }).catch(function(){
      var list = document.getElementById('gm-list');
      if (list) list.textContent = _kk('goods.dm.loadFailNet', '加载失败：网络错误');
    });
  }

  // ═══ UTILS ═══
  // 附件渲染（2026-09-14 v2）：图片 inline（点击 = 本面板灯箱）+ 文件卡片；每件恒带四小链接
  // save / save as / open / Roam（save 记忆目录静默直存；open = 默认程序；Roam = 定位引擎）；
  // bed 删除后 404 → 已删除占位（不做引用保护）
  function _attActs(url, nm, sz) {
    var u = escHtml(url), n = escHtml(nm || _kk('goods.dm.attachment', '附件')), s = String(sz || 0);
    function lk(kind, label, tip) {
      return '<a data-dlact="' + kind + '" data-dlurl="' + u + '" data-dlname="' + n + '" data-dlsize="' + s + '" title="' + tip + '">' + label + '</a>';
    }
    return '<span class="att-acts">' +
      lk('save', 'save', _kk('goods.dm.actSaveTip', '保存到上次目录（自动记忆，无对话框）')) +
      lk('saveas', 'save as', _kk('goods.dm.actSaveAsTip', '另存为…（记住这次的目录）')) +
      lk('open', 'open', _kk('goods.dm.actOpenTip', '下载后用默认程序打开')) +
      lk('roam', 'Roam', _kk('goods.dm.actRoamTip', '在 Roam 定位该文件')) +
      '</span>';
  }
  function attachHtml(atts) {
    if (!Array.isArray(atts) || !atts.length) return '';
    var html = '<div class="msg-attach">';
    atts.forEach(function(a){
      var url = a.cdn_url || '';
      if (!url) return;
      var nm = a.filename || '';
      var sz = a.size || 0;
      if (/^image\//.test(a.mime || '') || /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(nm)) {
        html += '<div class="att-item">' +
          '<a href="' + url + '" target="_blank" rel="noopener" data-lb="' + escHtml(url) + '" data-lbname="' + escHtml(nm) + '" data-lbsize="' + sz + '" title="' + escHtml(nm) + ' · ' + _kk('goods.dm.clickView', '点击查看') + '">' +
          '<img src="' + url + '" alt="" loading="lazy"></a>' +
          _attActs(url, nm, sz) + '</div>';
      } else {
        html += '<div class="attach-file" data-dl="' + escHtml(url) + '" data-dlname="' + escHtml(nm || _kk('goods.dm.attachment', '附件')) + '" data-dlsize="' + sz + '" title="' + _kk('goods.dm.clickSave', '点击保存（Shift+点击 = 另存为）') + '">' +
          '<span class="af-ic qqi qqi-file"></span>' +
          '<span class="af-meta"><span class="af-name">' + escHtml(nm || _kk('goods.dm.attachment', '附件')) + '</span>' +
          '<span class="af-size">' + fmtBytes(sz) + '</span></span>' +
          _attActs(url, nm, sz) + '</div>';
      }
    });
    html += '</div>';
    return html;
  }

  // ═══ 附件动作机（save / save as / open / Roam）+ 下载机器接入（2026-09-14 v2）═══
  // 下载唯一入口 = 主窗口 window.qqqideDownload（core/download-machine.js，记忆目录静默直存）；
  // open = bridge.shell.openPath（默认程序）；Roam = 主窗口 __qqq_roamRevealPath（shell-overlay 定位引擎）。
  function attMachine() { try { var m = parent.qqqideDownload; return (m && typeof m.save === 'function') ? m : null; } catch (_) { return null; } }
  function attBridge() { try { return parent.qqqideBridge || null; } catch (_) { return null; } }
  function attStat(p) { try { var b = attBridge(); if (b && b.fs && b.fs.stat) return b.fs.stat(p); } catch (_) {} return Promise.resolve(null); }
  function attJoin(dir, name) { if (!dir || !name) return ''; return String(dir).replace(/[\\/]+$/, '') + '\\' + name; }
  function attQoast(msg, opts) { try { if (parent.qqqideQoast) parent.qqqideQoast.show(msg, opts || {}); } catch (_) {} }
  function attRevealRoam(p) {
    if (!p) return false;
    try { if (typeof parent.__qqq_roamRevealPath === 'function') { parent.__qqq_roamRevealPath(p); return true; } } catch (_) {}
    try { parent.postMessage({ action: 'roam-reveal-path', text: p, ctx: '' }, '*'); return true; } catch (_) {}
    try { var b = attBridge(); if (b && b.shell && b.shell.showItemInFolder) { b.shell.showItemInFolder(p); return true; } } catch (_) {}
    return false;
  }
  function attOpenLocal(p) { try { var b = attBridge(); if (b && b.shell && b.shell.openPath) { b.shell.openPath(p); return true; } } catch (_) {} return false; }
  function attExternal(url) { try { var b = attBridge(); if (b && b.shell && b.shell.openExternal) { b.shell.openExternal(url); return; } } catch (_) {} try { window.open(url, '_blank'); } catch (_) {} }

  // 四小链接 + 整卡点击的统一动作机
  function attachAction(kind, url, name, size) {
    if (!url) return;
    var m = attMachine();
    if (!m) { attExternal(url); return; }   // 无机器（旧缓存/独立页）→ 原生兜底
    name = name || _kk('goods.dm.attachment', '附件');
    if (kind === 'saveas') { m.save(url, name, { size: size || 0, ask: true }); return; }
    var lastDir = '';
    try { lastDir = (m.getLastDir && m.getLastDir()) || ''; } catch (_) {}
    var probe = attJoin(lastDir, name);
    if (kind === 'save') {
      if (!probe) { m.save(url, name, { size: size || 0 }); return; }
      // 记忆目录已有同名文件 → 不重复下载（防 name (1) 副本周），给 Roam 直达
      attStat(probe).then(function (st) {
        if (st && st.isFile) {
          attQoast(_kk('goods.dm.alreadyAt', '已在：{0}', probe), { duration: 9000, action: { label: _kk('shell.dl.roamLocate', '📂 Roam 定位'), onClick: function () { attRevealRoam(probe); } } });
          return;
        }
        m.save(url, name, { size: size || 0 });
      }, function () { m.save(url, name, { size: size || 0 }); });
      return;
    }
    // open / Roam：先确保本地存在（记忆目录命中直接复用；否则静默下载/对话框）再动作
    function act(p) { if (kind === 'open') { attOpenLocal(p); } else { attRevealRoam(p); } }
    function fetchThenAct() {
      m.save(url, name, { size: size || 0, onDone: function (res) { if (res && res.ok && res.path) act(res.path); } });
    }
    if (probe) {
      attStat(probe).then(function (st) { if (st && st.isFile) { act(probe); return; } fetchThenAct(); }, fetchThenAct);
    } else { fetchThenAct(); }
  }
  var _lbEl = document.getElementById('img-lb');
  var _lbImg = document.getElementById('img-lb-img');
  var _lbUrl = '', _lbName = '', _lbSize = 0;
  function openImgLb(url, name, size) {
    _lbUrl = url; _lbName = name || ''; _lbSize = size || 0;
    if (_lbImg) _lbImg.src = url;
    if (_lbEl) _lbEl.classList.add('show');
  }
  function closeImgLb() {
    if (_lbEl) _lbEl.classList.remove('show');
    if (_lbImg) _lbImg.src = '';
  }
  if (_lbEl) {
    _lbEl.addEventListener('click', function (ev) { if (ev.target === _lbEl) closeImgLb(); });
    var _lbDlBtn = document.getElementById('img-lb-dl');
    if (_lbDlBtn) _lbDlBtn.addEventListener('click', function (ev) {
      attachAction((ev && ev.shiftKey) ? 'saveas' : 'save', _lbUrl, _lbName, _lbSize);
    });
    var _lbCloseBtn = document.getElementById('img-lb-close');
    if (_lbCloseBtn) _lbCloseBtn.addEventListener('click', closeImgLb);
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _lbEl && _lbEl.classList.contains('show')) closeImgLb();
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    // ① 附件四小链接（save / save as / open / Roam）——最高优先，命中即截断
    var act = t.closest('[data-dlact]');
    if (act) {
      ev.preventDefault(); ev.stopPropagation();
      attachAction(act.getAttribute('data-dlact'), act.getAttribute('data-dlurl') || '', act.getAttribute('data-dlname') || '', parseInt(act.getAttribute('data-dlsize') || '0', 10) || 0);
      return;
    }
    // ② 文件卡片整卡点击 = save（Shift = save as）
    var f = t.closest('[data-dl]');
    if (f) {
      ev.preventDefault(); ev.stopPropagation();
      attachAction(ev.shiftKey ? 'saveas' : 'save', f.getAttribute('data-dl') || '', f.getAttribute('data-dlname') || '', parseInt(f.getAttribute('data-dlsize') || '0', 10) || 0);
      return;
    }
    // ③ 图片点击 = 灯箱
    var im = t.closest('a[data-lb]');
    if (im) {
      ev.preventDefault();
      openImgLb(im.getAttribute('data-lb'), im.getAttribute('data-lbname') || '', parseInt(im.getAttribute('data-lbsize') || '0', 10) || 0);
    }
  }, true);
  // ★ 图片加载失败（bed 已删/网络）→「附件已删除」占位：capture 阶段捕获（资源 error 不冒泡），
  //   连 <a> 一起换掉（防点击占位再甩外部浏览器）。2026-09-14 根治旧内联 onerror 的嵌套引号断裂——
  //   旧写法 class=\"…\" 在 HTML 属性里提前闭合 →「⚠️附件已删除」被错误恢复成永久可见垃圾文字
  //   （与图片加载成败无关、每图恒泄漏，Chromium 实证：图正常 + 垃圾字同行泄漏）。
  document.addEventListener('error', function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== 'IMG' || !t.closest) return;
    var a = t.closest('a[data-lb]');
    if (!a || !a.parentNode) return;
    var dead = document.createElement('div');
    dead.className = 'attach-dead';
    dead.innerHTML = '<span class="ad-ic">⚠️</span>' + _kk('goods.dm.attachDeleted', '附件已删除');
    var holder = a.parentNode;
    if (holder.classList && holder.classList.contains('att-item') && holder.parentNode) {
      holder.parentNode.replaceChild(dead, holder);   // 连四小链接行一起换掉（占位零残留）
    } else {
      holder.replaceChild(dead, a);
    }
  }, true);

  function cacheHas(peerID, id) {
    var arr = _msgCache[peerID];
    if (!arr) return false;
    for (var i=0;i<arr.length;i++) {
      if (arr[i].id === id) return true;
    }
    return false;
  }

  function scrollBottom() {
    $msgList.scrollTop = $msgList.scrollHeight;
  }

  function fmtTime(d) {
    var p = function(n){return n<10?'0'+n:''+n;};
    return p(d.getHours())+':'+p(d.getMinutes());
  }

  function fmtDay(d) {
    var now = new Date();
    var today = now.toDateString();
    var yday = new Date(now.getFullYear(),now.getMonth(),now.getDate()-1).toDateString();
    var dd = d.toDateString();
    if (dd === today) return _kk('goods.dm.today', '今天');
    if (dd === yday) return _kk('goods.dm.yesterday', '昨天');
    return _kk('goods.dm.monthDay', '{0}月{1}日', d.getMonth()+1, d.getDate());
  }

  function fmtBrief(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(d);
    return (d.getMonth()+1)+'/'+d.getDate();
  }

  function trunc(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0,n)+'…' : s;
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }


})();
