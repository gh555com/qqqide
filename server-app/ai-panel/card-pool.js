// ============================================================================
// card-pool.js — 终极 Card Queue 架构
//
// 铁律:
//   ① 一张 quest = 一张 Card（完整 DOM 子树），创建后永不 innerHTML 清空
//   ② 切换 quest = 纯 CSS display 显隐，零 DOM 销毁
//   ③ 每张 Card 最多持有 FLOOR_CAP_CAPPED + FLOOR_CAP_BUILDING 层楼 DOM
//   ④ 超限 → 最老楼层 DOM remove() 彻底删除（conversation JSON 保留于内存）
//   ⑤ Card Pool 上限 CARD_POOL_MAX，LRU 驱逐
//   ⑥ A1 块始终在电子钟上方（固定创建顺序）
// ============================================================================

var CardPool = (function () {
  'use strict';

  // ═══ 配置常量（唯一真理源） ═══
  var FLOOR_CAP_CAPPED = 16;     // 最多显示已封顶楼层数
  var FLOOR_CAP_BUILDING = 1;   // 最多显示在建楼层数（0 或 1）
  var CARD_POOL_MAX = 10;       // Card Pool 上限

  // ═══ 构造函数 ═══
  function CardPool(containerEl, options) {
    this._container = containerEl;  // #messages 元素
    this._cards = {};               // { questId: Card }
    this._lru = [];                 // 访问顺序（尾部=最新）
    this._activeId = null;          // 当前活跃 questId
    this._options = options || {};

    // 公开常量
    this.FLOOR_CAP_CAPPED = FLOOR_CAP_CAPPED;
    this.FLOOR_CAP_BUILDING = FLOOR_CAP_BUILDING;
    this.CARD_POOL_MAX = CARD_POOL_MAX;
  }

  // ═══ Card 对象 ═══
  // card = {
  //   id: questId,
  //   dom: <div class="card">,        ← 在 #messages 内的容器
  //   floors: [F1_data, F2_data, ...], ← 全量 JSON（从 SQLite 加载后保留）
  //   totalFloors: N,
  //   buildingFloor: floorNum|null,    ← 当前在建的楼层号
  //   floorDOM: Map<floorNum, DOM>,    ← 当前持有 DOM 的楼层
  //   _userScrolledUp: false,
  //   _scrollTop: 0,
  // }

  function Card(id) {
    this.id = id;
    this.dom = null;           // 在首次 getOrCreate 时创建
    this.floors = [];          // [{ floorNum, question, houses, costWge, allTxtPath, ... }]
    this.totalFloors = 0;
    this.buildingFloor = null;
    this.floorDOM = {};        // { floorNum: { userEl, aiEl, a1El, clockEl } }
    this._userScrolledUp = false;
    this._scrollTop = 0;
    this._floorMetaMap = {};   // { floorNum: { allTxtPath, houses, costWge } }
  }

  Card.prototype._initDOM = function () {
    if (this.dom) return;
    this.dom = document.createElement('div');
    this.dom.className = 'card';
    this.dom.setAttribute('data-quest', this.id);
    this.dom.style.cssText = 'display:none; width:100%;';
    // 内部内容容器
    this._contentWrap = document.createElement('div');
    this._contentWrap.className = 'card-content';
    this.dom.appendChild(this._contentWrap);
  };

  // 获取或创建 Card
  CardPool.prototype.getOrCreate = function (questId) {
    if (this._cards[questId]) {
      this._touchLRU(questId);
      return this._cards[questId];
    }
    // 检查上限
    while (this._lru.length >= CARD_POOL_MAX) {
      var evictId = this._lru[0];
      this._evict(evictId);
    }
    var card = new Card(questId);
    card._initDOM();
    this._container.appendChild(card.dom);
    this._cards[questId] = card;
    this._lru.push(questId);
    return card;
  };

  // ═══ LRU 管理 ═══
  CardPool.prototype._touchLRU = function (questId) {
    var idx = this._lru.indexOf(questId);
    if (idx >= 0) {
      this._lru.splice(idx, 1);
      this._lru.push(questId);
    }
  };

  // ═══ 驱逐 Card ═══
  CardPool.prototype._evict = function (questId) {
    var card = this._cards[questId];
    if (!card) return;
    // [silent] evicting card

    // abort 该 quest 的 agent（如果还在跑）
    var _evictAgent = parent.__qqq_agentPool && parent.__qqq_agentPool[questId];
    if (_evictAgent) {
      if (_evictAgent._floorTimerId) { clearInterval(_evictAgent._floorTimerId); _evictAgent._floorTimerId = null; }
      try { _evictAgent.abort(); } catch (_) { }
      delete parent.__qqq_agentPool[questId];
    }

    // 移除 DOM
    if (card.dom && card.dom.parentNode) {
      card.dom.parentNode.removeChild(card.dom);
    }

    // 清理
    card.dom = null;
    card.floorDOM = {};
    card._floorMetaMap = {};
    card.floors = [];

    delete this._cards[questId];
    var idx = this._lru.indexOf(questId);
    if (idx >= 0) this._lru.splice(idx, 1);
  };

  // ═══ 切换到指定 quest ═══
  CardPool.prototype.switchTo = async function (questId) {
    var qs = window.questStore;
    // [silent] switchTo called
    if (questId === this._activeId) { /* silent: already active */ return; }

    // 保存旧 card 滚动位置
    if (this._activeId && this._cards[this._activeId]) {
      var oldCard = this._cards[this._activeId];
      oldCard._userScrolledUp = oldCard._userScrolledUp || false;
      oldCard._scrollTop = oldCard.dom.parentNode ? oldCard.dom.parentNode.scrollTop : 0;
    }

    // 隐藏旧 card
    if (this._activeId && this._cards[this._activeId] && this._cards[this._activeId].dom) {
      this._cards[this._activeId].dom.style.display = 'none';
    }

    // 获取或创建目标 card
    var card = this.getOrCreate(questId);

    // 如果 card 是首次创建（totalFloors === 0 且未尝试过加载），从 questStore 加载
    // [silent] switchTo check
    if (card.totalFloors === 0 && qs) {
      await this._loadCardData(card);
    } else if (card.totalFloors === -1) {
      console.warn('[card-pool] card ' + questId + ' previously failed to load, skipping');
    }
    // [silent] already loaded, skip

    // 显示目标 card
    card.dom.style.display = 'block';
    this._activeId = questId;

    // 恢复滚动位置
    var container = card.dom.parentNode;
    if (container) {
      container.scrollTop = card._scrollTop || 0;
    }

    return card;
  };

  // ═══ 从 questStore 加载 Card 数据 ═══
  CardPool.prototype._loadCardData = async function (card) {
    var qs = window.questStore;
    // [silent] _loadCardData called
    if (!qs) { console.warn('[card-pool] questStore unavailable, aborting load'); return; }
    try {
      var allFloors = await qs.loadAllFloors(card.id);
      var questMeta = await qs.load(card.id);

      card.floors = allFloors || [];
      card.totalFloors = card.floors.length;
      card.buildingFloor = null;  // 初次加载时无在建楼

      // 构建 floorMetaMap
      var root = qs ? qs.getProjectRoot() : null;
      for (var fi = 0; fi < card.floors.length; fi++) {
        var fData = card.floors[fi].data;
        var fNum = card.floors[fi].floorNum;
        card._floorMetaMap[fNum] = {
          questId: card.id,
          allTxtPath: fData.allTxtPath || '',
          houses: fData.houses || [],
          costWge: fData.costWge || 0
        };
      }

      // 提取 quest 级 timings（用于停止态时钟渲染）
      var questTimings = (questMeta && questMeta.floorTimings) || [];

      // 构建视口 DOM：最近 FLOOR_CAP_CAPPED 层
      var startIdx = Math.max(0, card.totalFloors - FLOOR_CAP_CAPPED);
      for (var i = startIdx; i < card.totalFloors; i++) {
        try {
          this._buildFloorDOM(card, card.floors[i], false, questTimings);
        } catch (e) {
          console.error('[card-pool] _buildFloorDOM failed for floor ' + card.floors[i].floorNum + ':', e && (e.message || e));
        }
      }

      // ★ 重启聚合红框：将所有 .msg-err-individual 合并为一个 .msg-quest-error
      this._aggregateQuestErrors(card);

      // [silent] loaded card
    } catch (e) {
      console.error('[card-pool] loadCardData FAILED for ' + card.id + ':', e && (e.message || e));
      // 防御：标记 card 为已尝试加载，避免 switchTo 死循环重试
      card.totalFloors = -1;
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // 流式对话渲染：将 conversation 数组转为 HTML（按消息类型分时序流）
  // ═══════════════════════════════════════════════════════════════
  // ═══ 唯一真理机：conversation → 显示 HTML（live onDone 与恢复共用） ═══
  // ★ 方案 C：flag 白名单，不依赖字符串匹配
  //   - _guideAck + role=assistant → 渲染引导确认
  //   - _injected + role=user       → 渲染注入消息
  //   - role=assistant + content    → 渲染 AI 文字回复
  //   - 其余一律不渲染（工具调用、工具结果、系统消息等）
  function _buildConversationFlowHtml(conv, fData) {
    if (!conv || !conv.length) {
      // ★ 仅在真正流式中断时展示 _streamingText（_streaming 为 true 才说明是中断，而非正常完成后的残留）
      if (fData && fData._streamingText && fData._streaming) {
        return '<div class="msg-flow-partial">' + _escHtml(fData._streamingText) + '</div><div class="msg-status">⏳ 打印中断（已自动保存）</div>';
      }
      return '';
    }

    var parts = [];
    var seenFirstUser = false;

    for (var i = 0; i < conv.length; i++) {
      var m = conv[i];
      if (!m || typeof m !== 'object') continue;

      // 跳过第一个 user 消息（由 userEl 单独渲染）
      if (m.role === 'user' && !seenFirstUser) {
        seenFirstUser = true;
        continue;
      }

      // ═══ flag 白名单 ═══
      if (m._guideAck && m.role === 'assistant') {
        // 引导确认回合：渲染引导注入信息 + AI 确认回复
        if (m._guideText) {
          parts.push('<div class="msg-flow-guide-inject"><div class="msg-flow-guide-hdr"><span class="msg-flow-icon">⚡</span> 引导信息</div><div class="msg-flow-guide-body">' + _escHtml(m._guideText) + '</div></div>');
        }
        var _ackText = (m.content || '已收到引导').replace(/^✅\s*/, '').trim();
        // ★ 始终渲染绿条（即使 _ackText 为空也显示占位，防止空洞）
        parts.push('<div class="msg-flow-guide-ack"><div class="msg-flow-guide-ack-hdr"><span class="msg-flow-icon">✅</span> 已收到引导</div><div class="msg-flow-guide-ack-body">' + _escHtml(_ackText || '已收到引导') + '</div></div>');
      } else if (m._injected && m.role === 'user') {
        // 降级注入消息（如 [GUIDE] 注入）
        var _injText = String(m.content || '').replace(/^\[GUIDE\]\s*/, '').trim();
        if (_injText) {
          parts.push('<div class="msg-flow-guide-inject"><div class="msg-flow-guide-hdr"><span class="msg-flow-icon">📌</span> 引导信息</div><div class="msg-flow-guide-body">' + _escHtml(_injText) + '</div></div>');
        }
      } else if (m._error && m.role === 'assistant') {
        // ★ 错误消息：渲染时逐个显示，重启后由 _aggregateQuestErrors 统一聚合
        var _errText = (m.content || '⚠️ 楼层异常中断，对话已保存。');
        parts.push('<div class="msg msg-error msg-err-individual" style="white-space:pre-wrap">' + _escHtml(_errText) + ' <a class="msg-err-continue" href="#" data-i18n="ai.error.continueTask">继续任务</a></div>');
      } else if (m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string' && m.content) {
        // 普通 AI 文字回复（数据已在 EnvelopeStripper 清洗，直接渲染）
        var _rm = window.renderMarkdown;
        parts.push(typeof _rm === 'function' ? _rm(m.content) : _escHtml(m.content));
      }
      // else: 工具调用、工具结果、系统消息 → 一律跳过
    }

    // ★ 附加流式中断文本（仅在真正中断时，而非 floor 正常完成后残留的 _streamingText）
    if (fData && fData._streamingText && fData._streaming) {
      parts.push('<div class="msg-flow-partial">' + _escHtml(fData._streamingText) + '</div>');
      parts.push('<div class="msg-status">⏳ 打印中断（已自动保存）</div>');
    }

    // ★ 工具执行总结
    if (parts.length === 0 && fData && fData.houses && fData.houses.length) {
      var _tc = 0;
      for (var _ti = 0; _ti < fData.houses.length; _ti++) {
        _tc += (fData.houses[_ti].toolCount || (fData.houses[_ti].tools ? fData.houses[_ti].tools.length : 0));
      }
      parts.push('<div class="msg-flow-tools-done">' + _escHtml('工具执行完毕' + (_tc > 0 ? '（' + _tc + ' 次调用）' : '')) + '</div>');
    }

    return parts.join('\n\n');
  }

  function _escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ═══ 图片信息填充：分辨率 + 文件大小 ═══
  // 文件大小来源：① 全局缓存 window.__qqqImgSizes（下载时 stat）② .img-info 已有则跳过
  function _formatFileSize(bytes) {
    if (!bytes || bytes < 0) return '';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1048576).toFixed(2) + 'MB';
  }

  function _fillImgInfo(img, info) {
    if (!info || info.textContent) return;
    var w = img.naturalWidth || img.width || 0;
    var h = img.naturalHeight || img.height || 0;
    if (!w || !h) return;
    // ★ 大小在左，分辨率在右："1.3MB · 1024×1024"
    var parts = [];
    // 文件大小：优先从全局缓存读取（download 时 stat），fallback 到 data-filesize 属性
    var cacheKey = (img.src || '').replace(/^file:\/\/\//, '').replace(/\//g, '/').replace(/^\/[A-Z]:/, function (m) { return m.slice(1); });
    var cache = typeof window !== 'undefined' && window.__qqqImgSizes ? window.__qqqImgSizes : null;
    var sz = 0;
    if (cache) {
      // 直接匹配
      if (cache[cacheKey]) sz = cache[cacheKey];
      // fallback: 遍历缓存的 key，路径规范化后比对
      if (!sz) {
        var _ckNorm = cacheKey.replace(/\\/g, '/').toLowerCase();
        var _cacheKeys = Object.keys(cache);
        for (var _cki = 0; _cki < _cacheKeys.length; _cki++) {
          if (_cacheKeys[_cki].replace(/\\/g, '/').toLowerCase() === _ckNorm) {
            sz = cache[_cacheKeys[_cki]];
            break;
          }
        }
      }
    }
    // fallback: data-filesize 属性
    if (!sz) {
      var _ds = img.getAttribute && img.getAttribute('data-filesize');
      if (_ds) sz = parseInt(_ds, 10) || 0;
    }
    if (sz > 0) parts.push(_formatFileSize(sz));
    parts.push(w + '\u00d7' + h);
    info.textContent = parts.join(' \u00b7 ');
  }

  function _populateImgInfos(container) {
    if (!container || !container.querySelectorAll) return;
    var wraps = container.querySelectorAll('.table-wrap');
    for (var _wi = 0; _wi < wraps.length; _wi++) {
      var _img = wraps[_wi].querySelector(':scope > img');
      var _inf = wraps[_wi].querySelector(':scope > .img-info');
      if (_img && _inf) _fillImgInfo(_img, _inf);
    }
  }

  // ★ 统一入口：一次性设置图片分辨率支持（扫描 + 委托 + Observer）
  function _setupImgSupport(contentWrap) {
    if (contentWrap._imgSupportReady) return;
    contentWrap._imgSupportReady = true;

    // ① 委托 load 捕获：任何 <img> 加载完成 → 自动填分辨率
    //    捕获阶段 + 事件冒泡，无论图片何时/以何种方式进入 DOM 都生效
    contentWrap.addEventListener('load', function (e) {
      var img = e.target;
      if (img.tagName !== 'IMG') return;
      var wrap = img.closest('.table-wrap');
      if (!wrap) return;
      var info = wrap.querySelector(':scope > .img-info');
      if (info) _fillImgInfo(img, info);
    }, true);

    // ② 初始扫描：处理已缓存/已加载的图片
    _populateImgInfos(contentWrap);

    // ③ MutationObserver：流式渲染中后续插入的子树
    var _obs = new MutationObserver(function (mutations) {
      for (var _mi = 0; _mi < mutations.length; _mi++) {
        var _nodes = mutations[_mi].addedNodes;
        for (var _ni = 0; _ni < _nodes.length; _ni++) {
          var _node = _nodes[_ni];
          if (_node.nodeType === 1) _populateImgInfos(_node);
        }
      }
    });
    _obs.observe(contentWrap, { childList: true, subtree: true });
    contentWrap._imgObserver = _obs;
  }

  // ═══ 构建单层楼的 DOM（插入 card._contentWrap） ═══
  // isBuilding: 是否在建楼层（在建楼层需要额外的 streaming 标记）
  CardPool.prototype._buildFloorDOM = function (card, floorEntry, isBuilding, questTimings) {
    var fData = floorEntry.data;
    var fNum = floorEntry.floorNum;
    if (card.floorDOM[fNum]) return;  // 已存在
    questTimings = questTimings || [];

    var frag = document.createDocumentFragment();

    // ① 渲染用户消息（纯文本，不渲染 Markdown）
    // ★ 优先 quest.sq3 预计算 question_clean（已剥离 CURRENT TIME + 系统提示词）
    var _qText = fData.question_clean || fData.question || '';
    if (!_qText) {
      var _conv = fData.conversation || [];
      // ★ 跳过 _persistent 消息（系统提示词/rules），找真正的用户问题
      for (var _cqi = 0; _cqi < _conv.length; _cqi++) {
        if (_conv[_cqi].role === 'user' && !_conv[_cqi]._persistent && _conv[_cqi].content) {
          _qText = _conv[_cqi].content;
          break;
        }
      }
    }
    // ★ 剥离尾部 CURRENT TIME 块（兜底：旧数据可能未预处理）
    if (_qText) {
      var _ctIdx = _qText.indexOf('\n\n═══ CURRENT TIME ═══');
      if (_ctIdx > 0) _qText = _qText.slice(0, _ctIdx);
    }
    var userEl = null;
    if (_qText) {
      userEl = document.createElement('div');
      userEl.className = 'msg msg-user';
      userEl.style.whiteSpace = 'pre-wrap';
      userEl._floor = fNum;
      var getUDC = window.getUserDisplayContent;
      var displayContent = typeof getUDC === 'function'
        ? getUDC(_qText)
        : _qText;
      userEl.textContent = displayContent;
      // ★ 恢复图片（背包图片引用）
      if (fData.images && fData.images.length > 0) {
        var imgRow = document.createElement('div');
        imgRow.style.cssText = 'margin-top:6px;';
        var _imgQuestId = card.id;
        var _imgFloorNum = fNum;
        for (var imi = 0; imi < fData.images.length; imi++) {
          var img = fData.images[imi];
          var wrap = document.createElement('span');
          wrap.className = 'msg-img-wrap';
          var imgEl = document.createElement('img');
          // ★ 优先用 dataUrl（缩略图），否则尝试从磁盘加载
          if (img.dataUrl) {
            imgEl.src = img.dataUrl;
          } else if (img.fileName && fData._fDir) {
            imgEl.src = fData._fDir + img.fileName;
          } else if (img.fileName && window.questStore && typeof window.questStore.resolveFloorDir === 'function') {
            // ★ 无 _fDir 时直接动态解析（极少发生，新 quest 首次建楼）
            window.questStore.resolveFloorDir(_imgQuestId, _imgFloorNum).then(function (_fDir) {
              if (_fDir) imgEl.src = _fDir + img.fileName;
            });
          }
          // ★ 防 _fDir 过期（quest 目录被 lazyRenameScan rename 后）→ onerror 重试
          if (img.fileName && !img.dataUrl && window.questStore && typeof window.questStore.resolveFloorDir === 'function') {
            (function (_qId, _fNum, _fn) {
              imgEl.addEventListener('error', function __retryImg() {
                if (this._retried) return;
                this._retried = true;
                window.questStore.resolveFloorDir(_qId, _fNum).then(function (_fDir2) {
                  if (_fDir2 && _fDir2 + _fn !== this.src) {
                    this.src = _fDir2 + _fn;
                  }
                }.bind(this));
              });
            })(_imgQuestId, _imgFloorNum, img.fileName);
          }
          if (img.fileName) imgEl.dataset.fileName = img.fileName;
          wrap.appendChild(imgEl);
          var badge = document.createElement('span');
          badge.className = 'msg-img-badge';
          badge.textContent = '#' + (img.id || (imi + 1));
          badge.onclick = (function (imgData, fDir, _qId, _fNum) {
            return function (ev) {
              ev.stopPropagation();
              var srcUrl = imgData.dataUrl;
              var b64 = imgData.base64 || '';
              if (!srcUrl && imgData.fileName) {
                if (fDir) srcUrl = fDir + imgData.fileName;
                // ★ badge 点击也用动态解析防 _fDir 过期
                if (window.questStore && typeof window.questStore.resolveFloorDir === 'function') {
                  window.questStore.resolveFloorDir(_qId, _fNum).then(function (_fDir2) {
                    if (_fDir2 && _fDir2 !== fDir) {
                      if (typeof openLightbox === 'function') openLightbox(_fDir2 + imgData.fileName, b64);
                    }
                  });
                }
              }
              if (typeof openLightbox === 'function') {
                if (srcUrl) openLightbox(srcUrl, b64);
              }
            };
          })(img, fData._fDir || '', _imgQuestId, _imgFloorNum);
          wrap.appendChild(badge);
          imgRow.appendChild(wrap);
        }
        userEl.appendChild(imgRow);
      }
      frag.appendChild(userEl);
    }

    // ①b AI 等级 + 启动时间指示器（用户消息与 AI 回复之间）
    if (fData.aiStartTime && fData.tierLabel) {
      var tierEl = document.createElement('div');
      tierEl.className = 'msg-tier-indicator';
      tierEl.textContent = fData.tierLabel + ' start in ' + fData.aiStartTime;
      frag.appendChild(tierEl);
    }

    // ② 渲染 AI 回复
    var aiEl = document.createElement('div');
    aiEl.className = 'msg msg-ai';
    aiEl._floor = fNum;
    aiEl._contentWrap = document.createElement('div');

    // ★ 优先用预渲染 ai_html（quest.sq3 真理源），建楼时已跑过 _buildConversationFlowHtml
    //   仅当 ai_html 为空（旧数据未迁移）时才回退到现场渲染
    var conv = fData.conversation || [];
    var flowHtml = fData.ai_html || '';
    if (!flowHtml && typeof _buildConversationFlowHtml === 'function') {
      flowHtml = _buildConversationFlowHtml(conv, fData);
    }
    aiEl._contentWrap.innerHTML = flowHtml;
    // ★ 后处理：将裸 <img>（旧格式缓存/回退渲染）统一包裹为 .table-wrap.img-wrap
    var _bareImgs = aiEl._contentWrap.querySelectorAll('img');
    for (var _bi = 0; _bi < _bareImgs.length; _bi++) {
      var _bImg = _bareImgs[_bi];
      if (_bImg.closest('.table-wrap')) continue;
      var _twrap = document.createElement('div');
      _twrap.className = 'table-wrap img-wrap';
      var _tbtn = document.createElement('span');
      _tbtn.className = 'table-view-btn';
      _tbtn.textContent = '\u25b6 \u5c55\u5f00';
      var _iinfo = document.createElement('span');
      _iinfo.className = 'img-info';
      _bImg.parentNode.insertBefore(_twrap, _bImg);
      _twrap.appendChild(_tbtn);
      _twrap.appendChild(_iinfo);
      _twrap.appendChild(_bImg);
    }
    aiEl.appendChild(aiEl._contentWrap);
    // ★ 统一填充所有 .img-info（覆盖新渲染 + 旧格式迁移 + load 委托 + Observer）
    _setupImgSupport(aiEl._contentWrap);
    // ★ 事件委托（点击）：继续任务链接 + 表格/代码块预览
    //   表格/代码块从 DOM 自描述内容读取，零全局状态，跨面板切换不失效
    aiEl._contentWrap.addEventListener('click', function (e) {
      var link = e.target.closest('.msg-err-continue');
      if (link) {
        e.preventDefault();
        // ★ fatal 态恢复：点击"继续任务"触发完整恢复管线
        var _curAgent = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
        var _curQuestId = (typeof questActiveId !== 'undefined') ? questActiveId : null;
        if (_curAgent && _curAgent._stopState === 'fatal') {
          if (!link._qqqRecoveryBusy) {
            link._qqqRecoveryBusy = true;
            if (typeof _startRecovery === 'function') _startRecovery(_curQuestId, _curAgent, link);
          }
          return;
        }
        if (typeof $input !== 'undefined' && $input) $input.focus();
        if (typeof scrollToBottom === 'function') scrollToBottom(true);
        return;
      }
      var btn = e.target.closest('.table-view-btn');
      if (btn) {
        var wrap = btn.closest('.table-wrap');
        if (wrap) {
          var img = wrap.querySelector(':scope > img');
          if (img && img.src && typeof _postToHost === 'function') {
            _postToHost({ type: 'qqqide-overlay', action: 'open-image', src: img.src });
          } else {
            var pre = wrap.querySelector(':scope > pre');
            var inner = wrap.querySelector(':scope > .table-inner');
            var content = pre ? pre.outerHTML : (inner ? inner.innerHTML : '');
            if (content && typeof _postToHost === 'function') {
              _postToHost({ type: 'qqqide-overlay', action: 'open-table', html: '<div class="msg-ai">' + content + '</div>' });
            }
          }
        }
      }
    });
    // 存储完整对话文本（用于全文检索等）
    var fullText = '';
    for (var ci = 0; ci < conv.length; ci++) {
      if (typeof conv[ci].content === 'string') fullText += conv[ci].content + '\n';
    }
    if (fData._streamingText) fullText += fData._streamingText;
    aiEl._fullText = fullText;

    // ③ 创建电子钟+饼图（最底部锚点）
    var _initClk = window._initClockBlock;
    if (typeof _initClk === 'function') {
      _initClk(aiEl);
    }

    // ④ 创建 A1 豆腐块（clockBlock 已存在，insertBefore 精准插入时钟上方）
    // 铁律顺序: A4 → A1 → clock，先创建下层锚点
    var meta = card._floorMetaMap[fNum];
    var a1El = null;
    var _a1Path = (meta && meta.allTxtPath) || '';
    var _initA1 = window._initA1Block;
    var _updA1 = window._updateA1Row1;
    var _cntR = window._countRooms;
    if (typeof _initA1 === 'function') {
      a1El = _initA1(aiEl, _a1Path, card.id, fNum);
      if (a1El) {
        var hCount = (fData.house_count != null) ? fData.house_count : (meta && meta.houses ? meta.houses.length : 0);
        var _fallbackRc = (typeof _cntR === 'function' && meta && meta.houses) ? _cntR(meta.houses) : 0;
        var rCount = (fData.room_count != null && fData.room_count > 0) ? fData.room_count : _fallbackRc;
        if (typeof _updA1 === 'function') {
          _updA1(a1El, fNum, hCount, rCount);
        }
        var _fs = fData.fileStats;
        if (_fs && a1El._r2a) {
          a1El._r2a.textContent = 'FILE ' + (_fs.fileCount || 0);
          a1El._r2b.textContent = '   ROW +' + (_fs.added || 0) + ' -' + (_fs.deleted || 0);
          if (a1El._r2) {
            var _hasChg = (_fs.fileCount || 0) > 0 || (_fs.added || 0) > 0 || (_fs.deleted || 0) > 0;
            a1El._r2.style.display = _hasChg ? '' : 'none';
          }
        }
        var bridge2 = window.parent && window.parent.qqqideBridge;
        if (bridge2 && _a1Path) {
          bridge2.fs.stat(_a1Path).then(function (st) {
            if (st && st.size && typeof _updA1 === 'function') {
              _updA1(a1El, fNum, hCount, rCount, st.size);
            }
          }).catch(function () { });
        }
      }
    }

    // ④b 恢复 A4 文件快照块（在 A1 之前）
    // A1 已存在，_initA4Block 会 insertBefore(A1) 定位
    if (typeof window._a4RestoreBlock === 'function' && fData.a4Snapshots && fData.a4Snapshots.length) {
      var _a4NumId = 0;
      if (window.questStore && window.questStore._index) {
        for (var _qi = 0; _qi < window.questStore._index.length; _qi++) {
          if (window.questStore._index[_qi].id === card.id) { _a4NumId = window.questStore._index[_qi].numericId || 0; break; }
        }
      }
      window._a4RestoreBlock(aiEl, fData.a4Snapshots, _a4NumId, fNum);
    }

    // ⑤ 已封顶楼层：始终设时钟为停止态（dark），不管是否找到计时数据
    if (aiEl._clockBlock) {
      aiEl._clockBlock.className = 'msg-ai-clock';
    }
    var timing = fData.clockTiming || null;
    if (!timing) {
      for (var ti = 0; ti < questTimings.length; ti++) {
        if (questTimings[ti].floorIndex === fNum) { timing = questTimings[ti]; break; }
      }
    }
    if (timing && aiEl._clockMin && aiEl._clockCanvas) {
      var totalS = Math.floor((timing.durationMs || 0) / 1000);
      var min = Math.floor(totalS / 60);
      var sec = totalS % 60;
      aiEl._clockMin.textContent = min + 'm';
      aiEl._clockSec.textContent = ':' + (sec < 10 ? '0' : '') + sec + 's';
      var _dp = window.drawPie;
      if (typeof _dp === 'function') {
        _dp(aiEl._clockCanvas, {
          networkMs: timing.networkMs || 0,
          aiMs: timing.aiMs || 0,
          otherMs: timing.otherMs || 0,
          totalMs: timing.durationMs || 0
        });
      }
      aiEl._clockCanvas.style.visibility = 'visible';
    }

    // ⑥ 恢复历史楼层成本显示
    if (fData.costWge && aiEl._clockCost) {
      var _rawGe = fData.costWge / 10000;
      var _displayGe = typeof _formatGeDisplay === 'function' ? _formatGeDisplay(_rawGe) : _rawGe.toFixed(2);
      var isFree = fData.floorFree === true;
      aiEl._clockCost._rawGe = typeof _formatGeRaw === 'function' ? _formatGeRaw(_rawGe) : _rawGe.toFixed(4);
      aiEl._clockCost.textContent = _displayGe + ' ge' + (isFree ? ' Free' : '');
      aiEl._clockCost.style.display = 'inline';
      aiEl._clockCost._houses = fData.houses || [];
      if (isFree) {
        aiEl._clockCost.style.color = '#859900';
      } else {
        aiEl._clockCost.style.color = '';
      }
    }

    if (isBuilding) {
      aiEl.classList.add('card-building');
    }

    frag.appendChild(aiEl);

    // 存储 floor DOM 引用
    card.floorDOM[fNum] = { userEl: userEl, aiEl: aiEl, a1El: a1El, clockEl: aiEl._clockBlock };
    card._contentWrap.appendChild(frag);
  };

  // ═══ 在建楼：创建 AI div（A1 + 时钟），插入活跃 Card ═══
  // 返回 aiEl 供 startFloorTimer / agent.send 使用
  // 注意：用户消息由外部 addUserMessageEl 创建，此处不重复
  CardPool.prototype.startBuildingFloor = function (questId, floorNum, allTxtPath) {
    // ★ 兜底：若 card 不存在（新建 quest 首次发消息），自动创建
    var card = this.getOrCreate(questId);
    if (!this._activeId || this._activeId !== questId) {
      // 活跃 card 不匹配 → 隐藏旧 card，显示目标 card
      if (this._activeId && this._cards[this._activeId] && this._cards[this._activeId].dom) {
        this._cards[this._activeId].dom.style.display = 'none';
      }
      this._activeId = questId;
      card.dom.style.display = 'block';
    }

    // 若已有在建楼，先封顶
    if (card.buildingFloor !== null) {
      this._capFloor(card, card.buildingFloor);
    }

    card.totalFloors = Math.max(card.totalFloors, floorNum);
    card.buildingFloor = floorNum;

    // 创建在建楼层 AI div
    var aiEl = document.createElement('div');
    aiEl.className = 'msg msg-ai card-building';
    aiEl._floor = floorNum;
    aiEl._contentWrap = document.createElement('div');
    // ★ 极致一次渲染：不留占位文字，流式 token 抵达后直接长出首批 DOM
    aiEl.appendChild(aiEl._contentWrap);
    // ★ 事件委托（点击）：表格/代码块预览 — DOM 自描述，零全局状态
    aiEl._contentWrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.table-view-btn');
      if (!btn) return;
      var wrap = btn.closest('.table-wrap');
      if (!wrap) return;
      var img = wrap.querySelector(':scope > img');
      if (img && img.src && typeof _postToHost === 'function') {
        _postToHost({ type: 'qqqide-overlay', action: 'open-image', src: img.src });
      } else {
        var pre = wrap.querySelector(':scope > pre');
        var inner = wrap.querySelector(':scope > .table-inner');
        var content = pre ? pre.outerHTML : (inner ? inner.innerHTML : '');
        if (content && typeof _postToHost === 'function') {
          _postToHost({ type: 'qqqide-overlay', action: 'open-table', html: '<div class="msg-ai">' + content + '</div>' });
        }
      }
    });
    // ★ 图片分辨率支持（load 委托 + 扫描 + Observer）
    _setupImgSupport(aiEl._contentWrap);
    aiEl._fullText = '';
    aiEl._buf = '';
    aiEl._paras = [];
    aiEl._codeFenceOpen = false;
    aiEl._dirty = false;
    aiEl._renderScheduled = false;
    aiEl._renderedCount = 0;
    aiEl._lastParaEl = null;
    aiEl._firstRenderDone = false;  // ★ 每层楼首次渲染不节流，16ms 即刻落地
    // A1 块（必须在电子钟之前）
    var _initA1b = window._initA1Block;
    var _updA1b = window._updateA1Row1;
    if (allTxtPath && typeof _initA1b === 'function') {
      var a1El = _initA1b(aiEl, allTxtPath, questId, floorNum);
      if (a1El) {
        if (typeof _updA1b === 'function') { _updA1b(a1El, floorNum, 0, 0); }
        // ★ 新楼层所有计数归零，防上一楼层残影
        if (a1El._r1sz) a1El._r1sz.textContent = '0';
        if (a1El._r2a) a1El._r2a.textContent = 'FILE 0';
        if (a1El._r2b) a1El._r2b.textContent = '   ROW +0 -0';
      }
    }

    // 时钟（在建态）
    var _initClkB = window._initClockBlock;
    if (typeof _initClkB === 'function') {
      _initClkB(aiEl);
    }

    // 插入 Card 内容区
    card._contentWrap.appendChild(aiEl);
    card.floorDOM[floorNum] = card.floorDOM[floorNum] || {};
    card.floorDOM[floorNum].aiEl = aiEl;
    card.floorDOM[floorNum].clockEl = aiEl._clockBlock;

    // 6+1 裁剪
    this._trimCapped(card);

    return aiEl;
  };

  // ═══ 封顶在建楼（onDone 时调用） ═══
  CardPool.prototype.completeBuildingFloor = function (questId, floorNum) {
    var card = this._cards[questId];
    if (!card) return;
    // 若 buildingFloor 匹配，封顶
    if (card.buildingFloor === floorNum) {
      var dom = card.floorDOM[floorNum];
      if (dom && dom.aiEl) {
        dom.aiEl.classList.remove('card-building');
      }
      card.buildingFloor = null;
    }
    this._trimCapped(card);
  };

  // ═══ 封顶在建楼 ═══
  CardPool.prototype._capFloor = function (card, floorNum) {
    var dom = card.floorDOM[floorNum];
    if (!dom || !dom.aiEl) return;
    dom.aiEl.classList.remove('card-building');
    card.buildingFloor = null;
    this._trimCapped(card);
  };

  // ═══ 裁剪：保留最近 FLOOR_CAP_CAPPED 层已封顶楼层 ═══
  CardPool.prototype._trimCapped = function (card) {
    var cappedFloors = [];
    for (var fn in card.floorDOM) {
      if (card.floorDOM.hasOwnProperty(fn)) {
        var fNum = parseInt(fn, 10);
        if (fNum !== card.buildingFloor) {
          cappedFloors.push(fNum);
        }
      }
    }
    cappedFloors.sort(function (a, b) { return a - b; });

    while (cappedFloors.length > FLOOR_CAP_CAPPED) {
      var oldest = cappedFloors.shift();
      var dom = card.floorDOM[oldest];
      if (dom) {
        if (dom.userEl && dom.userEl.parentNode) dom.userEl.parentNode.removeChild(dom.userEl);
        if (dom.aiEl && dom.aiEl.parentNode) dom.aiEl.parentNode.removeChild(dom.aiEl);
        delete card.floorDOM[oldest];
      }
      // [silent] trimmed floor
    }
  };

  // ═══ 获取活跃 Card ═══
  CardPool.prototype.getActive = function () {
    return this._activeId ? this._cards[this._activeId] : null;
  };

  // ═══ 获取指定 Card ═══
  CardPool.prototype.getCard = function (questId) {
    return this._cards[questId] || null;
  };

  // ═══ 删除 quest 对应的 Card ═══
  CardPool.prototype.removeCard = function (questId) {
    if (this._activeId === questId) this._activeId = null;
    this._evict(questId);
  };

  // ═══ 销毁整个 Card Pool（切换 workspace 时用） ═══
  CardPool.prototype.destroy = function () {
    // 1. 中止所有运行中的 agent
    var pool = parent.__qqq_agentPool;
    if (pool) {
      var apIds = Object.keys(pool);
      for (var i = 0; i < apIds.length; i++) {
        var _ag = pool[apIds[i]];
        if (_ag._floorTimerId) { clearInterval(_ag._floorTimerId); _ag._floorTimerId = null; }
        try { _ag.abort(); } catch (_) { }
      }
    }
    // 2. 移除所有 card DOM
    var cardIds = Object.keys(this._cards);
    for (var j = 0; j < cardIds.length; j++) {
      var card = this._cards[cardIds[j]];
      if (card.dom && card.dom.parentNode) {
        card.dom.parentNode.removeChild(card.dom);
      }
    }
    // 3. 清空内部状态
    this._cards = {};
    this._lru = [];
    this._activeId = null;
    // [silent] destroyed
  };

  // ═══ 在当前活跃 Card 上滚动到底 ═══
  CardPool.prototype.scrollActiveToBottom = function (force) {
    var card = this.getActive();
    if (!card || !card.dom) return;
    if (force || !card._userScrolledUp) {
      var container = card.dom.parentNode;
      if (!container) return;
      // 方案1：scrollHeight（主流，快）
      container.scrollTop = container.scrollHeight;
      // 方案2：时钟块 scrollIntoView({block:'end'}) 兜底，破 content-visibility / margin 导致的 scrollHeight 不准
      // 用 getBoundingClientRect 做前置检测，避免不必要的 scrollIntoView 触发布局抖动
      var clockBlock = card._contentWrap.querySelector('.msg-ai-clock');
      if (clockBlock) {
        var cr = container.getBoundingClientRect();
        var clr = clockBlock.getBoundingClientRect();
        if (clr.bottom > cr.bottom + 1) {
          clockBlock.scrollIntoView({ block: 'end', behavior: 'auto', inline: 'nearest' });
        }
      }
      // ★ 记录自动滚动时间戳，用于 onUserScroll 区分程序滚动 vs 用户拖拽滚动条
      card._lastAutoScroll = Date.now();
    }
  };

  // ═══ 用户滚动跟踪（scroll 事件，比 wheel 更可靠） ═══
  CardPool.prototype.onUserScroll = function (e) {
    var card = this.getActive();
    if (!card) return;
    var container = card.dom.parentNode;
    if (!container) return;
    var atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    if (atBottom) {
      // 用户在底部 → 恢复自动滚动
      card._userScrolledUp = false;
    } else {
      // ★ 不在底部且非程序自动滚动（拖拽滚动条 / 键盘上翻等）→ 立即停自动跟滚
      if (!card._lastAutoScroll || Date.now() - card._lastAutoScroll > 250) {
        card._userScrolledUp = true;
      }
    }
  };

  // ═══ 用户手动上滚标记（wheel 事件，deltaY<0 时立即标记；下滚等到底部才恢复） ═══
  CardPool.prototype.onUserWheel = function (e) {
    var card = this.getActive();
    if (!card) return;
    if (e.deltaY < 0) {
      // 用户向上滚 → 立即停止自动滚动
      card._userScrolledUp = true;
    }
    // 下滚不立即恢复，等 scroll 事件检测到底部
  };

  // ═══ 获取 Card 内楼层 DOM ═══
  CardPool.prototype.getFloorDOM = function (questId, floorNum) {
    var card = this._cards[questId];
    if (!card) return null;
    return card.floorDOM[floorNum] || null;
  };

  // ═══ 更新 Card 的 floorMetaMap ═══
  CardPool.prototype.updateFloorMeta = function (questId, floorNum, meta) {
    var card = this._cards[questId];
    if (!card) return;
    card._floorMetaMap[floorNum] = meta;
  };

  // ═══════════════════════════════════════════════════════════
  // 滚动条标记叠层（全局 #scroll-mark-layer，覆盖在滚动条滑轨上）
  // ═══════════════════════════════════════════════════════════
  CardPool.prototype.showMarks = function (questId, positions) {
    var layer = document.getElementById('scroll-mark-layer');
    if (!layer) return;
    layer.innerHTML = '';

    var container = this._container;  // #messages
    var totalH = container.scrollHeight - 24;  // 总内容高度（减去 padding）
    if (totalH <= 0) return;

    // 当前滚动偏移
    var scrollTop = container.scrollTop;
    // 可视高度
    var viewH = container.clientHeight - 24;

    for (var i = 0; i < positions.length; i++) {
      // 匹配元素在内容中的绝对偏移（相对于 #messages 内容区顶部）
      var absTop = positions[i].offsetTop;
      // 在视口中的相对位置 = (absTop - scrollTop) / totalH，再映射到 mark 层
      // 但 marks 应该标记在内容中的固定位置，不随滚动移动
      // 用绝对位置 / 总高度
      var pct = (absTop / totalH) * 100;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      var mark = document.createElement('div');
      mark.className = 'sml-mark';
      var c = positions[i].active ? '#ffd301' : '#ff6b00';
      mark.style.cssText =
        'top:' + pct + '%; ' +
        'background:' + c + '; ' +
        'color:' + c + ';';
      mark.title = positions[i].label || '';
      mark.style.pointerEvents = 'auto';
      mark.style.cursor = 'default';
      mark.onclick = (function (pos) {
        return function () {
          if (pos._range) {
            var rc = pos._range.startContainer;
            if (rc && rc.nodeType === 3 && rc.parentElement) {
              rc.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          } else if (pos.el) {
            pos.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        };
      })(positions[i]);
      layer.appendChild(mark);
    }
  };

  CardPool.prototype.hideMarks = function (questId) {
    var layer = document.getElementById('scroll-mark-layer');
    if (layer) layer.innerHTML = '';
  };

  // ═══ 保存当前活跃 Card 的 UI 状态 ═══
  CardPool.prototype.saveActiveUIState = function () {
    var card = this.getActive();
    if (!card) return;
    card._userScrolledUp = card._userScrolledUp || false;
    var container = card.dom.parentNode;
    if (container) card._scrollTop = container.scrollTop;
  };

  // ═══ 刷新 Card（从 SQLite 重载数据 + 重建 DOM） ═══
  CardPool.prototype.refreshCard = async function (questId) {
    var card = this._cards[questId];
    if (!card) {
      card = this.getOrCreate(questId);
      await this._loadCardData(card);
      return;
    }
    // 清空现有 DOM（仅清除内容，保留 card 容器和 mark layer）
    if (card._contentWrap) {
      card._contentWrap.innerHTML = '';
    }
    card.floorDOM = {};
    card._floorMetaMap = {};
    card.floors = [];
    card.totalFloors = 0;
    card.buildingFloor = null;
    // 重新加载
    await this._loadCardData(card);
  };

  // ═══ 公开常量读取 ═══
  CardPool.prototype.getCapConstants = function () {
    return {
      capped: FLOOR_CAP_CAPPED,
      building: FLOOR_CAP_BUILDING,
      poolMax: CARD_POOL_MAX
    };
  };

  // ═══ 暴露到全局 ═══
  window.CardPool = CardPool;
  window._buildConversationFlowHtml = _buildConversationFlowHtml;
  window._escHtml = _escHtml;

  // ★ 重启后聚合红框：将所有 .msg-err-individual 合并为一个 .msg-quest-error
  CardPool.prototype._aggregateQuestErrors = function (card) {
    if (!card || !card._contentWrap) return;
    var _all = card._contentWrap.querySelectorAll('.msg-err-individual');
    if (_all.length <= 1) return;  // 0-1 个无需聚合

    // 收集所有错误文本
    var _entries = [];
    for (var i = 0; i < _all.length; i++) {
      var _div = _all[i];
      // 提取纯文本（排除链接）
      var _text = '';
      for (var _c = _div.firstChild; _c; _c = _c.nextSibling) {
        if (_c.nodeType === 3) _text += _c.textContent;  // Text node
        else if (_c.tagName !== 'A') _text += _c.textContent || '';
      }
      _entries.push(_text.trim());
      _div.remove();  // 删除旧的独立红框
    }

    // 创建聚合红框
    var _box = document.createElement('div');
    _box.className = 'msg msg-error msg-quest-error';
    _box.style.whiteSpace = 'pre-wrap';
    for (var _ei = 0; _ei < _entries.length; _ei++) {
      var _row = document.createElement('div');
      _row.className = 'qe-row';
      _row.textContent = _entries[_ei];
      _box.appendChild(_row);
    }
    // 单链接
    var _link = document.createElement('a');
    _link.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
    _link.href = '#';
    _link.className = 'msg-err-continue';
    _link.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
    _link._qqqQuestId = card.id;
    _link._qqqAgent = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    _link.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (this._qqqRecoveryBusy) return;
        this._qqqRecoveryBusy = true;
        if (typeof _startRecovery === 'function') _startRecovery(this._qqqQuestId, this._qqqAgent, this);
    };
    _box.appendChild(_link);

    // 插入到最后（在 card content 末尾）
    card._contentWrap.appendChild(_box);
  };

  // [silent] card-pool ready

  return CardPool;
})();
