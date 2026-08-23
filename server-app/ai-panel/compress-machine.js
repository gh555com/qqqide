// compress-machine.js — 上下文背包自动压缩机器（唯一真理源，2026-08-23）
//
// 三档滑杆（设置 → ai.compressLevel，defaults.js 唯一默认值）：
//   off    — 不自动压缩
//   medium — 楼层完结后自动 editOnly（收益 ≥ 64K tokens 一锅端）
//   full   — medium 阈值减半（≥ 32K）+ 自动 onlyFacts（原料 = 骨架 Q/A 行 ≥ 64K、距上次成功 ≥ 5
//            正常楼层、失败重试 ≤ 2 次/周期）
//
// 触发时机：
//   postFloor — 楼层完结 _rebuildBackpack 后（主，panel-pipeline.js finally 最末）
//   preFloor  — 下一楼层建立前（兜底，_executeSend 闸门后；仅 full 档 onlyFacts。
//               派发被 sending 闸门拒绝时无副作用——postFloor 自然补试）
//
// 定序（G5）：editOnly → onlyFacts（editOnly 过滤幂等，不影响 onlyFacts 原料；反序饿死）
//
// 守卫：
//   G1 冷却 — ctx.lastAutoExtract.floorNum 距当前 ≥ 5 正常楼层
//   G2 失败 — ctx.autoExtractFailures {floorNum,count} ≤ 2/周期；成功转正清零
//   G3 忙   — agent._stopState !== 'idle' 跳过（restore 中/手动压缩中天然覆盖）
//   G4 队列 — preFloor 判定 agent._queue 非空跳过（不插队用户排队消息）
//
// 唯一实现：估算/过滤/切半/解析全部在此文件；手动三按钮（panel-quest-ui.js handler +
// conv-ui.html computeBenefits）为跨 iframe 同步副本，注释互指（铁律 10.1 估算系数同款）。
(function () {
  'use strict';

  var CHAR_PER_TOKEN = 2.5;                                  // 与 ContentGateway.CHAR_PER_TOKEN 同步（铁律 10.1 禁改）
  var EDIT_ONLY_THRESHOLD = { medium: 64000, full: 32000 };  // editOnly 收益阈值 tokens
  var ONLY_FACTS_MATERIAL_MIN = 64000;                       // onlyFacts 原料阈值 tokens（2026-08-23 用户定案：原料 = 大 Q + 大 A，
                                                             //   editonly 过滤后骨架中 Q:/A: 行字符 ÷2.5；Q/A ≥ 64K ⇒ 切半 hText ≈ 32K，
                                                             //   与旧 32K 守卫触发时机等价，语义直白；三端同口径）
  var ONLY_FACTS_MIN_INTERVAL = 5;                           // 距上次成功提取 ≥ 5 正常楼层
  var ONLY_FACTS_MAX_RETRIES = 2;                            // 失败重试上限/周期，超限静默放弃
  var MIN_EDIT_ONLY_GAIN = 750;                              // 收益 < 300 tokens（750 chars）视为无可压缩
  var WRITE_TOOLS_RE = /\[A → (edit_file|write_file|create_file|delete_file|revert_file)\]/;

  // ── 档位 ──
  // ★ per-quest 独立压缩策略（2026-08-23）：agent._ctx.compressLevel 覆盖（ctx.json 持久化）
  //   优先于全局设置——勾选卡片「独立滴压缩策略」即写入，取消即删除回退全局。
  function getLevel(agent) {
    try {
      if (agent && agent._ctx && agent._ctx.compressLevel) {
        var ov = agent._ctx.compressLevel;
        if (ov === 'off' || ov === 'medium' || ov === 'full') return ov;
      }
    } catch (_) { }
    try {
      if (parent.window && parent.window.qqqSettings && parent.window.qqqSettings.get) {
        var v = parent.window.qqqSettings.get('ai.compressLevel');
        if (v === 'off' || v === 'medium' || v === 'full') return v;
      }
    } catch (_) { }
    return 'medium'; // 出厂默认中间档（2026-08-23 用户定案）
  }

  // ── 纯函数（唯一实现）──
  // 剥离 ╔K...╚ 绝对包装盒体部（保留头行，正则与 agent-context 同款）
  function stripAbsoluteBoxes(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\n╔K\n[\s\S]*?\n╚(?=\n|$)/g, '\n');
  }

  // editOnly 行过滤：仅保留 Q:/A:/=== F/[S]/空行/5 写工具头行
  function filterEditOnly(text) {
    if (!text) return text;
    var lines = text.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var keep = false;
      if (/^(Q:|A:|=== F|\[S\]|\s*$)/.test(line)) keep = true;
      if (WRITE_TOOLS_RE.test(line)) keep = true;
      if (keep) out.push(line);
    }
    return out.join('\n');
  }

  // editOnly 收益（tokens）= 原长 − 过滤后长
  function estimateEditOnlyGain(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.round((text.length - filterEditOnly(text).length) / CHAR_PER_TOKEN);
  }

  // onlyFacts 原料（2026-08-23 用户定案口径，守卫用）：editonly 过滤后骨架中 Q:/A: 行字符 ÷ 2.5
  //   ——「原料 = 大 Q + 大 A」：全部历史问答量 ≥ 64K tokens 才准许一次提取；
  //   在骨架上统计（非原始饼干）防 ╔K 体部内 'Q:' 开头的假行（工具输出可能含）。
  //   执行仍切半（splitFactsMaterial），守卫零切半零分块，一次正则扫描。
  function countFactsQA(text) {
    if (!text || typeof text !== 'string') return 0;
    // 先剥离绝对盒再行过滤（filterEditOnly 是纯行过滤不查 ╔K 块边界——工具输出里 'Q:' 开头的
    // 假行会漏进来；与手动 handler Step1→Step2 同序，conv-ui 同源）
    var t = stripAbsoluteBoxes(text);
    t = filterEditOnly(t);
    var lines = t.split('\n');
    var chars = 0;
    for (var i = 0; i < lines.length; i++) {
      if (/^(Q:|A:)/.test(lines[i])) chars += lines[i].length;
    }
    return Math.round(chars / CHAR_PER_TOKEN);
  }

  // onlyFacts 执行原料（与手动 handler Step1+2+3 同口径）：absolut 剥离 → editonly 过滤 → === F 块切半
  function splitFactsMaterial(text) {
    if (!text) return null;
    var t = stripAbsoluteBoxes(text);
    t = filterEditOnly(t);
    var blocks = t.split(/\n(?==== F\d+ )/);
    if (blocks.length < 2) return null;
    var total = 0;
    var lens = [];
    for (var i = 0; i < blocks.length; i++) { lens.push(blocks[i].length); total += blocks[i].length; }
    var half = Math.floor(total / 2);
    var acc = 0, splitIdx = 1;
    for (var j = 0; j < blocks.length; j++) {
      acc += lens[j];
      if (acc >= half) { splitIdx = j; break; }
    }
    if (splitIdx < 1) splitIdx = 1;
    var hText = blocks.slice(0, splitIdx).join('\n');
    var rText = blocks.slice(splitIdx).join('\n');
    return { hText: hText, rText: rText, materialTokens: Math.round(hText.length / CHAR_PER_TOKEN) };
  }

  // 本地 biscuitLines 解析（F52 教训：不依赖 agent-context IIFE 内函数）
  function parseBiscuitLines(text) {
    var parts = text.split(/\n(?==== F\d+ )/);
    var lines = [];
    for (var i = 0; i < parts.length; i++) {
      var pt = parts[i].trim();
      if (!pt) continue;
      var fm = pt.match(/^=== F(\d+)/);
      if (fm) lines.push({ n: parseInt(fm[1], 10), text: pt });
    }
    lines.sort(function (a, b) { return a.n - b.n; });
    return lines;
  }

  // ── editOnly 执行（纯本地零网络）──
  function tryEditOnly(agent, qid, thresholdTokens) {
    var conv = agent.conversation;
    for (var i = 0; i < conv.length; i++) {
      var m = conv[i];
      if (!m._biscuit || !m.content) continue;
      var gain = estimateEditOnlyGain(m.content);
      if (gain < MIN_EDIT_ONLY_GAIN || gain < thresholdTokens) return false;
      var before = m.content.length;
      m.content = filterEditOnly(m.content);
      if (m.content.length >= before) return false;
      try {
        if (agent._ctx) {
          agent._ctx.biscuitLines = parseBiscuitLines(m.content);
          agent._ctx.lastCompressedFloor = agent._ctx.totalFloors || agent._ctx.biscuitLines.length || 0;
          agent._ctx.narrative = 'biscuit:' + agent._ctx.biscuitLines.length;
        }
      } catch (_) { }
      try { if (typeof _writeCtxJson === 'function') _writeCtxJson(qid, agent._ctx).catch(function () { }); } catch (_) { }
      // 铁律 10.1 ⑥：清零同步 quest.sq3（防重启僵尸数字）
      try {
        agent._lastApiPromptTokens = 0;
        agent._lastApiTotalTokens = 0;
        agent._lastApiCompletionTokens = 0;
        if (typeof questStore !== 'undefined' && questStore.save) {
          questStore.save(qid, { lastApiPromptTokens: 0, lastApiTotalTokens: 0, lastApiCompletionTokens: 0 }).catch(function () { });
        }
      } catch (_) { }
      try { if (agent._log) agent._log('◆ AutoCompress: editOnly stripped ' + (before - m.content.length) + ' chars (gain ' + gain + ' tokens ≥ ' + thresholdTokens + ')'); } catch (_) { }
      return true;
    }
    return false;
  }

  // ── onlyFacts 守卫（pre/post 共用）──
  function onlyFactsGuard(agent) {
    var level = getLevel(agent);
    if (level !== 'full') return 'off';
    if (!agent || !agent._ctx) return 'noctx';
    if (agent._stopState !== 'idle') return 'busy';          // G3（restore 中/手动压缩中天然覆盖）
    var qa = 0;
    for (var i = 0; i < agent.conversation.length; i++) {
      var m = agent.conversation[i];
      if (m._biscuit && m.content) { qa = countFactsQA(m.content); break; }
    }
    if (qa <= 0) return 'material';
    if (qa < ONLY_FACTS_MATERIAL_MIN) return 'material';
    var lae = agent._ctx.lastAutoExtract;
    var curFloor = agent._ctx.totalFloors || agent._currentFloorNum || 0;
    if (lae && typeof lae.floorNum === 'number' && (curFloor - lae.floorNum) < ONLY_FACTS_MIN_INTERVAL) return 'cool'; // G1
    var af = agent._ctx.autoExtractFailures;
    if (af && af.floorNum === curFloor && af.count >= ONLY_FACTS_MAX_RETRIES) return 'fail';                            // G2
    return 'ok';
  }

  // ── pending 结算（提取楼层建成后，postFloor 调用）──
  //   成功 = ctx.facts 出现 extracted_at ≥ pending.at 的新条目；
  //   失败（网络中断等，楼层 fatal 无新事实）→ 失败计数 +1，超限清 pending 静默放弃。
  function settlePending(agent, qid) {
    try {
      var ctx = agent._ctx;
      if (!ctx || !ctx.autoExtractPending) return;
      var curFloor = ctx.totalFloors || 0;
      var pend = ctx.autoExtractPending;
      if (curFloor <= pend.fromFloor) return; // 提取楼层尚未建成，等下一边界
      var facts = ctx.facts || [];
      var newest = 0;
      for (var i = 0; i < facts.length; i++) {
        if (facts[i] && facts[i].extracted_at > newest) newest = facts[i].extracted_at;
      }
      if (newest >= pend.at) {
        ctx.lastAutoExtract = { floorNum: curFloor, at: Math.floor(Date.now() / 1000) };
        ctx.autoExtractFailures = null;
        ctx.autoExtractPending = null;
        try { if (agent._log) agent._log('◆ AutoCompress: onlyFacts succeeded (floor ' + curFloor + ')'); } catch (_) { }
      } else {
        var af = ctx.autoExtractFailures || {};
        if (!af.floorNum || af.floorNum !== pend.fromFloor) af = { floorNum: pend.fromFloor, count: 0 };
        af.count = (af.count || 0) + 1;
        ctx.autoExtractFailures = af;
        var gaveUp = af.count >= ONLY_FACTS_MAX_RETRIES;
        if (gaveUp) ctx.autoExtractPending = null;
        try { if (agent._log) agent._log('◆ AutoCompress: onlyFacts failed attempt ' + af.count + '/' + ONLY_FACTS_MAX_RETRIES + (gaveUp ? ' — giving up this window' : '')); } catch (_) { }
      }
      try { if (typeof _writeCtxJson === 'function') _writeCtxJson(qid, ctx).catch(function () { }); } catch (_) { }
    } catch (_) { }
  }

  // ── onlyFacts 触发（pre/post 共用）：守卫通过 → 记 pending → 派发手动链路 ──
  async function maybeAutoOnlyFacts(agent, qid, isPreFloor) {
    var g = onlyFactsGuard(agent);
    if (g !== 'ok') return;
    if (isPreFloor) {
      try { if (agent._queue && agent._queue.length > 0) return; } catch (_) { } // G4
    }
    var qa = 0;
    try {
      for (var i = 0; i < agent.conversation.length; i++) {
        var m = agent.conversation[i];
        if (m._biscuit && m.content) { qa = countFactsQA(m.content); break; }
      }
    } catch (_) { }
    try {
      agent._ctx.autoExtractPending = { at: Math.floor(Date.now() / 1000), fromFloor: agent._ctx.totalFloors || agent._currentFloorNum || 0 };
      // ★ 2026-08-23 F88: pending 立即落盘（重启/切档后 settlePending 才能结算；旧实现只写内存 → G1 冷却永不建立）
      if (typeof _writeCtxJson === 'function') _writeCtxJson(qid, agent._ctx).catch(function () { });
    } catch (_) { }
    try { if (agent._log) agent._log('◆ AutoCompress: onlyFacts triggered (QA material ' + qa + ' tokens, ' + (isPreFloor ? 'preFloor' : 'postFloor') + ')'); } catch (_) { }
    // ★ 2026-08-23 F88: 自动提取可见提示（q178 f87 实锤：楼层凭空出现用户无法理解，必须告知）
    try {
      if (window.parent && window.parent.qqqideQoast) {
        window.parent.qqqideQoast.show('自动压缩：已按全托管档位提取事实（仅此一次，5 层冷却内不再自动提取）', { type: 'info', duration: 6000 });
      }
    } catch (_) { }
    // 派发复用手动 handler 全链路（切半/写子弹/建楼层/tier-4 提取/注入 fx），
    // 被 sending 闸门拒绝时无副作用——postFloor 自然补试（前后双判定案）。
    try {
      window.postMessage({ type: 'qqq-compress-req', action: 'onlyfacts', questId: qid, auto: true }, '*');
    } catch (_) { }
  }

  // ── postFloor 主入口（panel-pipeline.js finally 最末调用）──
  async function maybeAutoCompress(agent, qid) {
    if (!agent || !agent._ctx) return;
    // ★ 2026-08-23 F88: settlePending 无条件善后（不再依赖 full 档）——pending 是过去触发的遗留，
    //   档位被用户切走/取消 per-quest 覆盖后若不结算，lastAutoExtract 永不记录 → G1 冷却失效
    //   （q178 f87 实锤：f86 完结自动 onlyFacts 成功，用户取消勾选 → 磁盘 lastAutoExtract=None）
    settlePending(agent, qid);
    var level = getLevel(agent);
    if (level === 'off') return;
    // G5 定序: editOnly → onlyFacts
    if (level === 'medium' || level === 'full') {
      tryEditOnly(agent, qid, EDIT_ONLY_THRESHOLD[level]);
    }
    if (level === 'full') {
      await maybeAutoOnlyFacts(agent, qid, false);
    }
  }

  // ── preFloor 兜底入口（_executeSend 闸门后调用，仅 full 档 onlyFacts）──
  async function maybeAutoOnlyFactsPreFloor(agent, qid) {
    var level = getLevel(agent);
    if (level !== 'full' || !agent || !agent._ctx) return;
    await maybeAutoOnlyFacts(agent, qid, true);
  }

  window.__qqqCompressMachine = {
    getLevel: getLevel,
    maybeAutoCompress: maybeAutoCompress,
    maybeAutoOnlyFactsPreFloor: maybeAutoOnlyFactsPreFloor,
    // 纯函数导出（手动路径未来收敛点）
    stripAbsoluteBoxes: stripAbsoluteBoxes,
    filterEditOnly: filterEditOnly,
    estimateEditOnlyGain: estimateEditOnlyGain
  };
})();
