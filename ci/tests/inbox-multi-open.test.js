// ci/tests/inbox-multi-open.test.js — inbox 多开（中间/右侧各一个）四道契约回归守卫。
// 事故机制（多开才有，单开永不复现）：
//   ① 连接翻倍：每个 inbox iframe 自建一条 WS（多开 2 个 = 窗口 3 条长连接）
//   ② 未读各算各的：A 读完 B 还是红的；打开第二个 tab 无条件把徽章清零
//   ③ 缓存互相覆盖：两个实例各自整包写 dm.cache.v1 → 后写的把另一实例翻页加载的老历史抹掉
//   ④ 布局丢失：custom tab 不持久化 → Ctrl+R 后多开布局全没了
// 守卫：唯一连接在父窗（dmBus）/ 徽章单一写者（实例真值并集−正在看的会话）/ 缓存写前并集 /
//   多开布局持久化（registerCustomTabRestorer）/ 非活动 tab 静默（_onVisible → dm:visible）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const APP = path.join(R, 'server-app');
const HOST = fs.readFileSync(path.join(APP, 'core', 'gaea-host.js'), 'utf8');
const UI = fs.readFileSync(path.join(APP, 'goods', 'dm', 'dm-ui.js'), 'utf8');
const DM = fs.readFileSync(path.join(APP, 'goods', 'dm', 'dm.js'), 'utf8');
const TABS = fs.readFileSync(path.join(APP, 'core', 'tab-manager.js'), 'utf8');

test('唯一连接：父窗声明 dmBus，实例在总线可用时不再自建 WS', () => {
  assert.match(HOST, /dmBus:\s*\{\s*version:\s*1\s*\}/, 'gaea-host 未暴露 dmBus 能力声明');
  assert.match(UI, /function _busOK\(\)\s*\{[\s\S]{0,160}parent\.qqqGaea\.dmBus/, 'dm-ui 未探测父窗总线');
  assert.match(UI, /if \(_bus\) \{\s*\n\s*_busSend\(\{ type: 'dm:hello' \}\);[\s\S]{0,200}\} else \{\s*\n\s*connectWS\(\);/, '连接路径未按总线二选一');
  // 自建 WS 只允许出现在 connectWS 定义处（唯一）+ 兜底调用；禁第二处 new WebSocket
  const wsNew = (UI.match(/new WebSocket\(/g) || []).length;
  assert.strictEqual(wsNew, 1, 'dm-ui 出现多处 new WebSocket（多开 = 连接翻倍）');
});

test('徽章单一写者：实例上报真值，父窗按「并集 − 正在看的会话」求和', () => {
  assert.match(HOST, /if \(!_dmClients\.length && dm\.sender_id !== _inboxDoerID\)/, '私聊徽章未被「有实例在场」门控');
  assert.match(HOST, /if \(!_dmClients\.length && msg\.data\.sender_id !== _inboxDoerID\)/, '群徽章未被「有实例在场」门控');
  assert.match(HOST, /_dmBroadcast\(\{ type: 'dm:push'/, 'WS 推送未转发给多开实例');
  assert.match(HOST, /if \(c\.active\) actives\[c\.active\] = 1;/, '徽章未排除各实例正在看的会话');
  assert.match(UI, /_busSend\(\{ type: 'dm:state', convs: convs, active: _activePeer \|\| '' \}\)/, '实例未上报未读真值表');
  assert.match(UI, /_busSend\(\{ type: 'dm:read', peer: peerID \}\)/, '打开会话未广播已读');
  // 旧「打开即全局清零」口径必须绝迹（它会把别人的未读一起抹掉）
  assert.ok(!/resetInboxUnread/.test(UI), 'dm-ui 回潮：仍在调 resetInboxUnread 硬清零徽章');
  assert.ok(!/resetInboxUnread/.test(HOST), 'gaea-host 回潮：resetInboxUnread 未删除（第二套清零入口）');
});

test('缓存写前并集：另一实例翻页加载的老历史不被整包覆盖', () => {
  assert.match(UI, /var _raw0 = localStorage\.getItem\(_CACHE_KEY\)/, '缓存写入未读旧值');
  assert.match(UI, /msgs\[pid\] = _mergeMsgs\(old, msgs\[pid\] \|\| \[\]\)\.slice\(-_CACHE_MAX_PER_CONV\)/, '消息缓存未并集合并');
  assert.match(UI, /convs\[pid\] = _mergeConv\(prev\.convs\[pid\], convs\[pid\]\)/, '会话缓存未合并');
});

test('多开布局持久化：custom tab 收集 + 恢复器 + 回原组 + 会话还原', () => {
  assert.match(TABS, /function _collectCustomTabs\(\)/, 'tab-manager 未收集 custom tab');
  assert.match(TABS, /if \(!t\.customId \|\| !_customRestorers\[t\.customId\]\) continue;/, 'custom tab 收集未按恢复器白名单过滤');
  assert.match(TABS, /db\.set\('editor\.customTabs', custom\)/, 'custom tab 未落盘');
  assert.match(TABS, /db\.get\('editor\.customTabs'\)/, 'custom tab 未恢复');
  assert.match(TABS, /registerCustomTabRestorer,/, '恢复器注册入口未导出');
  assert.match(TABS, /typeof opts\.groupIdx === 'number'/, 'openFileCustomTab 不支持回原组');
  assert.match(DM, /registerCustomTabRestorer\('inbox'/, 'dm.js 未注册 inbox 恢复器');
  assert.match(DM, /tab\.getState = function \(\) \{ return \{ peer: curPeer \}; \};/, 'dm.js 未提供会话快照');
  assert.match(DM, /iframe\.src = '\/qqqide\/goods\/dm\/dm-ui\.html' \+ \(o\.peer \?/, '恢复未把 peer 带进 iframe');
  assert.match(UI, /location\.search\.match\(\/\[\?&\]peer=\(\[\^&\]\*\)\/\)/, 'dm-ui 未消费 ?peer=');
});

test('非活动 tab 静默：可见性事件驱动，切走零渲染零轮询', () => {
  assert.match(DM, /self\._onVisible = function \(v\) \{/, 'dm.js 未接可见性事件');
  assert.match(DM, /\{ type: 'dm:visible', visible: !!\(tb && tb\.active\) \}/, 'dm.js 未下发初始可见性');
  assert.match(UI, /if \(d\.type === 'dm:visible'\) \{ _setQuiet\(!d\.visible\); \}/, 'dm-ui 未消费可见性');
  assert.match(UI, /if \(_quiet\) \{ _dirtyRender = true; return; \}\s*\/\/ 非活动 tab：数据先存，切回再画/, 'renderConvList 缺静默守卫');
  assert.match(UI, /if \(_quiet\) \{ _dirtyRender = true; return; \}\s*\/\/ 非活动 tab：只入缓存不碰 DOM/, 'appendBubble 缺静默守卫');
  assert.match(UI, /if \(_quiet\) return true;/, 'isHidden 未纳入非活动态（后台轮询仍会跑）');
});

test('贴底跟随：只看底部才自动跟随，翻历史时只计数不抢滚动条', () => {
  assert.match(UI, /function _followOrPill\(\)/, '缺少贴底跟随裁决');
  assert.match(UI, /if \(_followBottom\) \{ scrollBottom\(\); return; \}/, '贴底判断缺失');
  assert.match(UI, /\$msgList\.addEventListener\('scroll'/, '缺少滚动位置跟踪');
  assert.match(UI, /id="new-msg-pill"|getElementById\('new-msg-pill'\)/, '缺少新消息浮标');
  // 加载更早必须保持视野（旧实现恒 scrollBottom → 一翻页就跳到底）
  assert.match(UI, /renderMessages\(peerID, \{ keepScroll: true \}\)/, '加载更早未保持滚动位置');
});
