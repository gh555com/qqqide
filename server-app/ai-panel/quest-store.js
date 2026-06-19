// ============================================================================
// quest-store.js — 多任务持久化
//
// 真理层级：
//   ① all.json（楼层目录文件）— 唯一真理源，包含 conversation/houses 全量
//      写路径: qqq/quests/q{n}.*/f{n}.*/all.json   via  bridge.fs.write（底层 _atomicWrite）
//      路径由 ID 前缀解析（startsWith），标题任意改不影响读写
//      文件名恒定 all.json，楼层编号仅在目录名中 → 目录改名时无需同步改文件
//   ② quest.sq3（SQLite）— 轻量索引 + quest 元数据，不存 conversation
//      写路径: qgs.project(dbPath, 'qqq.ai', {v:2, form:'doc'})
//
// 铁律：
//   ① all.json 是唯一真理源，quest.sq3 只存轻量索引 (~200 bytes/floor)
//   ② quest/floor ID 由 atomicIncr 原子分配，零竞态，绝不回退
//   ③ 楼层数据增量保存 — 每完成一个 House 立即写 all.json + sq3 索引
//   ④ 计数器自愈 — setup 时从 all.json 文件重建索引
//   ⑤ quest 目录名含标题（q{n}.{title}），方便人类阅读；改名不影响数据
//   ⑥ 双向对账 — 启动时磁盘 ↔ sq3 索引同步（发现新目录 + 清除幽灵条目）
//   ⑦ 彻底删除 — deleteQuest 同时清理 sq3 条目 + 文件系统目录
//   ⑧ 路径缓存预热 — rebuildIndexFromFiles / _syncIndexFromFs 扫描时填充缓存
//   ⑨ 元数据自愈 — sq3 缺失时从 all.json 重建 totalCostGe / floorTimings / ctx
//   ⑩ 重复编号修复 — repairDuplicateIds() 扫描并重命名同编号 quest/floor 目录
//      楼层改名时 all.json 无需同步改名，零重命名失败风险
//
// 存储结构:
//   Filesystem (真理源):
//     qqq/quests/q{n}.{title}/f{n}.{question}/
//       all.json            ← 楼层全量（conversation + houses）★ 文件名恒定
//       img_*.png           ← 图片
//       all.txt             ← 纯导出快照，绝不回读
//
//   quest.sq3 (轻量索引):
//     index              → [{ id, numericId, title, createdAt, lastActiveAt }]
//     active             → 'qN'
//     quest.{id}         → { ctx, totalCostGe, floorTimings, serverDrift, rulesVersion, floors[] }
//     floor.{id}.{n}     → { _fDir, question, costWge, createdAt, savedAt }
//     quest_id_counter   → 原子自增 quest 编号
//     floor_counter.{id} → 原子自增 floor 编号（每 quest 独立）
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
            _questDirCache = {};
            _floorDirCache = {};
            // [silent] setProjectRoot
        } else if (rootDir === null) {
            // ★ workspace 拆卸时清空
            _rootDir = null;
            _qgs = null;
            this._index = null;
            _questDirCache = {};
            _floorDirCache = {};
        }
    };

    QuestStore.prototype.getProjectRoot = function () {
        return _rootDir;
    };

    // ★ 外部失效索引（跨面板同步后强制重载，等 in-flight load 完成再重置）
    //   返回 Promise：确保调用方 await 后 this._index 确已被 null
    QuestStore.prototype.invalidateIndex = function () {
        this._index = null;
        if (_indexLoadPromise) {
            var self = this;
            return _indexLoadPromise.then(function () { self._index = null; });
        }
        return Promise.resolve();
    };
    // 返回 true 表示有项目绑定，false 表示无（上层可据此拒绝操作）
    // 项目守卫：设置后，无 _rootDir 时所有写入操作在 _bridge() 层自动阻断
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

    // ★ 并发锁：三面板同时启动时只做一次 fs.list，后续面板等同一 Promise
    var _indexLoadPromise = null;
    // ★ 主面板判定（?panel=1 或无参数=中面板），仅中面板执行磁盘扫描
    var _isMainPanel = (function () {
        try {
            var m = location.search.match(/panel=(\d)/);
            return !m || parseInt(m[1], 10) === 1;
        } catch (_) { return true; }
    })();

    QuestStore.prototype._ensureIndex = async function () {
        if (this._index !== null) return;
        if (_indexLoadPromise) return _indexLoadPromise;
        _indexLoadPromise = (async () => {
            try {
                var raw = await _get(INDEX_KEY);
                this._index = (raw && Array.isArray(raw)) ? raw : [];
                await this._healIndex();
                // ★ 仅中面板执行磁盘↔索引对账，侧面板只读索引免竞态
                if (_isMainPanel) {
                    await this._syncIndexFromFs();
                }
            } catch (e) {
                console.warn('[quest-store] _ensureIndex failed:', e && e.message);
                if (!this._index) this._index = [];
            } finally {
                _indexLoadPromise = null;
            }
        })();
        return _indexLoadPromise;
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

    // ★ 双向对账：磁盘 ↔ sq3 索引
    //   ① 磁盘有、索引无 → 自动发现（备份还原 / 手动复制 quest 目录）
    //   ② 索引有、磁盘无 → 自动清除（手动删文件夹）
    //   ③ 同编号多目录 → 警告 + 仅保留一条（其余需手动 repairDuplicateIds）
    var _syncLock = null;  // ★ 防并发（rescan 与 _ensureIndex 不可同时跑）
    QuestStore.prototype._syncIndexFromFs = async function () {
        if (_syncLock) return _syncLock;
        _syncLock = (async () => {
            try {
                var bf = _bridgeFs();
                if (!bf || !_rootDir) return;

                // 扫描磁盘 → diskList（按 ID 分组，检测重复）
                var diskById = {};   // qId → [{ name, title, numericId }]
                try {
                    var list = await _safeList(_rootDir + '/qqq/quests');
                    for (var i = 0; i < list.length; i++) {
                        if (!list[i].isDir) continue;
                        var m = list[i].name.match(/^q(\d+)\.(.+)$/);
                        if (m) {
                            var did = 'q' + m[1];
                            if (!diskById[did]) diskById[did] = [];
                            diskById[did].push({ name: list[i].name, title: m[2], numericId: parseInt(m[1], 10) });
                        }
                    }
                } catch (_) { return; }

                // 检测同编号多目录
                var dupIds = [];
                var diskIds = Object.keys(diskById);
                for (var di = 0; di < diskIds.length; di++) {
                    if (diskById[diskIds[di]].length > 1) {
                        dupIds.push(diskIds[di]);
                    }
                }
                if (dupIds.length) {
                    console.error('[quest-store] ⚠️ DUPLICATE QUEST IDS DETECTED: ' + dupIds.join(', ') + ' — call repairDuplicateIds() to fix');
                    for (var zi = 0; zi < dupIds.length; zi++) {
                        var zid = dupIds[zi];
                        var names = diskById[zid].map(function (d) { return d.name; });
                        console.error('[quest-store]   ' + zid + ' → ' + names.join(' | '));
                    }
                }

                // 索引 → idxMap（id → entry）
                var idxMap = {};
                for (var j = 0; j < this._index.length; j++) {
                    idxMap[this._index[j].id] = this._index[j];
                }

                // ① 减法：索引有、磁盘无 → 踢出
                var stale = [];
                for (var k = this._index.length - 1; k >= 0; k--) {
                    if (!diskById[this._index[k].id]) {
                        stale.push(this._index[k].id);
                        this._index.splice(k, 1);
                    }
                }

                // ② 加法：磁盘有、索引无 → 发现（取第一个，重复的不重复加）
                var added = [];
                for (var ai = 0; ai < diskIds.length; ai++) {
                    var aid = diskIds[ai];
                    if (!idxMap[aid]) {
                        var d = diskById[aid][0];  // 取第一个
                        this._index.push({
                            id: aid,
                            numericId: d.numericId,
                            title: d.title,
                            dirName: d.name,         // ★ 存完整目录名
                            createdAt: Date.now(),
                            lastActiveAt: Date.now()
                        });
                        added.push(aid);
                        // ★ 预热缓存（仅第一个，重复的需 repairDuplicateIds 修复）
                        _questDirCache[aid] = d.name;
                    }
                }

                // ★ 更新已有条目的 dirName + 同步缓存（防同编号多目录 prefix scan 误匹配）
                for (var ui = 0; ui < this._index.length; ui++) {
                    var ue = this._index[ui];
                    if (ue.id && diskById[ue.id] && diskById[ue.id].length >= 1) {
                        if (!ue.dirName) ue.dirName = diskById[ue.id][0].name;
                        // ★ 缓存必须与索引一致（否则 _resolveQuestDirName prefix scan 可能返回错误目录）
                        if (!_questDirCache[ue.id] && ue.dirName) _questDirCache[ue.id] = ue.dirName;
                    }
                }

                if (!stale.length && !added.length) return;

                // 清理 sq3 中已删除 quest 的数据
                var b = _bridge();
                for (var si = 0; si < stale.length; si++) {
                    var sid = stale[si];
                    try {
                        var qData = await _get(QUEST_NS + '.' + sid);
                        var floors = (qData && qData.floors) || [];
                        for (var fi = 0; fi < floors.length; fi++) {
                            await b.del(FLOOR_NS + '.' + sid + '.' + floors[fi].n);
                        }
                        await b.del(QUEST_NS + '.' + sid);
                    } catch (_) { }
                }
                // ★ 种子计数器
                if (added.length && b) {
                    var maxAdded = 0;
                    for (var abi = 0; abi < added.length; abi++) {
                        var n = diskById[added[abi]][0].numericId;
                        if (n > maxAdded) maxAdded = n;
                    }
                    if (maxAdded > 0) {
                        try {
                            var cur = await b.get('quest_id_counter');
                            if (!cur || cur < maxAdded) await b.setNow('quest_id_counter', maxAdded);
                        } catch (_) { }
                    }
                }
                await this._saveIndex();
                if (added.length) console.log('[quest-store] _syncIndexFromFs: discovered ' + added.length + ' new quest(s) from filesystem');
                if (stale.length) console.log('[quest-store] _syncIndexFromFs: removed ' + stale.length + ' stale quest(s) from index');
            } finally {
                _syncLock = null;
            }
        })();
        return _syncLock;
    };

    // ★ 手动触发双向对账（备份还原 / 手动复制目录后调用）
    QuestStore.prototype.rescan = async function () {
        await this._ensureIndex();
        // ★ 仅中面板执行磁盘重扫
        if (_isMainPanel) {
            await this._syncIndexFromFs();
        }
    };

    // ★ 修复同编号重复 quest：扫描磁盘，将多余目录重命名到新 ID
    //   例：q8.你好 / q8.系统 → 保留 index 中已有条目对应的目录，其余分配 q120, q121...
    var _repairLock = null;
    QuestStore.prototype.repairDuplicateIds = async function () {
        if (_repairLock) { console.warn('[quest-store] repairDuplicateIds: already running'); return _repairLock; }
        _repairLock = (async () => {
            try {
                if (!_rootDir) { console.warn('[quest-store] repairDuplicateIds: no project root'); return; }
                var bf = _bridgeFs();
                if (!bf) { console.warn('[quest-store] repairDuplicateIds: no bridgeFs'); return; }
                var b = _bridge();
                if (!b) { console.warn('[quest-store] repairDuplicateIds: no bridge'); return; }

                // 扫描磁盘，按 ID 分组
                var diskById = {};
                try {
                    var list = await _safeList(_rootDir + '/qqq/quests');
                    for (var i = 0; i < list.length; i++) {
                        if (!list[i].isDir) continue;
                        var m = list[i].name.match(/^q(\d+)\.(.+)$/);
                        if (m) {
                            var did = 'q' + m[1];
                            if (!diskById[did]) diskById[did] = [];
                            diskById[did].push({ name: list[i].name, title: m[2], numericId: parseInt(m[1], 10) });
                        }
                    }
                } catch (_) { console.warn('[quest-store] repairDuplicateIds: list failed'); return; }

                var fixed = 0, failed = 0;
                var diskIds = Object.keys(diskById);
                var curCounter = 0;
                try { curCounter = await b.get('quest_id_counter') || 0; } catch (_) { }

                for (var di = 0; di < diskIds.length; di++) {
                    var did = diskIds[di];
                    var entries = diskById[did];
                    if (entries.length <= 1) continue;

                    console.warn('[quest-store] repairDuplicateIds: fixing ' + did + ' (' + entries.length + ' duplicates)');

                    // 查找 index 中已有该 ID 的条目 → 保留其 dirName
                    var keepName = null;
                    for (var ei = 0; ei < this._index.length; ei++) {
                        if (this._index[ei].id === did && this._index[ei].dirName) {
                            keepName = this._index[ei].dirName;
                            break;
                        }
                    }
                    // 若 index 无 dirName，保留磁盘上第一个
                    if (!keepName) keepName = entries[0].name;

                    for (var zi = 0; zi < entries.length; zi++) {
                        if (entries[zi].name === keepName) continue;  // 跳过保留的

                        // 分配新 ID
                        curCounter++;
                        var newId = 'q' + curCounter;
                        var oldName = entries[zi].name;
                        var newName = newId + '.' + entries[zi].title;
                        var oldPath = _rootDir + '/qqq/quests/' + oldName;
                        var newPath = _rootDir + '/qqq/quests/' + newName;

                        try {
                            await bf.rename(oldPath, newPath);
                            // 添加到 index
                            this._index.push({
                                id: newId,
                                numericId: curCounter,
                                title: entries[zi].title,
                                dirName: newName,
                                createdAt: Date.now(),
                                lastActiveAt: Date.now()
                            });
                            // 更新缓存
                            _invalidatePathCache(did);
                            _questDirCache[newId] = newName;
                            fixed++;
                            console.log('[quest-store] repairDuplicateIds: renamed ' + oldName + ' → ' + newName);
                        } catch (e) {
                            failed++;
                            console.error('[quest-store] repairDuplicateIds: FAIL rename ' + oldName + ' → ' + newName + ': ' + (e && e.message));
                        }
                    }
                }

                // 更新计数器
                if (curCounter > 0) {
                    try { await b.setNow('quest_id_counter', curCounter); } catch (_) { }
                }
                await this._saveIndex();
                console.log('[quest-store] repairDuplicateIds: fixed=' + fixed + ' failed=' + failed);

                // ★ 同时修复楼层重复（同一 quest 内多个 f{n}.* 目录）
                var floorFixed = 0, floorFailed = 0;
                var questsWithFloorFix = {};  // ★ 追踪哪些 quest 改了楼层（后续清 sq3 强制重建）
                // 重新扫描（quest 目录可能已改名）
                var allDiskDirs = {};
                try {
                    var list2 = await _safeList(_rootDir + '/qqq/quests');
                    for (var li = 0; li < list2.length; li++) {
                        if (list2[li].isDir) {
                            var m2 = list2[li].name.match(/^q(\d+)\./);
                            if (m2) allDiskDirs['q' + m2[1]] = list2[li].name;
                        }
                    }
                } catch (_) { }

                for (var flQi = 0; flQi < this._index.length; flQi++) {
                    var flQe = this._index[flQi];
                    var flDirName = flQe.dirName || allDiskDirs[flQe.id];
                    if (!flDirName) continue;

                    var flQDirPath = _rootDir + '/qqq/quests/' + flDirName;
                    var floorByName = {};
                    try {
                        var flList = await bf.list(flQDirPath);
                        for (var fli = 0; fli < flList.length; fli++) {
                            if (flList[fli].isDir) {
                                var flm = flList[fli].name.match(/^f(\d+)\.(.+)$/);
                                if (flm) {
                                    var flNum = parseInt(flm[1], 10);
                                    if (!floorByName[flNum]) floorByName[flNum] = [];
                                    floorByName[flNum].push(flList[fli].name);
                                }
                            }
                        }
                    } catch (_) { continue; }

                    var flNums = Object.keys(floorByName);
                    for (var flni = 0; flni < flNums.length; flni++) {
                        var fn = parseInt(flNums[flni]);
                        var fEntries = floorByName[fn];
                        if (fEntries.length <= 1) continue;

                        console.warn('[quest-store] repairDuplicateIds: floor dup in ' + flQe.id + ' f' + fn + ' (' + fEntries.length + ' duplicates)');
                        // 保留第一个，其余重命名到更高编号
                        var keepF = fEntries[0];
                        // 找到该 quest 的最大 floor 编号
                        var maxFn = fn;
                        for (var mki = 0; mki < flNums.length; mki++) {
                            var mk = parseInt(flNums[mki]);
                            if (mk > maxFn) maxFn = mk;
                        }
                        for (var fzi = 1; fzi < fEntries.length; fzi++) {
                            maxFn++;
                            var oldFName = fEntries[fzi];
                            // 提取原标题（f{n}.{title}）
                            var oldFTitle = oldFName.replace(/^f\d+\./, '');
                            var newFName = 'f' + maxFn + '.' + oldFTitle;
                            var oldFPath = flQDirPath + '/' + oldFName;
                            var newFPath = flQDirPath + '/' + newFName;
                            try {
                                await bf.rename(oldFPath, newFPath);
                                // all.json 文件名恒定，目录改名即可，无需额外操作
                                // 清除该 quest 的楼层缓存
                                _invalidatePathCache(flQe.id);
                                floorFixed++;
                                questsWithFloorFix[flQe.id] = true;  // ★ 标记需清 sq3
                                console.log('[quest-store] repairDuplicateIds: floor renamed ' + oldFName + ' → ' + newFName + ' (quest=' + flQe.id + ')');
                            } catch (e) {
                                floorFailed++;
                                console.error('[quest-store] repairDuplicateIds: FAIL floor rename ' + oldFName + ': ' + (e && e.message));
                            }
                        }
                    }
                }

                if (floorFixed > 0) console.log('[quest-store] repairDuplicateIds: floorFixed=' + floorFixed + ' floorFailed=' + floorFailed);

                // ★ 清空楼层修过的 quest 的 sq3 数据（旧 floor 编号已失效 → 下次 loadAllFloors 自动重建）
                var sq3Cleaned = 0;
                var b2 = _bridge();
                var qfKeys = Object.keys(questsWithFloorFix);
                for (var qfi = 0; qfi < qfKeys.length; qfi++) {
                    var qid = qfKeys[qfi];
                    try {
                        var oldFloors = await _get(QUEST_NS + '.' + qid);
                        if (oldFloors && oldFloors.floors) {
                            for (var ofi = 0; ofi < oldFloors.floors.length; ofi++) {
                                await b2.del(FLOOR_NS + '.' + qid + '.' + oldFloors.floors[ofi].n);
                            }
                        }
                        await b2.del(QUEST_NS + '.' + qid);
                        sq3Cleaned++;
                    } catch (_) { }
                }
                if (sq3Cleaned > 0) console.log('[quest-store] repairDuplicateIds: sq3Cleaned=' + sq3Cleaned + ' quests (will rebuild from filesystem)');

                return { fixed: fixed, failed: failed, floorFixed: floorFixed, floorFailed: floorFailed };
            } finally {
                _repairLock = null;
            }
        })();
        return _repairLock;
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
            dirName: '',  // ★ 首次 writeFloorFile 时填充
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
            // ★ 标题变了 → 目录名变了 → 失效路径缓存，下次走 list 重新解析
            _invalidatePathCache(id);
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
        var floors = [];
        if (b && b.del) {
            var qData = await _get(QUEST_NS + '.' + id);
            floors = (qData && qData.floors) || [];
            for (var fi = 0; fi < floors.length; fi++) {
                await b.del(FLOOR_NS + '.' + id + '.' + floors[fi].n);
            }
            await b.del(QUEST_NS + '.' + id);
        }
        // ★ 删除文件系统目录（彻底清理硬盘空间）
        if (_rootDir) {
            var qDirName = await _resolveQuestDirName(id);
            if (qDirName) {
                var bf = _bridgeFs();
                if (bf) {
                    try {
                        var qDirPath = _rootDir + '/qqq/quests/' + qDirName;
                        await bf.remove(qDirPath);
                    } catch (_) { /* remove 可能不支持递归，忽略 */ }
                }
            }
        }
        _invalidatePathCache(id);
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
        return (this._index || []).slice().sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; });
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
    // Quest 所有权 — 唯一真理源：父窗口 __qqq_questOwners
    // ═══════════════════════════════════════════════════════════════

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
    // Floor 存储 — 真理源: all.json (ID 前缀解析); 索引: sq3 轻量
    // _fDir 存 sq3 仅作兜底缓存，主路径由 _resolveFloorDir 动态解析
    // ═══════════════════════════════════════════════════════════════

    // ★ 获取 bridge.fs handle（用于 all.json 读写）
    function _bridgeFs() {
        return (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.fs) || null;
    }

    // ★ 模块级 fs.list 互斥锁：Windows 上 readdir 底层仍是 FindFirstFile，并发会冲突
    var _fsListLock = null;
    async function _safeList(dirPath) {
        while (_fsListLock) { await _fsListLock; }
        _fsListLock = (async () => {
            try {
                var bf = _bridgeFs();
                if (!bf) return [];
                return await bf.list(dirPath);
            } finally {
                _fsListLock = null;
            }
        })();
        return _fsListLock;
    }

    // ═══════════════════════════════════════════════════════════
    // ID 前缀路径解析 — q{n}. / f{n}. 模糊匹配，标题随意改
    // ═══════════════════════════════════════════════════════════

    var _questDirCache = {};   // questId → 目录名 (e.g. "q1.标题")
    var _floorDirCache = {};   // questId+'\x00'+floorNum → 完整路径 (e.g. "qqq/quests/q1.新标题/f3.新问题/")

    function _invalidatePathCache(questId) {
        delete _questDirCache[questId];
        var prefix = questId + '\x00';
        Object.keys(_floorDirCache).forEach(function (k) {
            if (k.indexOf(prefix) === 0) delete _floorDirCache[k];
        });
    }

    // 解析 quest 目录名: 优先精确 dirName → 兜底 prefix scan
    //   dirName 来自索引条目（_syncIndexFromFs/saveFloor 存入），防止同编号多目录误匹配
    async function _resolveQuestDirName(questId, _dirName) {
        // ★ 优先精确匹配：索引条目有 dirName 时，缓存优先（由 _syncIndexFromFs 喂入）
        if (_dirName) {
            if (_questDirCache[questId] && _questDirCache[questId] === _dirName) return _dirName;
            // 新 dirName → 直接信任（索引条目已验证过文件系统）
            _questDirCache[questId] = _dirName;
            return _dirName;
        }

        if (_questDirCache[questId]) return _questDirCache[questId];
        if (!_rootDir) return null;
        var bf = _bridgeFs();
        if (!bf) return null;
        try {
            var list = await _safeList(_rootDir + '/qqq/quests');
            for (var i = 0; i < list.length; i++) {
                if (list[i].isDir && list[i].name.indexOf(questId + '.') === 0) {
                    _questDirCache[questId] = list[i].name;
                    return list[i].name;
                }
            }
        } catch (_) { }
        return null;
    }

    // 解析 floor 目录完整路径: list("q{n}.*/") → startsWith("f{n}.")
    async function _resolveFloorDir(questId, floorNum) {
        var cacheKey = questId + '\x00' + floorNum;
        if (_floorDirCache[cacheKey]) return _floorDirCache[cacheKey];
        var qDirName = await _resolveQuestDirName(questId);
        if (!qDirName) return null;
        var bf = _bridgeFs();
        if (!bf) return null;
        try {
            var qDirPath = _rootDir + '/qqq/quests/' + qDirName;
            var list = await bf.list(qDirPath);
            for (var i = 0; i < list.length; i++) {
                if (list[i].isDir && list[i].name.indexOf('f' + floorNum + '.') === 0) {
                    var fDir = qDirPath + '/' + list[i].name + '/';
                    _floorDirCache[cacheKey] = fDir;
                    return fDir;
                }
            }
        } catch (_) { }
        return null;
    }

    // ★ 读取 all.json（真理源）
    async function _readFloorFile(questId, floorNum) {
        if (!_rootDir) return null;
        try {
            var bf = _bridgeFs();
            if (!bf) return null;
            var fDir = await _resolveFloorDir(questId, floorNum);
            if (!fDir) return null;
            var raw = await bf.read(fDir + 'all.json');
            if (raw && typeof raw === 'string') {
                return JSON.parse(raw);
            }
            return null;
        } catch (_e) {
            return null;
        }
    }

    // ★ 写入 all.json（真理源）— bridge.fs.write 内部 _atomicWrite
    async function _writeFloorFile(questId, floorNum, floorData) {
        if (!_rootDir) return false;
        try {
            var bf = _bridgeFs();
            if (!bf) return false;
            var fDir = await _resolveFloorDir(questId, floorNum);
            if (!fDir) return false;
            var fJsonPath = fDir + 'all.json';
            await bf.write(fJsonPath, JSON.stringify(floorData, null, 2));
            return true;
        } catch (_e) {
            console.warn('[quest-store] _writeFloorFile FAIL:', _e && _e.message);
            return false;
        }
    }

    // 分配下一个 floor 号（原子自增，每 quest 独立计数器）
    QuestStore.prototype.nextFloorNum = async function (questId) {
        var b = _bridge();
        if (!b) throw new Error('quest-store: no bridge');
        return await b.atomicIncr('floor_counter.' + questId);
    };

    // 保存楼层 — all.json 真理源 + sq3 轻量索引
    QuestStore.prototype.saveFloor = async function (questId, floorNum, floorData) {
        floorData.savedAt = Date.now();

        // 1) ★ 写 all.json（真理源）— ID 前缀自动解析路径，标题变也不怕
        await _writeFloorFile(questId, floorNum, floorData);

        // 2) 解析当前路径写入 sq3 轻量索引（quest 元数据 + 快速查找）
        var _fDir = floorData._fDir || '';
        if (!_fDir) {
            var resolved = await _resolveFloorDir(questId, floorNum);
            if (resolved) _fDir = resolved;
        }
        // ★ 索引条目存 dirName（精确匹配，防同编号多目录）
        if (_fDir && this._index) {
            for (var di = 0; di < this._index.length; di++) {
                if (this._index[di].id === questId && !this._index[di].dirName) {
                    // 从 _fDir 提取 quest 目录名: ".../qqq/quests/q{n}.xxx/f{n}.yyy/" → "q{n}.xxx"
                    var parts = _fDir.replace(/\\/g, '/').split('/');
                    for (var pi = parts.length - 1; pi >= 0; pi--) {
                        if (parts[pi] && /^q\d+\./.test(parts[pi])) {
                            this._index[di].dirName = parts[pi];
                            break;
                        }
                    }
                    break;
                }
            }
        }

        // 3) sq3 轻量索引（不含 conversation/houses）
        var lightRecord = {
            _fDir: _fDir,
            question: floorData.question || '',
            costWge: floorData.costWge || 0,
            createdAt: floorData.createdAt,
            savedAt: floorData.savedAt
        };
        await _setNow(FLOOR_NS + '.' + questId + '.' + floorNum, lightRecord);

        // 3) 更新 quest.floors[] 列表
        var qData = await _get(QUEST_NS + '.' + questId) || {};
        var floors = qData.floors || [];
        var found = false;
        for (var i = 0; i < floors.length; i++) {
            if (floors[i].n === floorNum) {
                floors[i].savedAt = floorData.savedAt;
                floors[i]._fDir = _fDir;
                found = true;
                break;
            }
        }
        if (!found) {
            floors.push({ n: floorNum, savedAt: floorData.savedAt, _fDir: _fDir });
            floors.sort(function (a, b) { return a.n - b.n; });
        }
        qData.floors = floors;
        if (!qData.ctx) qData.ctx = { narrative: '', facts: [], treasures: [], totalFloors: 0 };
        qData.ctx.totalFloors = Math.max(qData.ctx.totalFloors || 0, floors.length);
        qData.savedAt = Date.now();
        await _setNow(QUEST_NS + '.' + questId, qData);

        _notify(this, 'floor-saved', questId, { floorNum: floorNum });
    };

    // 加载单层楼 — 全部来自 all.json（唯一真理源）
    QuestStore.prototype.loadFloor = async function (questId, floorNum) {
        return await _readFloorFile(questId, floorNum);
    };

    // ★ 从已加载的 all.json 数据重建 sq3 quest 元数据（备份还原 / 改名编号后自愈）
    //   仅重建可计算字段，serverDrift/rulesVersion 保活或设默认值
    async function _rebuildQuestMetaFromFloors(questId, floors) {
        if (!floors || !floors.length) return;
        var totalCostGe = 0, floorTimings = [], totalFloors = 0;
        var oldestTs = Infinity, newestTs = 0;

        for (var i = 0; i < floors.length; i++) {
            var f = floors[i].data || floors[i];
            if (!f) continue;
            totalCostGe += f.costWge || 0;
            if (f.clockTiming) floorTimings.push({ floorIndex: floors[i].floorNum, networkMs: f.clockTiming.networkMs || 0, aiMs: f.clockTiming.aiMs || 0, floorStartPerf: f.clockTiming.floorStartPerf || 0, floorStartServerMs: f.clockTiming.floorStartServerMs || 0 });
            if (f.createdAt && f.createdAt < oldestTs) oldestTs = f.createdAt;
            if (f.savedAt && f.savedAt > newestTs) newestTs = f.savedAt;
            totalFloors++;
        }

        var existing = await _get(QUEST_NS + '.' + questId) || {};
        // ★ 重建 floors 列表（供后续 loadAllFloors 快速查，省文件系统扫描）
        var rebuiltFloors = [];
        for (var fi = 0; fi < floors.length; fi++) {
            rebuiltFloors.push({ n: floors[fi].floorNum, savedAt: floors[fi].data ? floors[fi].data.savedAt : Date.now(), _fDir: '' });
        }
        var qData = {
            ctx: existing.ctx || { narrative: '', facts: [], treasures: [], totalFloors: 0 },
            totalCostGe: totalCostGe,
            floorTimings: floorTimings,
            serverDrift: existing.serverDrift || 0,       // ★ 保活；全新 quest 默认 0
            rulesVersion: existing.rulesVersion || '',     // ★ 保活；全新 quest 默认 ''
            floors: rebuiltFloors,                         // ★ 同步 floors 列表
            createdAt: oldestTs < Infinity ? oldestTs : (existing.createdAt || Date.now()),
            savedAt: newestTs > 0 ? newestTs : Date.now()
        };
        qData.ctx.totalFloors = totalFloors;
        await _setNow(QUEST_NS + '.' + questId, qData);
        console.log('[quest-store] _rebuildQuestMeta: rebuilt quest.' + questId + ' from ' + totalFloors + ' floors (totalCostGe=' + totalCostGe + ')');
    }

    // 加载全部楼层 — 并行读取，N 层楼 = 1 个 await（而非 N 个排队）
    //   sq3 缺失时自动从 all.json 重建 quest 元数据（totalCostGe / floorTimings / ctx）
    QuestStore.prototype.loadAllFloors = async function (questId) {
        var qData = await _get(QUEST_NS + '.' + questId);
        var floorList = (qData && qData.floors) || [];
        var floorListFromFs = false;  // ★ 是否从文件系统兜底扫描（sq3 缺失）

        // ★ 备份还原 / 新发现 quest → sq3 无 floors 列表 → 文件系统兜底扫描
        if (!floorList.length && _rootDir) {
            var qDirName = await _resolveQuestDirName(questId);
            if (qDirName) {
                var bf = _bridgeFs();
                if (bf) {
                    try {
                        var entries = await bf.list(_rootDir + '/qqq/quests/' + qDirName);
                        for (var ei = 0; ei < entries.length; ei++) {
                            if (entries[ei].isDir) {
                                var fm = entries[ei].name.match(/^f(\d+)\./);
                                if (fm) floorList.push({ n: parseInt(fm[1], 10) });
                            }
                        }
                        floorList.sort(function (a, b) { return a.n - b.n; });
                        floorListFromFs = true;
                    } catch (_) { }
                }
            }
        }

        if (!floorList.length) return [];

        // ★ 并行加载所有楼层（N 层 = 1 个 await，而非 N 个串行排队）
        var self = this;
        var results = await Promise.all(floorList.map(function (f) {
            return self.loadFloor(questId, f.n).then(function (data) {
                return { floorNum: f.n, data: data };
            }).catch(function () {
                return { floorNum: f.n, data: null };
            });
        }));

        var floors = [];
        for (var i = 0; i < results.length; i++) {
            if (results[i].data) {
                floors.push(results[i]);
            } else {
                console.warn('[quest-store] loadAllFloors: floor.' + questId + '.' + results[i].floorNum + ' listed but data missing');
            }
        }

        // ★ sq3 缺失时从 all.json 重建 quest 元数据（改名编号/备份还原 零损失）
        if (floorListFromFs || !qData) {
            await _rebuildQuestMetaFromFloors(questId, floors);
        }

        return floors;
    };

    // ★ 从文件系统扫描 all.json 重建 sq3 索引（sq3 损坏时自愈）
    QuestStore.prototype.rebuildIndexFromFiles = async function () {
        var _bfs = _bridgeFs();
        if (!_bfs || !_rootDir) {
            console.warn('[quest-store] rebuildIndexFromFiles: no bridge');
            return;
        }
        var questsDir = _rootDir + '/qqq/quests';
        var questList = null;
        try {
            questList = await _bfs.list(questsDir);
        } catch (_e) {
            console.warn('[quest-store] rebuildIndexFromFiles: cannot list quests dir');
            return;
        }
        if (!questList || !questList.length) return;

        var newIndex = [];
        var _b = _bridge();
        var nextNumeric = 0;

        for (var qi = 0; qi < questList.length; qi++) {
            var qEntry = questList[qi];
            if (!qEntry.isDir) continue;
            // 目录名格式: q{n}.{title}
            var m = qEntry.name.match(/^q(\d+)\.(.+)$/);
            if (!m) continue;
            var qNum = parseInt(m[1], 10);
            var qTitle = m[2];
            var qId = 'q' + qNum;
            if (qNum > nextNumeric) nextNumeric = qNum;

            newIndex.push({
                id: qId,
                numericId: qNum,
                title: qTitle,
                dirName: qEntry.name,  // ★ 完整目录名（精确匹配用）
                createdAt: Date.now(),
                lastActiveAt: Date.now()
            });

            // ★ 预填充 questDir 缓存（后续 _resolveQuestDirName 零 IO）
            _questDirCache[qId] = qEntry.name;

            // 扫描 quest 目录下的 floor 目录
            var qDirPath = questsDir + '/' + qEntry.name;
            var floorEntries = null;
            try {
                floorEntries = await _bfs.list(qDirPath);
            } catch (_e) { continue; }
            if (!floorEntries) continue;

            var floors = [];
            for (var fi = 0; fi < floorEntries.length; fi++) {
                var fEntry = floorEntries[fi];
                if (!fEntry.isDir) continue;
                // 目录名格式: f{n}.{question}
                var fm = fEntry.name.match(/^f(\d+)\.(.+)$/);
                if (!fm) continue;
                var fNum = parseInt(fm[1], 10);
                var fDir = qDirPath + '/' + fEntry.name + '/';

                // ★ 预填充 floorDir 缓存（后续 _resolveFloorDir 零 IO）
                _floorDirCache[qId + '\x00' + fNum] = fDir;

                // 读 all.json 提取轻量信息
                var fileData = await _readFloorFile(qId, fNum);
                var lightRecord = {
                    _fDir: fDir,
                    question: fileData ? (fileData.question || '') : '',
                    costWge: fileData ? (fileData.costWge || 0) : 0,
                    createdAt: fileData ? fileData.createdAt : Date.now(),
                    savedAt: fileData ? fileData.savedAt : Date.now()
                };
                await _setNow(FLOOR_NS + '.' + qId + '.' + fNum, lightRecord);

                floors.push({ n: fNum, savedAt: lightRecord.savedAt, _fDir: fDir });
            }
            floors.sort(function (a, b) { return a.n - b.n; });

            var ctx = { narrative: '', facts: [], treasures: [], totalFloors: floors.length };
            await _setNow(QUEST_NS + '.' + qId, {
                ctx: ctx,
                totalCostGe: 0,
                floorTimings: [],
                serverDrift: 0,
                rulesVersion: '',
                floors: floors,
                createdAt: Date.now(),
                savedAt: Date.now()
            });
        }

        // 写入重建的 index + 种子计数器
        this._index = newIndex;
        await _setNow(INDEX_KEY, newIndex);
        if (_b && nextNumeric > 0) {
            try { await _b.setNow('quest_id_counter', nextNumeric); } catch (_e) { }
        }
        console.log('[quest-store] rebuildIndexFromFiles: rebuilt ' + newIndex.length + ' quest(s) from filesystem');
    };

    return QuestStore;

})();
