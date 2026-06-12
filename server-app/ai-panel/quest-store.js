// ============================================================================
// quest-store.js — 多任务持久化（唯一真理：SQLite）
//
// 铁律：
//   ① SQLite 是唯一真理源，all.txt 是纯导出快照，绝不回读
//   ② quest/floor ID 由 atomicIncr 原子分配，零竞态，绝不回退
//   ③ 楼层数据增量保存 — 每完成一个 House 立即写库
//   ④ 计数器自愈 — 首次启动自动从 index 推导种子值
//
// 存储结构 (ns=qqq.ai / quest.sq3):
//   index              → [{ id, numericId, title, createdAt, lastActiveAt }]
//   active             → 'qN'
//   quest.{id}         → { ctx, totalCostGe, floorTimings, serverDrift, rulesVersion, floors[] }
//   floor.{id}.{n}     → { question, conversation, houses, costWge, lastUserInput, createdAt, savedAt }
//   quest_id_counter   → 原子自增 quest 编号
//   floor_counter.{id} → 原子自增 floor 编号（每 quest 独立）
// ============================================================================

var QuestStore = (function () {
    'use strict';

    var NS = 'qqq.ai';
    var INDEX_KEY = 'index';
    var ACTIVE_KEY = 'active';
    var QUEST_NS = 'quest';
    var FLOOR_NS = 'floor';

    var _qgs = null;
    var _rootDir = null;

    // ═══════════════════════════════════════════════════════════════
    // Bridge — 懒初始化 qgs handle，_rootDir 必须在 setProjectRoot 后可用
    // ═══════════════════════════════════════════════════════════════

    function _bridge() {
        if (_qgs) return _qgs;
        if (!_rootDir) {
            console.warn('[quest-store] bridge BLOCKED: no rootDir');
            return null;
        }
        var dbPath = _rootDir + '/qqq/alphal/quest.sq3';
        // 主窗口 parent.qgs 暴露 project() 工厂
        if (window.parent && window.parent.qgs && typeof window.parent.qgs.project === 'function') {
            _qgs = window.parent.qgs.project(dbPath, NS, { v: 2, form: 'doc' });
        } else if (window.qgs && typeof window.qgs.project === 'function') {
            _qgs = window.qgs.project(dbPath, NS, { v: 2, form: 'doc' });
        }
        if (_qgs) {
            // [silent] bridge OK
        } else {
            console.warn('[quest-store] bridge FAIL: no qgs.project API');
        }
        return _qgs;
    }

    // ═══════════════════════════════════════════════════════════════
    // 底层原子读写 — 所有操作经过这里
    // ═══════════════════════════════════════════════════════════════

    async function _get(key) {
        var b = _bridge();
        if (!b) return null;
        try {
            var v = await b.get(key);
            return v;
        } catch (e) {
            console.error('[quest-store] _get(' + key + ') ERROR:', e && e.message);
            return null;
        }
    }

    async function _setNow(key, value) {
        var b = _bridge();
        if (!b) return;
        try {
            await b.setNow(key, value);
        } catch (e) {
            console.error('[quest-store] _setNow(' + key + ') ERROR:', e && e.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 构造函数
    // ═══════════════════════════════════════════════════════════════

    function QuestStore() {
        this._index = null;
        this._onChangeCbs = [];
    }

    QuestStore.prototype.setProjectRoot = function (rootDir) {
        if (rootDir && typeof rootDir === 'string') {
            _rootDir = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
            _qgs = null;
            this._index = null;
            // [silent] setProjectRoot
        } else if (rootDir === null) {
            // ★ workspace 拆卸时清空
            _rootDir = null;
            _qgs = null;
            this._index = null;
        }
    };

    QuestStore.prototype.getProjectRoot = function () {
        return _rootDir;
    };

    // 项目守卫：设置后，无 _rootDir 时所有写入操作在 _bridge() 层自动阻断
    // 返回 true 表示有项目绑定，false 表示无（上层可据此拒绝操作）
    QuestStore.prototype.requireProjectForWrites = function (val) {
        // 标记已调用；实际守卫在 _bridge() → null 阻断
        if (val) {
            // [silent] requireProjectForWrites
        }
    };

    QuestStore.prototype.hasProjectRoot = function () {
        return !!_rootDir;
    };

    // ═══════════════════════════════════════════════════════════════
    // 跨窗口通知
    // ═══════════════════════════════════════════════════════════════

    QuestStore.prototype.onChange = function (cb) {
        this._onChangeCbs.push(cb);
    };

    // ★ workspace 切换时清空所有回调
    QuestStore.prototype.clearOnChange = function () {
        this._onChangeCbs = [];
    };

    function _notify(store, type, questId, extra) {
        if (!store._onChangeCbs.length) return;
        var payload = { type: type, questId: questId };
        if (extra) Object.assign(payload, extra);
        for (var i = 0; i < store._onChangeCbs.length; i++) {
            try { store._onChangeCbs[i](payload); } catch (_) { }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Index — quest 列表（唯一入口，懒加载 + 自愈）
    // ═══════════════════════════════════════════════════════════════

    QuestStore.prototype._ensureIndex = async function () {
        if (this._index !== null) return;
        var raw = await _get(INDEX_KEY);
        this._index = (raw && Array.isArray(raw)) ? raw : [];
        await this._healIndex();
    };

    // ★ 计数器自愈：若 quest_id_counter 未初始化，从 index 推最大 ID 种子
    QuestStore.prototype._healIndex = async function () {
        var b = _bridge();
        if (!b) return;
        try {
            var cur = await b.get('quest_id_counter');
            if (!cur || !(typeof cur === 'number' && cur > 0)) {
                var maxN = 0;
                for (var i = 0; i < this._index.length; i++) {
                    var n = this._index[i].numericId || 0;
                    if (n > maxN) maxN = n;
                }
                if (maxN > 0) {
                    await b.setNow('quest_id_counter', maxN);
                    // [silent] seeded quest_id_counter
                }
            }
        } catch (e) {
            console.warn('[quest-store] _healIndex seed failed:', e && e.message);
        }
    };

    QuestStore.prototype._saveIndex = async function () {
        await _setNow(INDEX_KEY, this._index);
    };

    // ═══════════════════════════════════════════════════════════════
    // Quest CRUD
    // ═══════════════════════════════════════════════════════════════

    // create(title) → id='qN'，N 由 SQLite atomicIncr 原子分配，零竞态
    QuestStore.prototype.create = async function (title) {
        await this._ensureIndex();
        var b = _bridge();
        if (!b) throw new Error('quest-store: no bridge');
        var numericId = await b.atomicIncr('quest_id_counter');
        var id = 'q' + numericId;
        var now = Date.now();
        var entry = {
            id: id,
            numericId: numericId,
            title: title || '',
            createdAt: now,
            lastActiveAt: now
        };
        this._index.push(entry);
        await this._saveIndex();

        // 初始化 quest 元数据（含空的 floors 数组）
        await _setNow(QUEST_NS + '.' + id, {
            ctx: { narrative: '', facts: [], treasures: [], totalFloors: 0 },
            totalCostGe: 0,
            floorTimings: [],
            serverDrift: 0,
            rulesVersion: '',
            floors: [],
            createdAt: now,
            savedAt: now
        });

        _notify(this, 'quest-created', id);
        return id;
    };

    QuestStore.prototype.rename = async function (id, title, numericId) {
        await this._ensureIndex();
        var entry = null;
        for (var i = 0; i < this._index.length; i++) {
            if (this._index[i].id === id) { entry = this._index[i]; break; }
        }
        if (entry) {
            entry.title = title;
            if (typeof numericId === 'number') entry.numericId = numericId;
            await this._saveIndex();
            _notify(this, 'quest-renamed', id, { title: title });
            return true;
        }
        return false;
    };

    QuestStore.prototype.deleteQuest = async function (id) {
        await this._ensureIndex();
        this._index = this._index.filter(function (s) { return s.id !== id; });
        await this._saveIndex();
        // 删除 quest 元数据和所有 floor 数据
        var b = _bridge();
        if (b && b.del) {
            var qData = await _get(QUEST_NS + '.' + id);
            var floors = (qData && qData.floors) || [];
            for (var fi = 0; fi < floors.length; fi++) {
                await b.del(FLOOR_NS + '.' + id + '.' + floors[fi].n);
            }
            await b.del(QUEST_NS + '.' + id);
        }
        _notify(this, 'quest-deleted', id);
    };

    QuestStore.prototype.touch = async function (id) {
        await this._ensureIndex();
        for (var i = 0; i < this._index.length; i++) {
            if (this._index[i].id === id) {
                this._index[i].lastActiveAt = Date.now();
                await this._saveIndex();
                return;
            }
        }
    };

    QuestStore.prototype.list = async function () {
        await this._ensureIndex();
        return this._index.slice().sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; });
    };

    // ═══════════════════════════════════════════════════════════════
    // Active quest
    // ═══════════════════════════════════════════════════════════════

    QuestStore.prototype.getActiveId = async function () {
        await this._ensureIndex();
        return await _get(ACTIVE_KEY) || '';
    };

    QuestStore.prototype.setActiveId = async function (id) {
        await _setNow(ACTIVE_KEY, id);
    };

    // ═══════════════════════════════════════════════════════════════
    // Quest 所有权 — 已移除 quest.sq3 中的 _owner 冗余层
    // 唯一真理源：父窗口 __qqq_questOwners（questId → panelId 同步映射）
    // 面板→任务 映射：onlyStore `ai.window.{wid}.activeQuestId`
    // ═══════════════════════════════════════════════════════════════

    // ★ 清理遗留 _owner 数据（一次性迁移，幂等安全）
    QuestStore.prototype.cleanupOwners = async function () {
        await this._ensureIndex();
        for (var i = 0; i < this._index.length; i++) {
            var id = this._index[i].id;
            var data = await _get(QUEST_NS + '.' + id);
            if (data && data._owner) {
                delete data._owner;
                await _setNow(QUEST_NS + '.' + id, data);
            }
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // Quest 元数据 — save/load（不含 floor 数据）
    // ═══════════════════════════════════════════════════════════════

    QuestStore.prototype.save = async function (id, data) {
        data.savedAt = Date.now();
        // floors 列表 + totalFloors 由 saveFloor 管理，save 不覆盖（取最大值）
        var existing = await _get(QUEST_NS + '.' + id);
        if (!existing) existing = {};
        if (existing.floors && !data.floors) {
            data.floors = existing.floors;
        }
        if (data.ctx && existing.ctx && typeof existing.ctx.totalFloors === 'number') {
            data.ctx.totalFloors = Math.max(data.ctx.totalFloors || 0, existing.ctx.totalFloors);
        }
        await _setNow(QUEST_NS + '.' + id, data);
        _notify(this, 'quest-saved', id, { floorNum: data.ctx ? data.ctx.totalFloors : undefined });
    };

    QuestStore.prototype.load = async function (id) {
        return await _get(QUEST_NS + '.' + id);
    };

    // ═══════════════════════════════════════════════════════════════
    // Floor 存储 — 原子操作：写 floor 数据 + 更新 quest.floors[]
    // ═══════════════════════════════════════════════════════════════

    // 分配下一个 floor 号（原子自增，每 quest 独立计数器）
    QuestStore.prototype.nextFloorNum = async function (questId) {
        var b = _bridge();
        if (!b) throw new Error('quest-store: no bridge');
        return await b.atomicIncr('floor_counter.' + questId);
    };

    // 保存楼层（完整写入，幂等覆盖）
    QuestStore.prototype.saveFloor = async function (questId, floorNum, floorData) {
        floorData.savedAt = Date.now();
        var floorKey = FLOOR_NS + '.' + questId + '.' + floorNum;

        // 1) 写 floor 数据
        await _setNow(floorKey, floorData);

        // 2) 更新 quest.floors[] 列表
        var qData = await _get(QUEST_NS + '.' + questId) || {};
        var floors = qData.floors || [];
        var found = false;
        for (var i = 0; i < floors.length; i++) {
            if (floors[i].n === floorNum) {
                floors[i].savedAt = floorData.savedAt;
                found = true;
                break;
            }
        }
        if (!found) {
            floors.push({ n: floorNum, savedAt: floorData.savedAt });
            floors.sort(function (a, b) { return a.n - b.n; });
        }
        qData.floors = floors;
        if (!qData.ctx) qData.ctx = { narrative: '', facts: [], treasures: [], totalFloors: 0 };
        qData.ctx.totalFloors = Math.max(qData.ctx.totalFloors || 0, floors.length);
        qData.savedAt = Date.now();
        await _setNow(QUEST_NS + '.' + questId, qData);

        _notify(this, 'floor-saved', questId, { floorNum: floorNum });
    };

    // 加载单层楼
    QuestStore.prototype.loadFloor = async function (questId, floorNum) {
        return await _get(FLOOR_NS + '.' + questId + '.' + floorNum);
    };

    // 加载全部楼层（从 quest.floors[] 推导，不依赖 totalFloors）
    QuestStore.prototype.loadAllFloors = async function (questId) {
        var qData = await _get(QUEST_NS + '.' + questId);
        var floorList = (qData && qData.floors) || [];
        var floors = [];
        for (var i = 0; i < floorList.length; i++) {
            var fData = await _get(FLOOR_NS + '.' + questId + '.' + floorList[i].n);
            if (fData) {
                floors.push({ floorNum: floorList[i].n, data: fData });
            } else {
                console.warn('[quest-store] loadAllFloors: floor.' + questId + '.' + floorList[i].n + ' listed but missing');
            }
        }
        return floors;
    };

    return QuestStore;

})();
