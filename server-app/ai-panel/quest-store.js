// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// quest-store.js — 多任务持久化
//
// 真理层级：
//   ① all.json（楼层目录文件）— 唯一真理源，包含 conversation/houses 全量
//      写路径: _qqq/quests/q{n}.*/f{n}.*/all.json   via  bridge.fs.write（底层 _atomicWrite）
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
//   ⑨ 元数据自愈 — sq3 缺失时从 all.json 重建 totalCostGe / floorTimings
//   ⑩ 重复编号修复 — repairDuplicateIds() 扫描并重命名同编号 quest/floor 目录
//      楼层改名时 all.json 无需同步改名，零重命名失败风险
//
// ★ 中心大脑架构（2026-06-21）：
//   parent.__qqq_questIndex = []  — 同窗口三面板共享唯一 quest 索引数组
//   主面板（panelId=1）扫盘一次 → 写入共享索引 → 广播
//   侧面板直接读 parent.__qqq_questIndex，零拷贝、零延迟、零不一致
//   跨窗口通过 IPC sync 广播 quest-created/deleted/renamed 保持同步
//
// 存储结构:
//   Filesystem (真理源):
//    _qqq/quests/q{n}.{title}/f{n}.{question}//
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
            return null;
        }
        var dbPath = _rootDir + '/_qqq/alphal/quest.sq3';
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
    // ★ 中心大脑：共享 quest 索引（同窗口三面板读同一引用，零拷贝）★
    // ═══════════════════════════════════════════════════════════════

    function _idx() {
        try {
            if (parent && Array.isArray(parent.__qqq_questIndex)) {
                return parent.__qqq_questIndex;
            }
        } catch (_) { }
        return null;
    }

    function _setIdx(arr) {
        try {
            // ★ null 始终允许（invalidateIndex 清空用）；
            //   数组仅在共享索引为空时写入（第一写者胜，防侧面板覆盖主面板结果）
            if (arr === null || !parent.__qqq_questIndex || parent.__qqq_questIndex.length === 0) {
                parent.__qqq_questIndex = arr;
                return true;
            }
            return false;
        } catch (_) { return false; }
    }

    // ═══════════════════════════════════════════════════════════════
    // 构造函数
    // ═══════════════════════════════════════════════════════════════

    function QuestStore() {
        this._onChangeCbs = [];
    }

    QuestStore.prototype.setProjectRoot = function (rootDir) {
        if (rootDir && typeof rootDir === 'string') {
            _rootDir = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
            _qgs = null;
            _questDirCache = {};
            _floorDirCache = {};
            // [silent] setProjectRoot
        } else if (rootDir === null) {
            // ★ workspace 拆卸时清空
            _rootDir = null;
            _qgs = null;
            _questDirCache = {};
            _floorDirCache = {};
        }
    };

    QuestStore.prototype.getProjectRoot = function () {
        return _rootDir;
    };

    // ★ 外部失效索引（跨面板同步后强制重载）
    //   同窗口：共享索引已被发送方原地修改，reload 产生短暂空窗但 sq3 数据一致
    //   跨窗口：sq3 已被另一窗口更新，必须从 sq3 重载到共享索引
    //   返回 Promise：确保调用方 await 后共享索引确已从 sq3 重载
    QuestStore.prototype.invalidateIndex = function () {
        // ★ 清空共享索引 → 下次 list() 触发 _ensureIndex 从 sq3 重新加载
        _setIdx(null);
        var _pending = _indexLoadPromise;
        _indexLoadPromise = null;
        if (_pending) {
            return _pending.then(function () { });
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
    // ★ 中心大脑：parent.__qqq_questIndex 是唯一真理源
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
        // ★ 中心大脑：若共享索引已存在且非空 → 直接返回（已加载）
        var shared = _idx();
        if (shared && shared.length > 0) return;

        if (!_isMainPanel) {
            // ★ 侧面板：等主面板完成加载（轮询 parent.__qqq_questIndex）
            //   绝不写共享索引（防止覆盖主面板的 _syncIndexFromFs 结果）
            for (var attempt = 0; attempt < 80; attempt++) {
                shared = _idx();
                if (shared && shared.length > 0) return;
                if (parent && parent.__qqq_questIndexLoading) {
                    await new Promise(function (r) { setTimeout(r, 100); });
                    continue;
                }
                await new Promise(function (r) { setTimeout(r, 100); });
            }
            // ★ 超时（8s）：主面板未响应 → 自己读 sq3 应急（不写共享索引）
            var raw = await _get(INDEX_KEY);
            if (raw && Array.isArray(raw) && raw.length > 0) {
                _setIdx(raw);
            }
            return;
        }

        // ★ 主面板：唯一扫盘者。用 _indexLoadPromise 串行化（模块级锁，防主面板重复加载）
        if (_indexLoadPromise) return _indexLoadPromise;
        // ★ 同步设标记+空占位（必须在 await 前，防侧面板读到 undefined/null）
        if (parent) { parent.__qqq_questIndexLoading = true; _setIdx([]); }
        _indexLoadPromise = (async () => {
            try {
                var raw = await _get(INDEX_KEY);
                var idx = (raw && Array.isArray(raw)) ? raw.slice() : [];
                // ★ 原地替换占位数组内容（保留引用，侧面板可见）
                var cur = _idx();
                if (cur) {
                    cur.length = 0;
                    for (var ci = 0; ci < idx.length; ci++) { cur.push(idx[ci]); }
                } else {
                    _setIdx(idx);
                }
                await _healIndex();
                await this._syncIndexFromFs();
                // ★ 加固（2026-06-25）：最终保险 — 确保 counter ≥ 索引最大 ID
                //   _syncIndexFromFs 只对 "新发现" 的 quest 更新 counter，
                //   若所有 quest 均在索引中则跳过 → counter 可能长期偏低而不被发现
                _healCounterFromIndex();
                // ★ 根因修复（2026-08-08）：floor_counter 启动对账
                //   计数器仅作建议值，磁盘是最终仲裁者 — 每 quest 扫盘取最大楼层号，
                //   counter < max+1 时提升（q147 事故：counter 与磁盘脱节 → 分配已存在编号）
                await _healFloorCounters(this);
            } catch (e) {
                console.warn('[quest-store] _ensureIndex failed:', e && e.message);
                if (!_idx()) _setIdx([]);
            } finally {
                _indexLoadPromise = null;
                if (parent) parent.__qqq_questIndexLoading = false;
            }
        })();
        return _indexLoadPromise;
    };

    // ★ 计数器自愈：若 quest_id_counter 未初始化，从 index 推最大 ID 种子
    async function _healIndex() {
        var b = _bridge();
        if (!b) return;
        try {
            var cur = await b.get('quest_id_counter');
            if (!cur || !(typeof cur === 'number' && cur > 0)) {
                var idx = _idx() || [];
                var maxN = 0;
                for (var i = 0; i < idx.length; i++) {
                    var n = idx[i].numericId || 0;
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
    }

    // ★ 根因修复（2026-08-08）：floor_counter 启动对账（仅主面板，一次扫盘）
    //   磁盘最大楼层号 + 1 为下限；防计数器长期脱节（repair 改名 / 手动复制 quest 目录）
    //   顺带检测 floor 同号多目录 → 触发 repairDuplicateIds 收敛脏数据（断链修复：
    //   此前仅 quest 级重复才触发 repair，floor 级重复永远残留）
    async function _healFloorCounters(store) {
        var b = _bridge();
        if (!b || !_rootDir || !_isMainPanel) return;
        var bf = _bridgeFs();
        if (!bf) return;
        var idx = _idx() || [];
        var _floorDupQuestIds = [];
        for (var i = 0; i < idx.length; i++) {
            var e = idx[i];
            try {
                var qDirName = _questDirCache[e.id] || await _resolveQuestDirName(e.id);
                if (!qDirName) continue;
                var entries = await _safeList(_rootDir + '/_qqq/quests/' + qDirName);
                var maxN = 0;
                var _seenNums = {};
                for (var j = 0; j < entries.length; j++) {
                    var m = entries[j].name.match(/^f(\d+)\./);
                    if (m) {
                        var n = parseInt(m[1], 10);
                        if (n > maxN) maxN = n;
                        if (_seenNums[n] && _floorDupQuestIds.indexOf(e.id) < 0) _floorDupQuestIds.push(e.id);
                        _seenNums[n] = true;
                    }
                }
                if (maxN <= 0) {
                    // ★ 空 quest 壳自愈（2026-08-09）：有目录但零 f{n} 楼层目录且 mtime 超 30 分钟 → 归档 .trash
                    //   来源：草稿晋升 mkdir 后崩溃/强杀（楼层目录都未建成）/ 空壳楼层全部归档后的二次收敛
                    //   30 分钟阈值：建楼中楼层目录必已存在（mkdir 先于发送），零 f 目录 ≠ 活跃建楼
                    try {
                        var _stQz = await bf.stat(_rootDir + '/_qqq/quests/' + qDirName);
                        if (_stQz && _stQz.mtimeMs && (Date.now() - _stQz.mtimeMs) > 30 * 60 * 1000) {
                            var _trashQBase = _rootDir + '/_qqq/quests/.trash/';
                            await bf.mkdir(_trashQBase);
                            try {
                                await bf.rename(_rootDir + '/_qqq/quests/' + qDirName, _trashQBase + qDirName);
                                console.log('[quest-store] _healFloorCounters: archived empty quest dir ' + qDirName + ' to .trash');
                            } catch (_eQr) { }
                        }
                    } catch (_eQz) { }
                    continue;
                }
                var key = 'floor_counter.' + e.id;
                var cur = await b.get(key);
                if (typeof cur !== 'number' || isNaN(cur)) cur = 0;  // ★ 键缺失也 seed（sq3 重建/清理竞态后 counter 丢失 → 首号撞磁盘）
                if (maxN + 1 > cur) {
                    await b.setNow(key, maxN + 1);
                    console.log('[quest-store] _healFloorCounters: ' + key + ' ' + (cur || 0) + ' → ' + (maxN + 1));
                }
            } catch (_) { }
        }
        // ★ floor 同号多目录（历史碰撞残留）→ 触发 repair 改名合并（读路径有 all.json 优先兜底，
        //   但重复目录应被收敛，而非永远残留占号）
        if (_floorDupQuestIds.length && store) {
            console.warn('[quest-store] _healFloorCounters: floor dup in ' + _floorDupQuestIds.join(', ') + ' — triggering repairDuplicateIds');
            setTimeout(function () {
                store.repairDuplicateIds().catch(function (_e) { console.warn('[quest-store] floor-dup auto-repair failed:', _e && _e.message); });
            }, 2000);
        }
    }

    // ★ 加固（2026-06-25）：确保 quest_id_counter ≥ 索引中最大 ID
    //   _syncIndexFromFs 的 counter 更新只覆盖 "新发现" 的 quest，
    //   若所有 quest 均已在索引中则跳过 — counter 长期偏低时不会被发现
    async function _healCounterFromIndex() {
        var b = _bridge();
        if (!b) return;
        var idx = _idx() || [];
        var maxN = 0;
        for (var i = 0; i < idx.length; i++) {
            var n = idx[i].numericId || 0;
            if (n > maxN) maxN = n;
        }
        if (maxN <= 0) return;
        try {
            var cur = await b.get('quest_id_counter');
            if (!cur || !(typeof cur === 'number' && cur >= maxN)) {
                await b.setNow('quest_id_counter', maxN);
                console.log('[quest-store] _healCounterFromIndex: fixed quest_id_counter ' + (cur || '?') + ' → ' + maxN);
            }
        } catch (e) {
            console.warn('[quest-store] _healCounterFromIndex failed:', e && e.message);
        }
    }

    // ★ 双向对账：磁盘 ↔ sq3 索引
    //   ① 磁盘有、索引无 → 自动发现（备份还原 / 手动复制 quest 目录）
    //   ② 索引有、磁盘无 → 自动清除（手动删文件夹）
    //   ③ 同编号多目录 → 警告 + 仅保留一条（其余需手动 repairDuplicateIds）
    var _syncLock = null;  // ★ 防并发（_ensureIndex 与手动调用未可同时跑）
    QuestStore.prototype._syncIndexFromFs = async function () {
        if (_syncLock) return _syncLock;
        _syncLock = (async () => {
            try {
                var bf = _bridgeFs();
                if (!bf || !_rootDir) return;

                // 扫描磁盘 → diskList（按 ID 分组，检测重复）
                var diskById = {};   // qId → [{ name, title, numericId }]
                try {
                    var list = await _safeList(_rootDir + '/_qqq/quests');
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
                    console.error('[quest-store] ⚠️ DUPLICATE QUEST IDS DETECTED: ' + dupIds.join(', ') + ' — auto-repairing via repairDuplicateIds()');
                    for (var zi = 0; zi < dupIds.length; zi++) {
                        var zid = dupIds[zi];
                        var names = diskById[zid].map(function (d) { return d.name; });
                        console.error('[quest-store]   ' + zid + ' → ' + names.join(' | '));
                    }
                    // ★ 加固（2026-06-25）：检测到碰撞 → 立即自动修复，不再仅打日志
                    //   延迟 2s 执行（fire-and-forget），不阻塞启动流程
                    // ★ 调度去重（2026-08-09）：boot 期多面板/多调用点会重复检测同一碰撞 →
                    //   只调度一次，其余跳过（否则每次启动刷一串 fixed=0 的重复修复日志）
                    var _repairScheduled = false;
                    try { _repairScheduled = !!(parent && parent.__qqq_repairScheduled); } catch (_) { }
                    if (!_repairScheduled) {
                        try { if (parent) parent.__qqq_repairScheduled = true; } catch (_) { }
                        var _store = this;
                        setTimeout(function () { _store.repairDuplicateIds().catch(function (_e) { console.warn('[quest-store] auto-repair failed:', _e && _e.message); }); }, 2000);
                    } else {
                        console.log('[quest-store] duplicate repair already scheduled, skip');
                    }
                }

                // 索引 → idxMap（id → entry）
                var idx = _idx() || [];
                var idxMap = {};
                for (var j = 0; j < idx.length; j++) {
                    idxMap[idx[j].id] = idx[j];
                }

                // ① 减法：索引有、磁盘无 → 踢出
                // ★ 30s 宽限期：questStore.create() 先写索引，_ensureQuestDir() 后建目录，
                //   这中间若 _syncIndexFromFs 运行会误删刚创建但目录未建的 quest
                var stale = [];
                var _now = Date.now();
                for (var k = idx.length - 1; k >= 0; k--) {
                    if (!diskById[idx[k].id]) {
                        var _age = _now - (idx[k].createdAt || 0);
                        if (_age < 30000) continue;  // ★ 30s 内新建 → 暂不踢，等目录落地
                        stale.push(idx[k].id);
                        idx.splice(k, 1);
                    }
                }

                // ② 加法：磁盘有、索引无 → 发现（取第一个，重复的不重复加）
                var added = [];
                for (var ai = 0; ai < diskIds.length; ai++) {
                    var aid = diskIds[ai];
                    if (!idxMap[aid]) {
                        var d = diskById[aid][0];  // 取第一个
                        idx.push({
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

                // ★ 更新已有条目的 dirName + title + 同步缓存（防同编号多目录 prefix scan 误匹配）
                var _dirNamesUpdated = false;
                for (var ui = 0; ui < idx.length; ui++) {
                    var ue = idx[ui];
                    if (ue.id && diskById[ue.id] && diskById[ue.id].length >= 1) {
                        var diskName = diskById[ue.id][0].name;
                        // ★ 改名后 dirName 需同步磁盘真相（否则 _resolveQuestDirName 返回旧目录名 → bf.list 空）
                        if (ue.dirName !== diskName) {
                            if (ue.dirName) { console.log('[quest-store] _syncIndexFromFs: dirName updated for ' + ue.id + ' "' + ue.dirName + '" → "' + diskName + '"'); }
                            ue.dirName = diskName;
                            _dirNamesUpdated = true;
                        }
                        // ★ 磁盘 title 真理（2026-08-09 根因修复）：非用户重命名（pendingRename）时
                        //   title 与磁盘对齐。防 stale title（repair/备份还原残留）驱动 lazyRenameScan
                        //   把磁盘目录名改回去 → 与 repairDuplicateIds 互搏、每次启动 churn（q168/q171 事故实锤）
                        if (!ue.pendingRename && ue.title !== diskById[ue.id][0].title) {
                            ue.title = diskById[ue.id][0].title;
                            _dirNamesUpdated = true;
                        }
                        // ★ 缓存必须与索引一致（否则 _resolveQuestDirName prefix scan 可能返回错误目录）
                        if (_questDirCache[ue.id] !== diskName) _questDirCache[ue.id] = diskName;
                    }
                }

                if (!stale.length && !added.length && !_dirNamesUpdated) return;

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
                await _saveIndex();
                // ★ 广播发现/移除的 quest，让侧面板同步更新
                for (var _ai = 0; _ai < added.length; _ai++) { _notify(this, 'quest-created', added[_ai]); }
                for (var _si = 0; _si < stale.length; _si++) { _notify(this, 'quest-deleted', stale[_si]); }
                if (added.length) console.log('[quest-store] _syncIndexFromFs: discovered ' + added.length + ' new quest(s) from filesystem');
                if (stale.length) console.log('[quest-store] _syncIndexFromFs: removed ' + stale.length + ' stale quest(s) from index');
            } finally {
                _syncLock = null;
            }
        })();
        return _syncLock;
    };

    // ★ 修复同编号重复 quest：扫描磁盘，将多余目录重命名到新 ID
    //   例：q8.你好 / q8.系统 → 保留 index 中已有条目对应的目录，其余分配 q120, q121...
    var _repairLock = null;
    QuestStore.prototype.repairDuplicateIds = async function () {
        if (_repairLock) { console.warn('[quest-store] repairDuplicateIds: already running'); return _repairLock; }
        _repairLock = (async () => {
            try {
                // ★ 跨实例互斥（2026-08-09 根因修复）：三面板各持独立 questStore，per-instance 锁
                //   防不住并发改名。与 lazyRenameScan 共用 parent 级 __qqq_dirRenameLock，
                //   杜绝 repair 与 lazyRename 互搏（q168/q171 事故：一个改走、一个改回，每次启动 churn）
                var _pl = null; try { _pl = parent; } catch (_) { }
                if (_pl && _pl.__qqq_dirRenameLock) {
                    console.warn('[quest-store] repairDuplicateIds: rename lock held, skip (other scan running)');
                    return;
                }
                try { if (_pl) _pl.__qqq_dirRenameLock = true; } catch (_) { }
                if (!_rootDir) { console.warn('[quest-store] repairDuplicateIds: no project root'); return; }
                var bf = _bridgeFs();
                if (!bf) { console.warn('[quest-store] repairDuplicateIds: no bridgeFs'); return; }
                var b = _bridge();
                if (!b) { console.warn('[quest-store] repairDuplicateIds: no bridge'); return; }

                // 扫描磁盘，按 ID 分组
                var diskById = {};
                try {
                    var list = await _safeList(_rootDir + '/_qqq/quests');
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

                var idx = _idx() || [];
                for (var di = 0; di < diskIds.length; di++) {
                    var did = diskIds[di];
                    var entries = diskById[did];
                    if (entries.length <= 1) continue;

                    console.warn('[quest-store] repairDuplicateIds: fixing ' + did + ' (' + entries.length + ' duplicates)');

                    // 查找 index 中已有该 ID 的条目 → 其 dirName 仅作平局偏好
                    var idxPref = null;
                    for (var ei = 0; ei < idx.length; ei++) {
                        if (idx[ei].id === did && idx[ei].dirName) {
                            idxPref = idx[ei].dirName;
                            break;
                        }
                    }
                    // ★ 有数据者优先（2026-08-09 根因修复）：保留 all.json 楼层最多的目录，
                    //   与 floor 级 repair 同规则。旧逻辑保留 idx.dirName → 可能保留空壳、
                    //   把真数据目录改名到新 ID（q168 事故：真数据被改名 q172、空壳留 q168 →
                    //   运行中会话继续写空壳 → f28 写盘失败残留 tmp）
                    var keepName = null, bestCount = -1;
                    for (var bi = 0; bi < entries.length; bi++) {
                        var _cnt = 0;
                        try { _cnt = await _questDirDataCount(bf, _rootDir + '/_qqq/quests/' + entries[bi].name + '/'); } catch (_) { }
                        if (_cnt > bestCount) { bestCount = _cnt; keepName = entries[bi].name; }
                        else if (_cnt === bestCount && entries[bi].name === idxPref) { keepName = entries[bi].name; }
                    }
                    // 全空壳 → 退回 idx 偏好 / 第一个（不删数据，占新号继续存活）
                    if (!keepName) keepName = idxPref || entries[0].name;

                    for (var zi = 0; zi < entries.length; zi++) {
                        if (entries[zi].name === keepName) continue;  // 跳过保留的

                        // 分配新 ID
                        curCounter++;
                        var newId = 'q' + curCounter;
                        var oldName = entries[zi].name;
                        var newName = newId + '.' + entries[zi].title;
                        var oldPath = _rootDir + '/_qqq/quests/' + oldName;
                        var newPath = _rootDir + '/_qqq/quests/' + newName;

                        try {
                            await bf.rename(oldPath, newPath);
                            // 添加到 index
                            idx.push({
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

                    // ★ 保留目录与索引对齐（2026-08-09 根因修复）：idx.dirName/title 必须指向
                    //   真实保留目录，否则 _resolveQuestDirName / 后续 sync 会把空壳当真理
                    //   （q168 事故第二环节：保留目录名与 sq3 记录脱节 → 会话写进空壳）
                    for (var _ki = 0; _ki < idx.length; _ki++) {
                        if (idx[_ki].id === did) {
                            var _keptTitle = keepName.replace(/^q\d+\./, '');
                            if (!idx[_ki].pendingRename) idx[_ki].title = _keptTitle;
                            idx[_ki].dirName = keepName;
                            _questDirCache[did] = keepName;
                            break;
                        }
                    }
                }

                // 更新计数器
                if (curCounter > 0) {
                    try { await b.setNow('quest_id_counter', curCounter); } catch (_) { }
                }
                await _saveIndex();
                console.log('[quest-store] repairDuplicateIds: fixed=' + fixed + ' failed=' + failed);

                // ★ 同时修复楼层重复（同一 quest 内多个 f{n}.* 目录）
                var floorFixed = 0, floorFailed = 0;
                var questsWithFloorFix = {};  // ★ 追踪哪些 quest 改了楼层（后续清 sq3 强制重建）
                // 重新扫描（quest 目录可能已改名）
                var allDiskDirs = {};
                try {
                    var list2 = await _safeList(_rootDir + '/_qqq/quests');
                    for (var li = 0; li < list2.length; li++) {
                        if (list2[li].isDir) {
                            var m2 = list2[li].name.match(/^q(\d+)\./);
                            if (m2) allDiskDirs['q' + m2[1]] = list2[li].name;
                        }
                    }
                } catch (_) { }

                for (var flQi = 0; flQi < idx.length; flQi++) {
                    var flQe = idx[flQi];
                    var flDirName = flQe.dirName || allDiskDirs[flQe.id];
                    if (!flDirName) continue;

                    var flQDirPath = _rootDir + '/_qqq/quests/' + flDirName;
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
                    // ★ 跨重复组共享递增状态（2026-08-08 F14 修复）：
                    //   旧逻辑在每个重复组内重新从磁盘最大号算 → 多组重复全部映射到同一新号
                    //   （q81 f97/f98 → 全 f101；q147 f96/f97/f98/f99 → 全 f109 → 新重复目录事故）。
                    //   现在：questMaxFn 先扫全组找最大号，之后每次改名递增，跨组永不撞。
                    var questMaxFn = 0;
                    for (var flni = 0; flni < flNums.length; flni++) {
                        var fn = parseInt(flNums[flni]);
                        if (fn > questMaxFn) questMaxFn = fn;
                    }
                    for (var flni = 0; flni < flNums.length; flni++) {
                        var fn = parseInt(flNums[flni]);
                        var fEntries = floorByName[fn];
                        if (fEntries.length <= 1) continue;

                        console.warn('[quest-store] repairDuplicateIds: floor dup in ' + flQe.id + ' f' + fn + ' (' + fEntries.length + ' duplicates)');
                        // ★ 保留有 all.json 的目录（与 _resolveFloorDir 读路径同规则）：
                        //   否则可能保留孤儿（只有 all.txt）→ 真数据被改名 → sq3 重建后 f{n} 读空 → 索引循环
                        var keepF = null;
                        for (var fki = 0; fki < fEntries.length; fki++) {
                            var _keepHasJson = await _dirHasAllJson(bf, flQDirPath + '/' + fEntries[fki] + '/');
                            if (_keepHasJson) { keepF = fEntries[fki]; break; }
                        }
                        if (!keepF) keepF = fEntries[0];  // 全孤儿 → 保留第一个（不删数据，占新号继续存活）
                        // ★ 从跨组共享状态取号（不再每组建独立 maxFn）
                        var maxFn = Math.max(questMaxFn, fn);
                        for (var fzi = 0; fzi < fEntries.length; fzi++) {
                            if (fEntries[fzi] === keepF) continue;  // ★ 跳过保留目录
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
                                questMaxFn = maxFn;  // ★ 跨组共享：本次分配的新号成为后续分配的下界（F14）
                                console.log('[quest-store] repairDuplicateIds: floor renamed ' + oldFName + ' → ' + newFName + ' (quest=' + flQe.id + ')');
                            } catch (e) {
                                floorFailed++;
                                console.error('[quest-store] repairDuplicateIds: FAIL floor rename ' + oldFName + ': ' + (e && e.message));
                            }
                        }
                    }
                }

                if (floorFixed > 0) console.log('[quest-store] repairDuplicateIds: floorFixed=' + floorFixed + ' floorFailed=' + floorFailed);

                // ★ 同步 floor_counter：楼层改名后计数器可能低于磁盘最大编号
                //   （q147 事故根因链：repair 改名 f97→f98 后 counter 停在 97 → 下次建楼又分配 97 → 碰撞）
                //   改完立即把 counter 提升到 max(磁盘最大号)+1，从源头消除下一次碰撞。
                var _fcKeys = Object.keys(questsWithFloorFix);
                var _fcBridge = _bridge();
                for (var _fci = 0; _fci < _fcKeys.length; _fci++) {
                    var _fcQid = _fcKeys[_fci];
                    try {
                        var _fcDirName = await _resolveQuestDirName(_fcQid);
                        if (!_fcDirName) continue;
                        var _fcList = await _safeList(_rootDir + '/_qqq/quests/' + _fcDirName);
                        var _fcMax = 0;
                        for (var _fei = 0; _fei < _fcList.length; _fei++) {
                            var _fem = _fcList[_fei].name.match(/^f(\d+)\./);
                            if (_fem) {
                                var _fnv = parseInt(_fem[1], 10);
                                if (_fnv > _fcMax) _fcMax = _fnv;
                            }
                        }
                        if (_fcMax > 0) {
                            var _fcCur = (await _fcBridge.get('floor_counter.' + _fcQid)) || 0;
                            if (typeof _fcCur === 'number' && _fcMax + 1 > _fcCur) {
                                await _fcBridge.setNow('floor_counter.' + _fcQid, _fcMax + 1);
                                console.log('[quest-store] repairDuplicateIds: floor_counter.' + _fcQid + ' synced ' + _fcCur + ' → ' + (_fcMax + 1));
                            }
                        }
                    } catch (_) { }
                }

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
                try { if (parent) { parent.__qqq_dirRenameLock = false; parent.__qqq_repairScheduled = false; } } catch (_) { }
            }
        })();
        return _repairLock;
    };

    async function _saveIndex() {
        var idx = _idx();
        if (idx) await _setNow(INDEX_KEY, idx);
    }

    // ═══════════════════════════════════════════════════════════════
    // Quest CRUD
    // ═══════════════════════════════════════════════════════════════

    // create(title) → id='qN'，N 由 SQLite atomicIncr 原子分配，零竞态
    // ★ 加固（2026-06-25）：创建前检查磁盘+索引是否有重复 → 发现碰撞则愈合计数器后重分配
    QuestStore.prototype.create = async function (title) {
        await this._ensureIndex();
        var b = _bridge();
        if (!b) throw new Error('quest-store: no bridge');
        var bf = _bridgeFs();
        var idx = _idx();

        // ★ 磁盘去重守卫：atomicIncr 只保证 sq3 内原子，不保证与磁盘一致
        //   若 counter 偏低（sq3 损坏/手动操作），可能分配已存在的编号 → 必须先验
        var maxRetries = 5;
        var numericId, id, now;
        var _idAllocated = false;
        for (var retry = 0; retry < maxRetries; retry++) {
            numericId = await b.atomicIncr('quest_id_counter');
            id = 'q' + numericId;
            // 检查索引中是否已有此 ID
            var idxDup = false;
            if (idx) {
                for (var di = 0; di < idx.length; di++) {
                    if (idx[di].id === id) { idxDup = true; break; }
                }
            }
            if (idxDup) {
                console.warn('[quest-store] create: index already has ' + id + ', retrying (attempt ' + (retry + 1) + '/' + maxRetries + ')');
                continue;
            }
            // 检查磁盘上是否已有此编号目录
            var diskDup = false;
            if (bf && _rootDir) {
                try {
                    var diskList = await _safeList(_rootDir + '/_qqq/quests');
                    for (var ddi = 0; ddi < diskList.length; ddi++) {
                        if (diskList[ddi].isDir && diskList[ddi].name.indexOf(id + '.') === 0) {
                            diskDup = true;
                            console.warn('[quest-store] create: disk already has ' + id + ' (' + diskList[ddi].name + '), retrying (attempt ' + (retry + 1) + '/' + maxRetries + ')');
                            break;
                        }
                    }
                } catch (_) { /* disk check failed → proceed anyway (worse case: _findQuestDirByPrefix catches it later) */ }
            }
            if (!diskDup) { _idAllocated = true; break; }  // ★ 干净 ID，退出循环
        }
        // ★ 与 nextFloorNum 同策略：拿不到干净 ID 就抛错，绝不用冲突 ID 建 quest
        if (!_idAllocated) throw new Error('quest-store: cannot allocate free quest id after ' + maxRetries + ' attempts');

        now = Date.now();
        var entry = {
            id: id,
            numericId: numericId,
            title: title || '',
            dirName: '',  // ★ 首次 writeFloorFile 时填充
            createdAt: now,
            lastActiveAt: now
        };
        if (idx) idx.push(entry);
        await _saveIndex();

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
        var idx = _idx();
        var entry = null;
        if (idx) {
            for (var i = 0; i < idx.length; i++) {
                if (idx[i].id === id) { entry = idx[i]; break; }
            }
        }
        if (entry) {
            entry.title = title;
            // ★ 用户显式重命名（2026-08-09）：打 pendingRename 标记 —— lazyRenameScan 仅对带标记的
            //   quest 执行磁盘改名；其余一切情况磁盘目录名为唯一真理（防 stale title 驱动改名 churn）
            entry.pendingRename = true;
            if (typeof numericId === 'number') entry.numericId = numericId;
            await _saveIndex();
            // ★ 标题变了 → 目录名变了 → 失效路径缓存，下次走 list 重新解析
            _invalidatePathCache(id);
            _notify(this, 'quest-renamed', id, { title: title });
            return true;
        }
        return false;
    };

    QuestStore.prototype.deleteQuest = async function (id) {
        await this._ensureIndex();
        var idx = _idx() || [];
        var filtered = idx.filter(function (s) { return s.id !== id; });
        // ★ 直接从共享数组移除（保持引用不变，splice-based 替换）
        idx.length = 0;
        for (var fi = 0; fi < filtered.length; fi++) { idx.push(filtered[fi]); }
        await _saveIndex();
        // 删除 quest 元数据和所有 floor 数据
        var b = _bridge();
        var floors = [];
        if (b && b.del) {
            var qData = await _get(QUEST_NS + '.' + id);
            floors = (qData && qData.floors) || [];
            for (var fi2 = 0; fi2 < floors.length; fi2++) {
                await b.del(FLOOR_NS + '.' + id + '.' + floors[fi2].n);
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
                        var qDirPath = _rootDir + '/_qqq/quests/' + qDirName;
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
        var idx = _idx();
        if (!idx) return;
        for (var i = 0; i < idx.length; i++) {
            if (idx[i].id === id) {
                idx[i].lastActiveAt = Date.now();
                await _saveIndex();
                return;
            }
        }
    };

    QuestStore.prototype.list = async function () {
        await this._ensureIndex();
        var idx = _idx() || [];
        return idx.slice().sort(function (a, b) {
            var ta = a.lastActiveAt || 0;
            var tb = b.lastActiveAt || 0;
            if (ta !== tb) return tb - ta;
            var na = a.numericId || 0;
            var nb = b.numericId || 0;
            return nb - na;
        });
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
        await _setNow(QUEST_NS + '.' + id, data);
        var _fnForNotify = data.currentFloorNum || undefined;
        _notify(this, 'quest-saved', id, { floorNum: _fnForNotify });
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
    var _floorDirCache = {}; //   questId+'\x00'+floorNum → 完整路径 (e.g. "_qqq/quests/q1.新标题/f3.新问题/")
    var _questDirListLock = {};  // qDirName → Promise (防同目录并发 list——loadAllFloors Promise.all 触发)

    function _invalidatePathCache(questId) {
        delete _questDirCache[questId];
        var prefix = questId + '\x00';
        Object.keys(_floorDirCache).forEach(function (k) {
            if (k.indexOf(prefix) === 0) delete _floorDirCache[k];
        });
    }

    // ★ 解析 quest 目录名 — 永远从磁盘编号匹配（sq3 的 dirName 只是给 UI 看的摘要，不参与路径解析）
    async function _resolveQuestDirName(questId, _dirName) {
        // ★ 调用方显式传入已验证的 dirName → 直接信任（如 deleteQuest）
        if (_dirName) {
            _questDirCache[questId] = _dirName;
            return _dirName;
        }

        // ★ 磁盘编号前缀扫描（唯一真理源）
        if (!_rootDir) return null;
        var bf = _bridgeFs();
        if (!bf) return null;
        try {
            var list = await _safeList(_rootDir + '/_qqq/quests');
            for (var i = 0; i < list.length; i++) {
                if (list[i].isDir && list[i].name.indexOf(questId + '.') === 0) {
                    _questDirCache[questId] = list[i].name;
                    return list[i].name;
                }
            }
        } catch (_) { }
        return null;
    }

    // ★ 判断目录是否存在 all.json（孤儿目录判定：只残留 all.txt 的目录不参与楼层解析）
    async function _dirHasAllJson(bf, dirPath) {
        try {
            var entries = await bf.list(dirPath);
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].name === 'all.json') return true;
            }
        } catch (_) { }
        return false;
    }

    // ★ quest 目录有效数据楼层数（2026-08-09）：统计含 all.json 的 f{n}.* 子目录数
    //   —— quest 级 repair 的「有数据者优先」保留判定依据（与 floor 级同规则）
    async function _questDirDataCount(bf, dirPath) {
        var n = 0;
        try {
            var list = await bf.list(dirPath);
            for (var i = 0; i < list.length; i++) {
                if (list[i].isDir && /^f\d+\./.test(list[i].name)) {
                    if (await _dirHasAllJson(bf, dirPath + list[i].name + '/')) n++;
                }
            }
        } catch (_) { }
        return n;
    }

    // 解析 floor 目录完整路径: list("q{n}.*/") → startsWith("f{n}.")
    // ★ 2026-06-24 加固：loadAllFloors Promise.all 并发时，同 quest 目录只 list 一次。
    //   首次 list 时预热全部 floor 缓存，后续调用 100% 缓存命中零 IO。
    async function _resolveFloorDir(questId, floorNum) {
        var cacheKey = questId + '\x00' + floorNum;
        if (_floorDirCache[cacheKey]) return _floorDirCache[cacheKey];
        var qDirName = await _resolveQuestDirName(questId);
        if (!qDirName) return null;
        var bf = _bridgeFs();
        if (!bf) return null;
        var qDirPath = _rootDir + '/_qqq/quests/' + qDirName;

        // ★ 同 quest 目录的并发 list 合并为一个（防 loadAllFloors Promise.all 触发 N 次）
        var _listProm = _questDirListLock[qDirName];
        if (_listProm) {
            await _listProm;
            return _floorDirCache[cacheKey] || null;
        }

        _listProm = (async () => {
            try {
                var list = await bf.list(qDirPath);
                // ★ 预热全部 floor 目录缓存（一次 list 覆盖所有楼层）
                // ★ 2026-08-08 洪泛根治（q147 每次启动刷屏 100+ 条 DUPLICATE）:
                //   ① 告警仅限本次扫描内真实重复（缓存被写路径/前次扫描预置 ≠ 磁盘重复）→ 假阳性消除
                //   ② 同号多目录选择: 有 all.json 者优先，同为有/无再比 mtime 最新
                //      （孤儿目录 f99.1 只残留 all.txt 曾因 mtime 最新胜出 → 每次启动读失败 → 无限重建循环）
                var _seenNums = {};   // 本次扫描已见编号 → 同列表第二个同号 = 真实重复
                for (var i = 0; i < list.length; i++) {
                    if (list[i].isDir) {
                        var fm = list[i].name.match(/^f(\d+)\./);
                        if (fm) {
                            var fk = questId + '\x00' + fm[1];
                            var _realDup = !!_seenNums[fm[1]];
                            _seenNums[fm[1]] = true;
                            var _dupPath = qDirPath + '/' + list[i].name + '/';
                            var _cand = _floorDirCache[fk];
                            if (!_cand) {
                                _floorDirCache[fk] = _dupPath;
                                continue;
                            }
                            // ★ 同号多目录（历史碰撞残留 / 孤儿目录）→ 有 all.json 者优先，再比 mtime 最新
                            var _hasAllOld = false, _hasAllNew = false, _takeNew = false;
                            try {
                                _hasAllNew = await _dirHasAllJson(bf, _dupPath);
                                _hasAllOld = await _dirHasAllJson(bf, _cand);
                                var _stOld = await bf.stat(_cand);
                                var _stNew = await bf.stat(_dupPath);
                                if (_hasAllNew && !_hasAllOld) _takeNew = true;
                                else if (_hasAllOld && !_hasAllNew) _takeNew = false;
                                else if (_stNew && (!_stOld || (_stNew.mtimeMs || 0) > (_stOld.mtimeMs || 0))) _takeNew = true;  // ★ mtimeMs（原 mtime 字段不存在 → 永假死逻辑）
                            } catch (_) { }
                            if (_takeNew) _floorDirCache[fk] = _dupPath;
                            if (_realDup) {
                                console.warn('[quest-store] _resolveFloorDir: DUPLICATE floor dir f' + fm[1] + ' in ' + qDirName + ' — kept ' + (_hasAllNew && !_hasAllOld ? 'all.json dir' : 'newest mtime') + ' (real dup on disk)');
                            }
                        }
                    }
                }
            } catch (_e) {
                console.warn('[quest-store] _resolveFloorDir: bf.list FAIL for ' + qDirPath + ' — ' + (_e && _e.message));
            }
        })();
        _questDirListLock[qDirName] = _listProm;
        await _listProm;
        delete _questDirListLock[qDirName];

        return _floorDirCache[cacheKey] || null;
    }

    // ★ 读取 all.json（真理源）
    //   quiet=true（loadAllFloors 批量路径）→ 失败静默，由调用方汇总打印一次
    async function _readFloorFile(questId, floorNum, quiet) {
        if (!_rootDir) { if (!quiet) console.warn('[quest-store] _readFloorFile FAIL: no _rootDir for ' + questId + '.' + floorNum); return null; }
        try {
            var bf = _bridgeFs();
            if (!bf) { if (!quiet) console.warn('[quest-store] _readFloorFile FAIL: no bridgeFs for ' + questId + '.' + floorNum); return null; }
            var fDir = await _resolveFloorDir(questId, floorNum);
            if (!fDir) { if (!quiet) console.warn('[quest-store] _readFloorFile FAIL: _resolveFloorDir null for ' + questId + '.' + floorNum + ' (dir missing or cache miss)'); return null; }
            var raw = await bf.read(fDir + 'all.json');
            if (!raw) { if (!quiet) console.warn('[quest-store] _readFloorFile FAIL: bf.read null for ' + questId + '.' + floorNum + ' path=' + fDir + 'all.json'); return null; }
            if (typeof raw !== 'string') { if (!quiet) console.warn('[quest-store] _readFloorFile FAIL: raw not string for ' + questId + '.' + floorNum + ' type=' + typeof raw); return null; }
            return JSON.parse(raw);
        } catch (_e) {
            if (!quiet) console.warn('[quest-store] _readFloorFile FAIL: exception for ' + questId + '.' + floorNum + ' — ' + (_e && _e.message));
            return null;
        }
    }

    // ★ 楼层号列表汇总打印（降噪：N 条逐行日志 → 1 行，前 12 个 + 总数）
    function _fmtNums(arr) {
        if (!arr || !arr.length) return '';
        var head = arr.slice(0, 12).join(',');
        return arr.length > 12 ? head + ' …(+' + (arr.length - 12) + ')' : head;
    }

    // ★ 写入 all.json（真理源）— 串行锁防 auto-save/onDone 并发 → tmp→rename 竞态残留
    var _floorWriteLocks = {};
    async function _writeFloorFile(questId, floorNum, floorData) {
        if (!_rootDir) return false;
        var key = questId + '.' + floorNum;
        // 串行化：同一楼层的 auto-save + onDone 未可能同时写，杜绝双 tmp 残留
        // _doWriteFloorFile 全路径 catch 永不 reject → 单参数 then 即可
        var chain = (_floorWriteLocks[key] || Promise.resolve()).then(function () {
            return _doWriteFloorFile(questId, floorNum, floorData);
        });
        _floorWriteLocks[key] = chain;
        // 写完后异步清扫，不阻塞返回
        chain.then(function () {
            var fDir = _floorDirCache && _floorDirCache[questId + '\x00' + floorNum];
            if (fDir) _cleanTmpInDir(fDir, _bridgeFs());
        }).catch(function () { });
        return chain;
    }
    async function _doWriteFloorFile(questId, floorNum, floorData) {
        if (!_rootDir) return false;
        try {
            var bf = _bridgeFs();
            if (!bf) return false;
            // ★ 精确路径优先：本楼层创建者记录的 _fDir（防同号多目录历史残留时模糊匹配写错位置）
            var fDir = null;
            if (floorData && typeof floorData._fDir === 'string' && floorData._fDir) {
                var _baseDir = floorData._fDir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
                // ★ 跨项目写保护（2026-08-08）：_fDir 必须位于当前项目 quests 根下，
                //   否则回退 _resolveFloorDir — 防面板启动竞态绑错项目时把楼层写进别的项目
                var _qRoot = _rootDir + '/_qqq/quests/';
                if (_baseDir.indexOf(_qRoot) === 0 && new RegExp('(^|/)f' + floorNum + '\\.').test(_baseDir)) fDir = _baseDir;
            }
            if (!fDir) fDir = await _resolveFloorDir(questId, floorNum);
            if (!fDir) return false;
            _floorDirCache = _floorDirCache || {};
            // ★ 写入即缓存（键 = _resolveFloorDir 同键 \x00）→ 后续读回同一目录（防同号双目录时读回旧目录）
            _floorDirCache[questId + '\x00' + floorNum] = fDir;
            // ★ 原子写入: tmp → rename，防断电/崩溃导致 all.json 半写损坏（§33）
            var dest = fDir + 'all.json';
            var tmp = dest + '.tmp.' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            var _payloadStr = JSON.stringify(floorData, null, 2);
            await bf.write(tmp, _payloadStr);
            try {
                await bf.rename(tmp, dest);
            } catch (_renErr) {
                // ★ 铁律 8.2 降级：rename 失败（目标被占用/杀软/跨卷）→ 复制替换，绝不丢数据
                //   bf.write 底层即原子写（tmp+rename），直接覆盖 dest 兜底
                console.warn('[quest-store] rename FAIL (q=' + questId + ' f=' + floorNum + '), fallback copy: ' + (_renErr && _renErr.message));
                await bf.write(dest, _payloadStr);
            }
            return true;
        } catch (_e) {
            console.warn('[quest-store] _writeFloorFile FAIL:', _e && _e.message);
            return false;
        }
    }

    // ★ 清扫单个楼层目录中的 all.json.tmp.* 残留（fire-and-forget）
    async function _cleanTmpInDir(fDir, bf) {
        try {
            var entries = await bf.list(fDir);
            if (!entries || !entries.length) return;
            for (var i = 0; i < entries.length; i++) {
                // ★ bf.list 返回 {name,isDir,...} 对象数组（原对对象调 indexOf → TypeError → 清扫从未生效）
                if (entries[i] && entries[i].name && entries[i].name.indexOf('all.json.tmp.') === 0) {
                    try { await bf.remove(fDir + '/' + entries[i].name); } catch (_) { }
                }
            }
        } catch (_) { /* best-effort */ }
    }

    // 分配下一个 floor 号（原子自增 + 磁盘去重验证，零碰撞）
    // ★ 根因修复（2026-08-08 q147 f97/f98 事故）：
    //   旧实现裸 atomicIncr — 计数器与磁盘脱节（repairDuplicateIds 改名不更新 counter /
    //   loadAllFloors 对账不 heal / sq3 重建不种子 floor_counter）→ 分配已存在编号
    //   → 同号双目录 → _resolveFloorDir 模糊匹配写错位置 → json/txt 分家 → 面板无响应。
    //   新实现：自增后验证磁盘 f{n}. 前缀空闲，冲突则继续自增（计数器自动追上磁盘）。
    //   磁盘 = 编号最终仲裁者；sq3 计数器只是建议值，永不产生重复目录。
    QuestStore.prototype.nextFloorNum = async function (questId) {
        var b = _bridge();
        if (!b) throw new Error('quest-store: no bridge');
        var bf = _bridgeFs();
        var qDirName = null;
        var MAX_ALLOC = 1000;

        // ★ 运行时自愈（2026-08-08）：counter 键缺失（sq3 重建/清理竞态、新 quest）→
        //   先按磁盘最大楼层号 seed，再原子自增 → 首号永不撞已有目录（heal 只在启动跑，管不到运行时新建）
        var _ck = 'floor_counter.' + questId;
        try {
            var _pre = await b.get(_ck);
            if (typeof _pre !== 'number' || isNaN(_pre) || _pre < 0) {
                var _seedMax = 0;
                var _qdn0 = await _resolveQuestDirName(questId);
                if (bf && _rootDir && _qdn0) {
                    try {
                        var _seedEntries = await _safeList(_rootDir + '/_qqq/quests/' + _qdn0);
                        for (var _sei = 0; _sei < _seedEntries.length; _sei++) {
                            var _sem = _seedEntries[_sei].name.match(/^f(\d+)\./);
                            if (_sem) {
                                var _sen = parseInt(_sem[1], 10);
                                if (_sen > _seedMax) _seedMax = _sen;
                            }
                        }
                    } catch (_) { }
                }
                await b.setNow(_ck, _seedMax);
            }
        } catch (_) { }
        for (var _alloc = 0; _alloc < MAX_ALLOC; _alloc++) {
            var n = await b.atomicIncr('floor_counter.' + questId);
            if (!bf || !_rootDir) return n;  // 无 fs 环境（dev fallback）→ 信任计数器
            if (!qDirName) {
                qDirName = await _resolveQuestDirName(questId);
                if (!qDirName) return n;  // quest 目录尚未创建（首次建楼前）→ 无碰撞可能
            }
            var _qDirPath = _rootDir + '/_qqq/quests/' + qDirName;
            var _collision = false;
            try {
                var entries = await _safeList(_qDirPath);
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].isDir && entries[ei].name.indexOf('f' + n + '.') === 0) {
                        _collision = true;
                        console.warn('[quest-store] nextFloorNum: collision f' + n + ' already on disk (' + entries[ei].name + ') — counter behind disk, skipping');
                        break;
                    }
                }
            } catch (_) { return n; }  // list 失败 → 无法验证 → 信任计数器（原行为兜底）
            if (!_collision) return n;
        }
        throw new Error('nextFloorNum: cannot allocate free floor number for ' + questId + ' after ' + MAX_ALLOC + ' attempts');
    };

    // 保存楼层 — all.json 真理源 + sq3 轻量索引
    QuestStore.prototype.saveFloor = async function (questId, floorNum, floorData) {
        floorData.savedAt = Date.now();

        // ★ 天罗地网: 保存上报 (throttled — 死前最后在保存哪层)
        try { if (window.__crashNet) window.__crashNet.throttled('save', 2000, { kind: 'save', q: questId, f: floorNum }); } catch (_) { }

        // 1) ★ 写 all.json（真理源）— 串行锁防 auto-save/onDone 并发 tmp→rename 竞态
        await _writeFloorFile(questId, floorNum, floorData);

        // 2) 解析当前路径写入 sq3 轻量索引（quest 元数据 + 快速查找）
        var _fDir = floorData._fDir || '';
        if (!_fDir) {
            var resolved = await _resolveFloorDir(questId, floorNum);
            if (resolved) _fDir = resolved;
        }
        // ★ 索引条目存 dirName（精确匹配，防同编号多目录）
        var idx = _idx();
        if (_fDir && idx) {
            for (var di = 0; di < idx.length; di++) {
                if (idx[di].id === questId && !idx[di].dirName) {
                    var parts = _fDir.replace(/\\/g, '/').split('/');
                    for (var pi = parts.length - 1; pi >= 0; pi--) {
                        if (parts[pi] && /^q\d+\./.test(parts[pi])) {
                            idx[di].dirName = parts[pi];
                            break;
                        }
                    }
                    break;
                }
            }
        }

        // 3) sq3 轻量索引（含预渲染字段：house_count / room_count，不包括 conversation/houses/ai_html）
        var lightRecord = {
            _fDir: _fDir,
            question: floorData.question || '',
            house_count: floorData.house_count != null ? floorData.house_count : 0,
            room_count: floorData.room_count != null ? floorData.room_count : 0,
            costWge: floorData.costWge || 0,
            createdAt: floorData.createdAt,
            savedAt: floorData.savedAt
        };
        await _setNow(FLOOR_NS + '.' + questId + '.' + floorNum, lightRecord);

        // 4) 更新 quest.floors[] 列表
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
        qData.savedAt = Date.now();
        await _setNow(QUEST_NS + '.' + questId, qData);

        _notify(this, 'floor-saved', questId, { floorNum: floorNum });
    };

    // 加载单层楼 — 全部来自 all.json（唯一真理源）
    QuestStore.prototype.loadFloor = async function (questId, floorNum, quiet) {
        return await _readFloorFile(questId, floorNum, quiet);
    };

    // ★ 动态解析 floor 目录完整路径（防 _fDir 过期导致图片 404）
    //   暴露私有函数 _resolveFloorDir 给 card-pool.js 等外部模块
    QuestStore.prototype.resolveFloorDir = async function (questId, floorNum) {
        return await _resolveFloorDir(questId, floorNum);
    };

    // ★ 解析 quest 目录完整路径（ctx.json 持久化用）
    QuestStore.prototype.resolveQuestDir = async function (questId) {
        var qDirName = await _resolveQuestDirName(questId);
        if (!qDirName) return null;
        return _rootDir + '/_qqq/quests/' + qDirName + '/';
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
            totalCostGe: totalCostGe,
            floorTimings: floorTimings,
            serverDrift: existing.serverDrift || 0,       // ★ 保活；全新 quest 默认 0
            rulesVersion: existing.rulesVersion || '',     // ★ 保活；全新 quest 默认 ''
            floors: rebuiltFloors,                         // ★ 同步 floors 列表
            createdAt: oldestTs < Infinity ? oldestTs : (existing.createdAt || Date.now()),
            savedAt: newestTs > 0 ? newestTs : Date.now()
        };
        await _setNow(QUEST_NS + '.' + questId, qData);
        console.log('[quest-store] _rebuildQuestMeta: rebuilt quest.' + questId + ' from ' + totalFloors + ' floors (totalCostGe=' + totalCostGe + ')');
    }

    // 加载全部楼层 — 并行读取，N 层楼 = 1 个 await（而非 N 个排队）
    //   sq3 缺失时自动从 all.json 重建 quest 元数据（totalCostGe / floorTimings）
    QuestStore.prototype.loadAllFloors = async function (questId) {
        var qData = await _get(QUEST_NS + '.' + questId);
        var floorList = (qData && qData.floors) || [];
        var floorListFromFs = false;  // ★ 是否从文件系统兜底扫描（sq3 缺失或有新增楼层）

        // ★ 始终与文件系统对账：发现 sq3 未索引的楼层时自动补入（治 P9 跨 quest 切换时建楼丢失）
        if (_rootDir) {
            var qDirName2 = await _resolveQuestDirName(questId);
            if (qDirName2) {
                var bf2 = _bridgeFs();
                if (bf2) {
                    try {
                        var _fsEntries = await bf2.list(_rootDir + '/_qqq/quests/' + qDirName2);
                        var _sq3Set = {};
                        for (var _si = 0; _si < floorList.length; _si++) { _sq3Set[floorList[_si].n] = true; }
                        var _added = false;
                        // ★ 降噪（2026-08-08）：孤儿/新发现楼层逐行打印 → 各汇总 1 行
                        var _orphanNums = [], _trashedNums = [], _discoveredNums = [];
                        for (var _ei = 0; _ei < _fsEntries.length; _ei++) {
                            if (_fsEntries[_ei].isDir) {
                                var _fm = _fsEntries[_ei].name.match(/^f(\d+)\./);
                                if (_fm) {
                                    var _fn = parseInt(_fm[1], 10);
                                    if (!_sq3Set[_fn]) {
                                        // ★ 2026-08-07: 无 all.json 的孤儿目录不收录（如 f66 只残留 all.txt）
                                        //   否则每次扫描重新发现 → 永久警告循环（sq3 条目已被清理后仍被 FS 扫描捞回）
                                        try {
                                            var _cand = await bf2.list(_rootDir + '/_qqq/quests/' + qDirName2 + '/' + _fsEntries[_ei].name);
                                            var _hasAll = false;
                                            for (var _ci = 0; _ci < _cand.length; _ci++) {
                                                if (_cand[_ci].name === 'all.json') { _hasAll = true; break; }
                                            }
                                            if (!_hasAll) {
                                                // ★ 空壳自愈（2026-08-09）：无 all.json 且目录 mtime 超 30 分钟 → 移入 .trash 归档
                                                //   根治"空目录永久残留"——此前只 skip 不清理，用户永远看到乱目录
                                                //   30 分钟阈值防误删正在建楼的楼层（mkdir 后 all.json 未落盘的窗口期）
                                                //   ★ 2026-08-09 加固：仅归档"真空壳"（空目录 / 仅 all.json.tmp.* 残留）；
                                                //     含 all.txt / snapshot_*.json / img_*.png 等数据文件的目录只跳过不归档（快照/母本不可误伤）
                                                var _hasDataFile = false;
                                                for (var _ci2 = 0; _ci2 < _cand.length; _ci2++) {
                                                    if (!_cand[_ci2].isDir && _cand[_ci2].name.indexOf('all.json.tmp.') !== 0) { _hasDataFile = true; break; }
                                                }
                                                if (!_hasDataFile) {
                                                    try {
                                                        var _stOrph = await bf2.stat(_rootDir + '/_qqq/quests/' + qDirName2 + '/' + _fsEntries[_ei].name);
                                                        var _orphAgeMs = Date.now() - ((_stOrph && _stOrph.mtimeMs) ? _stOrph.mtimeMs : 0);
                                                        if (_orphAgeMs > 30 * 60 * 1000) {
                                                            var _trashBase = _rootDir + '/_qqq/quests/.trash/' + qDirName2;
                                                            await bf2.mkdir(_trashBase);
                                                            try {
                                                                await bf2.rename(_rootDir + '/_qqq/quests/' + qDirName2 + '/' + _fsEntries[_ei].name, _trashBase + '/' + _fsEntries[_ei].name);
                                                                _trashedNums.push(_fn);
                                                            } catch (_e2) { }
                                                        }
                                                    } catch (_e3) { }
                                                }
                                                _orphanNums.push(_fn); continue;
                                            }
                                        } catch (_) { continue; }
                                        floorList.push({ n: _fn });
                                        _sq3Set[_fn] = true;
                                        _discoveredNums.push(_fn);
                                        _added = true;
                                    }
                                }
                            }
                        }
                        if (_trashedNums.length) {
                            console.log('[quest-store] loadAllFloors: archived ' + _trashedNums.length + ' stale empty floor dir(s) to .trash (q' + questId + '): ' + _fmtNums(_trashedNums));
                        }
                        if (_orphanNums.length) {
                            console.log('[quest-store] loadAllFloors: skip ' + _orphanNums.length + ' orphan floor dir(s) (no all.json) in q' + questId + ': ' + _fmtNums(_orphanNums));
                        }
                        if (_discoveredNums.length) {
                            console.log('[quest-store] loadAllFloors: discovered ' + _discoveredNums.length + ' unindexed floor(s) from filesystem (q' + questId + '): ' + _fmtNums(_discoveredNums));
                        }
                        if (_added) {
                            floorList.sort(function (a, b) { return a.n - b.n; });
                            floorListFromFs = true;
                        }
                    } catch (_) { }
                }
            }
        }

        if (!floorList.length) return [];

        // ★ 并行加载所有楼层（N 层 = 1 个 await，而非 N 个串行排队）
        var self = this;
        var results = await Promise.all(floorList.map(function (f) {
            return self.loadFloor(questId, f.n, true).then(function (data) {
                return { floorNum: f.n, data: data };
            }).catch(function () {
                return { floorNum: f.n, data: null };
            });
        }));

        var floors = [];
        var missingFloorNums = [];
        for (var i = 0; i < results.length; i++) {
            if (results[i].data) {
                floors.push(results[i]);
            } else {
                missingFloorNums.push(results[i].floorNum);
            }
        }

        // ★ repair 并发竞态自愈（2026-08-08）：repairDuplicateIds 改名瞬间（f110→f114 等）
        //   loadAllFloors 并行读旧路径 → 瞬时 FAIL。等 repair 完成后清缓存重试一次，
        //   避免 70+ 条 FAIL + 两次 _rebuildQuestMeta（27 层 → 106 层）的噪音风暴。
        if (missingFloorNums.length && _repairLock) {
            try { await _repairLock; } catch (_) { }
            var _retryList = [];
            for (var ri = 0; ri < missingFloorNums.length; ri++) {
                delete _floorDirCache[questId + '\x00' + missingFloorNums[ri]];
                _retryList.push({ floorNum: missingFloorNums[ri] });
            }
            var _retryResults = await Promise.all(_retryList.map(function (f) {
                return self.loadFloor(questId, f.floorNum, true).then(function (data) {
                    return { floorNum: f.floorNum, data: data };
                }).catch(function () {
                    return { floorNum: f.floorNum, data: null };
                });
            }));
            var _stillMissing = [];
            for (var ri2 = 0; ri2 < _retryResults.length; ri2++) {
                if (_retryResults[ri2].data) floors.push(_retryResults[ri2]);
                else _stillMissing.push(_retryResults[ri2].floorNum);
            }
            missingFloorNums = _stillMissing;
        }

        // ★ 汇总打印（降噪：N 条逐行 warn → 1 行）
        if (missingFloorNums.length) {
            console.warn('[quest-store] loadAllFloors: ' + missingFloorNums.length + ' floor(s) listed but data missing in q' + questId + ': ' + _fmtNums(missingFloorNums) + ' — sq3 entries cleaned');
        }

        // ★ 清理失败的楼层 sq3 条目 + 重建 quest 元数据（仅包含成功加载的楼层）
        if (missingFloorNums.length) {
            var b2 = _bridge();
            if (b2) {
                for (var mi = 0; mi < missingFloorNums.length; mi++) {
                    try { await b2.del(FLOOR_NS + '.' + questId + '.' + missingFloorNums[mi]); } catch (_) { }
                }
            }
            await _rebuildQuestMetaFromFloors(questId, floors);
        } else if (floorListFromFs || !qData) {
            // ★ sq3 缺失时从 all.json 重建 quest 元数据（改名编号/备份还原 零损失）
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
        var questsDir = _rootDir + '/_qqq/quests';
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
        _setIdx(newIndex);
        await _setNow(INDEX_KEY, newIndex);
        if (_b && nextNumeric > 0) {
            try { await _b.setNow('quest_id_counter', nextNumeric); } catch (_e) { }
        }
        console.log('[quest-store] rebuildIndexFromFiles: rebuilt ' + newIndex.length + ' quest(s) from filesystem');
    };

    // ═══════════════════════════════════════════════════════════════
    // ★ 懒惰重命名扫描（B+ 方案）— 仅中面板执行，只在启动/关闭时运行
    //   只修不删，修不了就放弃。跳过正在建楼的 quest。
    // ═══════════════════════════════════════════════════════════════
    // ── 生成安全的目录名（与 panel-quest-ui.js _makeName 同构）──
    function _scanMakeName(prefix, num, text) {
        var MAX_BYTES = 100;
        if (!text) return prefix + num;
        var bytes = new TextEncoder().encode(text);
        var end = Math.min(MAX_BYTES, bytes.length);
        while (end > 0 && (bytes[end] & 0xC0) === 0x80) { end--; }
        var sanitized = new TextDecoder().decode(bytes.slice(0, end))
            .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
            .replace(/[\\\/:*?"<>|]/g, '_')
            .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
        sanitized = sanitized.replace(/^\.+/, '').replace(/\.+$/, '');
        var RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
        if (RESERVED.test(sanitized.toUpperCase()) || RESERVED.test(sanitized.toUpperCase().replace(/\..*/, ''))) {
            sanitized = '_' + sanitized;
        }
        if (!sanitized) return prefix + num;
        return prefix + num + '.' + sanitized;
    }

    // ── 扫描所有 quest，修正目录名与 DB title 不一致 ──
    // 返回值: { fixed, failed, skipped, collisions }
    QuestStore.prototype.lazyRenameScan = async function () {
        var result = { fixed: 0, failed: 0, skipped: 0, collisions: 0 };

        // ★ 仅中面板执行
        if (!_isMainPanel) return result;
        // ★ 防重入
        try {
            if (parent && parent.__qqq_renameScanDone) return result;
            if (parent && parent.__qqq_renameScanInProgress) return result;
            // ★ 跨实例互斥（2026-08-09）：repairDuplicateIds 在跑时绝不改名（共用 parent 级锁）
            if (parent && parent.__qqq_dirRenameLock) return result;
        } catch (_) { return result; }

        try { if (parent) { parent.__qqq_renameScanInProgress = true; parent.__qqq_dirRenameLock = true; } } catch (_) { }

        try {
            var bf = _bridgeFs();
            if (!bf || !_rootDir) return result;

            var questsDir = _rootDir + '/_qqq/quests/';
            var idx = _idx();
            if (!idx || !idx.length) return result;

            // ★ 获取正在建楼的 quest（跳过，防文件锁争用）
            var running = [];
            try { if (parent && parent.__qqq_getRunningQuests) running = parent.__qqq_getRunningQuests() || []; } catch (_) { }

            var diskList = [];
            try {
                var list = await bf.list(questsDir);
                for (var li = 0; li < list.length; li++) {
                    if (list[li].isDir) diskList.push(list[li].name);
                }
            } catch (_) { return result; }

            for (var i = 0; i < idx.length; i++) {
                var e = idx[i];

                // ★ 跳过正在建楼的 quest
                if (running.indexOf(e.id) >= 0) { result.skipped++; continue; }

                // ★ 跳过无 numericId 或草稿
                if (!e.numericId || e.numericId <= 0) { result.skipped++; continue; }

                // ★ 30s 宽限期：刚创建的 quest 可能 DB 已写但目录未建
                if (e.createdAt && (Date.now() - e.createdAt) < 30000) { result.skipped++; continue; }

                // ★ 按前缀匹配磁盘实际目录
                var currentName = null;
                var matches = [];
                for (var di = 0; di < diskList.length; di++) {
                    if (diskList[di].startsWith(e.id + '.')) {
                        matches.push(diskList[di]);
                    }
                }

                // ── COLLISION 检测：同前缀多目录 ──
                if (matches.length > 1) {
                    console.warn('[quest-store] lazyRenameScan COLLISION: ' + e.id + ' → ' + matches.join(', '));
                    result.collisions++;
                    // 保留与 DB title 最匹配的，或 floor 最多的，或第一个（按数量）
                    // 此时不自动删，只记日志，让 repairDuplicateIds 处理
                    result.skipped++;
                    continue;
                }

                // ★ 仅用户显式重命名（pendingRename）才改磁盘名（2026-08-09 根因修复）：
                //   磁盘目录名其余情况一律为唯一真理 —— 防 stale title（repair/备份还原残留）
                //   驱动改名 → 与 repairDuplicateIds 互搏（q168/q171 事故：改走又改回，每次启动 churn）
                if (!e.pendingRename) continue;

                if (matches.length === 1) currentName = matches[0];
                if (!currentName) { result.skipped++; continue; }

                var expectedName = _scanMakeName('q', e.numericId, e.title || '');
                if (currentName === expectedName) continue;  // 一致，无需改

                // ★ 尝试重命名
                var targetExists = false;
                try { targetExists = !!(await bf.stat(questsDir + expectedName)); } catch (_) { }
                if (targetExists) {
                    // 目标名已被占用（可能手动创建的）→ 放弃
                    console.warn('[quest-store] lazyRenameScan: target exists, skip rename', currentName, '→', expectedName);
                    result.failed++;
                    continue;
                }

                try {
                    await bf.rename(questsDir + currentName, questsDir + expectedName);
                    console.log('[quest-store] lazyRenameScan: renamed', currentName, '→', expectedName);
                    // ★ 同步缓存 + 清除 pendingRename + 持久化（原实现仅改内存，sq3 dirName 一直 stale）
                    _questDirCache[e.id] = expectedName;
                    if (e.dirName) e.dirName = expectedName;
                    e.pendingRename = false;
                    await _saveIndex();
                    result.fixed++;
                } catch (err) {
                    console.warn('[quest-store] lazyRenameScan: FAIL rename', currentName, '→', expectedName, (err && err.message) || err);
                    result.failed++;
                }
            }
        } finally {
            try {
                if (parent) {
                    parent.__qqq_renameScanInProgress = false;
                    parent.__qqq_renameScanDone = true;
                    parent.__qqq_renameScanResult = result;
                    parent.__qqq_dirRenameLock = false;
                }
            } catch (_) { }
        }
        return result;
    };

    return QuestStore;

})();
