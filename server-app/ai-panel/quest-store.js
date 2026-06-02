// ============================================================================
// quest-store.js — 多任务管理（项目级持久化，铁律 §9）
// 无 rootDir → 用全局 qgs（兼容旧数据）
// 有 rootDir → 用项目级 SQLite（qqq/alphal/quest.sq3）
// 存储结构:
//   __nextQuestId    → 全局自增 quest 编号（只增不减）
//   index            → [{ id, numericId, title, createdAt, lastActiveAt }]
//   active           → active quest id (string)
//   quest.{id}       → { ctx, totalCostGe, floorTimings, serverDrift, savedAt, __nextFloorId }  (quest 级共享元数据)
//   floor.{id}.{n}   → { question, conversation, houses, costWge, lastUserInput, createdAt, savedAt }  (每层楼独立)
// ============================================================================

var QuestStore = (function () {

    var NS = 'qqq.ai';
    var INDEX_KEY = 'index';
    var ACTIVE_KEY = 'active';
    var QUEST_NS = 'quest';
    var FLOOR_NS = 'floor';
    var COUNTER_QUEST_KEY = '__nextQuestId';
    var COUNTER_FLOOR_FIELD = '__nextFloorId';

    // 通过 state-sdk 的 qgs 访问唯一真理持久化机器
    // 如果 iframe 内没加载 state-sdk.js，回退到 parent 的 qgs
    var _qgs = null;
    var _rootDir = null;
    var _bridgeCalled = 0;
    var _requireProject = false;  // 要求必须绑定主项目才允许写入

    function _bridge() {
        _bridgeCalled++;
        if (_qgs) return _qgs;

        // 铁律：绑定主项目后才允许任何持久化操作。无 rootDir → 直接拒绝。
        if (!_rootDir) {
            if (_bridgeCalled <= 3) console.log('[quest-store] bridge BLOCKED: no rootDir (project not bound)');
            return null;
        }

        // 项目级 SQLite（唯一路径）—— 数据落 {rootDir}/qqq/alphal/quest.sq3
        if (window && window.parent && window.parent.qgs && typeof window.parent.qgs.project === 'function') {
            _qgs = window.parent.qgs.project(_rootDir + '/qqq/alphal/quest.sq3', NS, { v: 1, form: 'doc' });
            if (_bridgeCalled <= 3) console.log('[quest-store] bridge OK via parent.qgs.project(dbPath=' + _rootDir + '/qqq/alphal/quest.sq3)');
            return _qgs;
        }

        // 回退：本窗口的 qgs.project（独立僚机/无 parent）
        if (typeof window !== 'undefined' && window.qgs && typeof window.qgs.project === 'function') {
            _qgs = window.qgs.project(_rootDir + '/qqq/alphal/quest.sq3', NS, { v: 1, form: 'doc' });
            if (_bridgeCalled <= 3) console.log('[quest-store] bridge OK via self.qgs.project');
            return _qgs;
        }

        if (_bridgeCalled <= 3) console.log('[quest-store] bridge FAIL: no project() API, parent.qgs:', !!(window.parent && window.parent.qgs), 'self.qgs:', !!window.qgs);
        return null;
    }

    async function _get(key) {
        var b = _bridge();
        if (!b) { console.warn('[quest-store] _get(' + key + ') FAIL: no bridge'); return null; }
        try {
            var v = await b.get(key);
            console.log('[quest-store] _get(' + key + ') ->', v !== null && v !== undefined ? 'OK' : 'NULL');
            return v;
        } catch (e) { console.error('[quest-store] _get(' + key + ') ERROR:', e); return null; }
    }

    async function _set(key, value) {
        var b = _bridge();
        if (!b) { console.warn('[quest-store] _set(' + key + ') FAIL: no bridge'); return; }
        try {
            var sizeEst = JSON.stringify(value).length;
            console.log('[quest-store] _set(' + key + ') size=' + sizeEst + 'b');
            await b.set(key, value);
            console.log('[quest-store] _set(' + key + ') OK');
        } catch (e) { console.error('[quest-store] _set(' + key + ') ERROR:', e); }
    }

    async function _setNow(key, value) {
        var b = _bridge();
        if (!b) { console.warn('[quest-store] _setNow(' + key + ') FAIL: no bridge'); return; }
        try {
            await b.setNow(key, value);
        } catch (e) { console.error('[quest-store] _setNow(' + key + ') ERROR:', e); }
    }

    async function _del(key) {
        var b = _bridge();
        if (!b) { console.warn('[quest-store] _del(' + key + ') FAIL: no bridge'); return; }
        try { await b.del(key); } catch (e) { console.error('[quest-store] _del(' + key + ') ERROR:', e); }
    }

    // ═══ Migration from localStorage (one-time) ═══
    async function _migrateIfNeeded() {
        try {
            var existing = await _get(INDEX_KEY);
            if (existing && Array.isArray(existing) && existing.length > 0) return;
        } catch (_) { }

        var oldIndex = null;
        try { oldIndex = JSON.parse(localStorage.getItem('qqq-ai-quests-index') || 'null'); } catch (_) { }
        if (!oldIndex || !Array.isArray(oldIndex) || oldIndex.length === 0) return;

        console.log('[quest-store] migrating ' + oldIndex.length + ' quests from localStorage to qgs...');
        var migrated = 0;
        for (var i = 0; i < oldIndex.length; i++) {
            var entry = oldIndex[i];
            var raw = localStorage.getItem('qqq-ai-quest-' + entry.id);
            if (!raw) continue;
            try {
                var data = JSON.parse(raw);
                await _set(QUEST_NS + '.' + entry.id, data);
                migrated++;
            } catch (_) { }
        }
        await _set(INDEX_KEY, oldIndex);
        var oldActive = localStorage.getItem('qqq-ai-quests-active');
        if (oldActive) await _set(ACTIVE_KEY, oldActive);

        // cleanup localStorage
        for (var j = 0; j < oldIndex.length; j++) {
            localStorage.removeItem('qqq-ai-quest-' + oldIndex[j].id);
        }
        localStorage.removeItem('qqq-ai-quests-index');
        localStorage.removeItem('qqq-ai-quests-active');
        console.log('[quest-store] migrated ' + migrated + ' / ' + oldIndex.length + ' quests');
    }

    function QuestStore() {
        this._index = null; // lazy init
        this._migrated = false;
        this._nextQuestId = null; // lazy init: 自增 quest 编号
        this._onChangeCbs = []; // 跨窗口通知回调
    }

    // ═══ 设置项目根目录 → 切换到项目级 SQLite 持久化 ═══
    QuestStore.prototype.setProjectRoot = function (rootDir) {
        if (rootDir && typeof rootDir === 'string') {
            _rootDir = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
            _qgs = null; // 重置 bridge，下次 _bridge() 会用 qgs.project
            _bridgeCalled = 0;
            // 清缓存：切换后端后必须重新读索引
            this._index = null;
            this._migrated = false;
            this._nextQuestId = null;
            console.log('[quest-store] setProjectRoot: ' + _rootDir);
        }
    };

    QuestStore.prototype.getProjectRoot = function () {
        return _rootDir;
    };

    // ═══ 底层守卫：要求绑定主项目才允许写入 ───
    QuestStore.prototype.requireProjectForWrites = function (req) {
        _requireProject = !!req;
    };

    // ═══ 跨窗口通知 ═══
    QuestStore.prototype.onChange = function (cb) {
        this._onChangeCbs.push(cb);
    };
    function _notify(store, type, questId, extra) {
        if (!store._onChangeCbs.length) return;
        var payload = { type: type, questId: questId };
        if (extra) Object.assign(payload, extra);
        for (var i = 0; i < store._onChangeCbs.length; i++) {
            try { store._onChangeCbs[i](payload); } catch (_) {}
        }
    }

    function _guardWrite(op) {
        if (_requireProject && !_rootDir) {
            console.warn('[quest-store] BLOCKED ' + op + ': no main project bound');
            return true;  // blocked
        }
        return false;
    }

    QuestStore.prototype._ensureIndex = async function () {
        if (!this._migrated) {
            await _migrateIfNeeded();
            this._migrated = true;
        }
        if (this._index === null) {
            var raw = await _get(INDEX_KEY);
            this._index = (raw && Array.isArray(raw)) ? raw : [];
        }
    };

    QuestStore.prototype._saveIndex = async function () {
        await _setNow(INDEX_KEY, this._index);
    };

    // ═══ 自增 ID 计数器 ═══

    // 获取下一个 quest 编号（全局自增，只增不减）
    QuestStore.prototype.getNextQuestId = async function () {
        if (_guardWrite('getNextQuestId')) return 0;
        await this._ensureIndex();
        if (this._nextQuestId === null) {
            // 从持久化存储读取，若不存在则从已有 quest 推导
            var stored = await _get(COUNTER_QUEST_KEY);
            if (typeof stored === 'number' && stored > 0) {
                this._nextQuestId = stored;
            } else {
                // 从已有 quest 中找最大 numericId
                var maxId = 0;
                for (var i = 0; i < this._index.length; i++) {
                    if (this._index[i].numericId && this._index[i].numericId > maxId) {
                        maxId = this._index[i].numericId;
                    }
                }
                this._nextQuestId = maxId + 1;
                // 如果没有任何 quest，从 1 开始
                if (this._index.length === 0) this._nextQuestId = 1;
            }
        }
        var id = this._nextQuestId;
        this._nextQuestId++;
        await _setNow(COUNTER_QUEST_KEY, this._nextQuestId);
        return id;
    };

    // 获取某个 quest 的下一个 floor 编号（per-quest 自增，只增不减）
    QuestStore.prototype.getNextFloorId = async function (questId) {
        if (_guardWrite('getNextFloorId')) return 0;
        var qData = await _get(QUEST_NS + '.' + questId);
        var next = 1;
        if (qData && typeof qData[COUNTER_FLOOR_FIELD] === 'number' && qData[COUNTER_FLOOR_FIELD] > 0) {
            next = qData[COUNTER_FLOOR_FIELD];
        }
        // 如果没有持久化的计数器，从 conversation 推导
        if (next <= 1 && qData && Array.isArray(qData.conversation)) {
            var maxF = 0;
            for (var i = 0; i < qData.conversation.length; i++) {
                if (qData.conversation[i].floorNum && qData.conversation[i].floorNum > maxF) {
                    maxF = qData.conversation[i].floorNum;
                }
            }
            if (maxF > 0) next = maxF + 1;
        }
        // 保存递增后的值（_setNow 立即落盘，防 debounce 回火覆盖后续 save）
        var floorId = next;
        next++;
        try {
            if (!qData) qData = {};
            qData[COUNTER_FLOOR_FIELD] = next;
            await _setNow(QUEST_NS + '.' + questId, qData);
        } catch (e) { console.warn('[quest-store] getNextFloorId save error:', e); }
        return floorId;
    };

    // ═══ Active quest ═══

    QuestStore.prototype.getActiveId = async function () {
        await this._ensureIndex();
        var id = await _get(ACTIVE_KEY);
        return id || '';
    };

    QuestStore.prototype.setActiveId = async function (id) {
        if (_guardWrite('setActiveId')) return;
        await _setNow(ACTIVE_KEY, id);
    };

    // ═══ CRUD ═══

    // create(title) — 用自增 numericId 生成 id='q{n}'，title 可为空（首次消息时补全）
    QuestStore.prototype.create = async function (title) {
        if (_guardWrite('create')) return null;
        var numericId = await this.getNextQuestId();
        if (!numericId) return null;
        var id = 'q' + numericId;
        var entry = {
            id: id,
            numericId: numericId,
            title: title || '',
            createdAt: Date.now(),
            lastActiveAt: Date.now()
        };
        await this._ensureIndex();
        this._index.push(entry);
        await this._saveIndex();
        _notify(this, 'quest-created', id);
        return id;
    };

    QuestStore.prototype.deleteQuest = async function (id) {
        if (_guardWrite('deleteQuest')) return;
        await this._ensureIndex();
        this._index = this._index.filter(function (s) { return s.id !== id; });
        await this._saveIndex();
        await _del(QUEST_NS + '.' + id);
        _notify(this, 'quest-deleted', id);
    };

    QuestStore.prototype.list = async function () {
        await this._ensureIndex();
        return this._index.slice().sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; });
    };

    // rename(id, title) — 设置 quest 标题（首次消息时调用），可附带 numericId
    QuestStore.prototype.rename = async function (id, title, numericId) {
        if (_guardWrite('rename')) return false;
        await this._ensureIndex();
        var entry = this._index.find(function (s) { return s.id === id; });
        if (entry) {
            entry.title = title;
            if (typeof numericId === 'number') entry.numericId = numericId;
            await this._saveIndex();
            _notify(this, 'quest-renamed', id, { title: title });
            return true;
        }
        return false;
    };

    QuestStore.prototype.touch = async function (id) {
        if (_guardWrite('touch')) return;
        await this._ensureIndex();
        var entry = this._index.find(function (s) { return s.id === id; });
        if (entry) {
            entry.lastActiveAt = Date.now();
            await this._saveIndex();
        }
    };

    // ═══ Quest 所有权（防多窗口串味） ═══

    // claimOwner: 尝试声明所有权。若无人持有或已过期(>30s)，成功。否则返回当前持有者。
    QuestStore.prototype.claimOwner = async function (questId, windowId) {
        if (_guardWrite('claimOwner')) return { claimed: false, currentOwner: null };
        var existing = await _get(QUEST_NS + '.' + questId);
        var oldOwner = (existing && existing._owner) || null;
        if (oldOwner && oldOwner.windowId && oldOwner.windowId !== windowId) {
            var age = Date.now() - (oldOwner.claimedAt || 0);
            if (age < 30000) {
                return { claimed: false, currentOwner: oldOwner.windowId };
            }
            // 过期，允许接管
        }
        var ownerData = { windowId: windowId, claimedAt: Date.now() };
        if (!existing) existing = {};
        existing._owner = ownerData;
        await _setNow(QUEST_NS + '.' + questId, existing);
        return { claimed: true, currentOwner: null };
    };

    // releaseOwner: 释放所有权。返回被释放的 owner（如有）。
    QuestStore.prototype.releaseOwner = async function (questId) {
        if (_guardWrite('releaseOwner')) return null;
        var existing = await _get(QUEST_NS + '.' + questId);
        if (!existing || !existing._owner) return null;
        var oldOwner = existing._owner;
        delete existing._owner;
        await _setNow(QUEST_NS + '.' + questId, existing);
        return oldOwner;
    };

    // getOwner: 读取当前所有权（不修改）。返回 { windowId, claimedAt } 或 null。
    QuestStore.prototype.getOwner = async function (questId) {
        var existing = await _get(QUEST_NS + '.' + questId);
        if (!existing || !existing._owner) return null;
        var age = Date.now() - (existing._owner.claimedAt || 0);
        if (age > 30000) return null; // 过期视为无主
        return existing._owner;
    };

    // ═══ Save / Load ═══

    // 保存 quest 级元数据（ctx, cost, timings — 不含 floor 数据）
    QuestStore.prototype.save = async function (id, data) {
        if (_guardWrite('save')) return;
    data.savedAt = Date.now();
    // 保留 __nextFloorId 计数器 + _owner（分别由 getNextFloorId / claimOwner 写入，不可被 save 覆盖）
    var existing = await _get(QUEST_NS + "." + id);
    if (existing) {
      if (typeof data[COUNTER_FLOOR_FIELD] !== "number" && typeof existing[COUNTER_FLOOR_FIELD] === "number") {
        data[COUNTER_FLOOR_FIELD] = existing[COUNTER_FLOOR_FIELD];
      }
      if (existing._owner && !data._owner) {
        data._owner = existing._owner;
      }
        }
        await _setNow(QUEST_NS + '.' + id, data);
        _notify(this, 'quest-saved', id, { floorNum: data.ctx ? data.ctx.totalFloors : undefined });
    };

    QuestStore.prototype.load = async function (id) {
        return await _get(QUEST_NS + '.' + id);
    };

    // ═══ Floor 级存储（每层楼独立持久化）════

    QuestStore.prototype.saveFloor = async function (questId, floorNum, data) {
        if (_guardWrite('saveFloor')) return;
        data.savedAt = Date.now();
        await _setNow(FLOOR_NS + '.' + questId + '.' + floorNum, data);
        _notify(this, 'floor-saved', questId, { floorNum: floorNum });
    };

    QuestStore.prototype.loadFloor = async function (questId, floorNum) {
        return await _get(FLOOR_NS + '.' + questId + '.' + floorNum);
    };

    // 加载某 quest 的全部楼层（按 floorNum 升序）
    QuestStore.prototype.loadAllFloors = async function (questId) {
        var questData = await _get(QUEST_NS + '.' + questId);
        var totalFloors = (questData && questData.ctx && questData.ctx.totalFloors) || 0;
        var floors = [];
        for (var i = 1; i <= totalFloors; i++) {
            var fData = await _get(FLOOR_NS + '.' + questId + '.' + i);
            if (fData) floors.push({ floorNum: i, data: fData });
        }
        return floors;
    };

    return QuestStore;

})();
