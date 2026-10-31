// ci/tests/entitlement-single-channel.test.js — 正版验证「唯一机器 / 唯一通道」回归守卫。
// 事故机制：激活状态现查（GET /api/me/goods）曾被多处消费方各写一遍（菜单行、设置中心、楼层守卫…），
//   各自的缓存窗口/在飞去重不同步 → 同一台机器上「本地说未激活 → 点 VIP 档误跳激活页」，
//   用户必须重启客户端才能解锁；且每加一个 VIP 功能就多一处请求策略。
// 守卫：① 服务端现查只有一个入口 = qqqEntitlement.refresh（真值层 login.checkPurchased 的唯一调用者）
//   ② 激活页 URL 只有一处硬编码 = core/entitlement.js
//   ③ 现查成本三闸在位（已激活短路 / 在飞复用 / 手势档与背景档合并窗常量单点）
//   ④ 激活页回来自解锁（openActivation 武装 + 回窗一次性核查）
//   ⑤ 激活判定的消费方一律走机器（禁自读 qqqLogin.isPurchased 另成一套）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const APP = path.join(R, 'server-app');
const ENT = fs.readFileSync(path.join(APP, 'core', 'entitlement.js'), 'utf8');
const LOGIN = fs.readFileSync(path.join(APP, 'core', 'login.js'), 'utf8');
const PREFS = fs.readFileSync(path.join(APP, 'core', 'qqq-prefs.js'), 'utf8');

function walk(dir, out) {
  out = out || [];
  const names = fs.readdirSync(dir, { withFileTypes: true });
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === 'node_modules' || d.name === 'locales' || d.name === '_ref') continue;
      walk(p, out);
    } else if (d.isFile() && /\.js$/.test(d.name)) {
      out.push(p);
    }
  }
  return out;
}
const rel = (p) => path.relative(APP, p).split(path.sep).join('/');
const FILES = walk(APP).map((p) => ({ rel: rel(p), src: fs.readFileSync(p, 'utf8') }));

test('唯一通道：checkPurchased 只允许真值层（login.js）定义 + 机器（entitlement.js）调用', () => {
  const offenders = [];
  for (const f of FILES) {
    if (f.rel === 'core/login.js' || f.rel === 'core/entitlement.js') continue;
    // 只看调用（`qqqLogin.checkPurchased(` / `.checkPurchased(`），注释里提到名字不算违规
    const code = f.src.replace(/^\s*\/\/.*$/gm, '');
    if (/\.checkPurchased\s*\(/.test(code)) offenders.push(f.rel);
  }
  assert.deepStrictEqual(offenders, [], '消费方绕开唯一机器直调 checkPurchased：' + offenders.join(', '));
});

test('唯一通道：现查请求（/api/me/goods）只在真值层出现', () => {
  const hits = FILES.filter((f) => /fetch\(\s*['"`]https:\/\/www\.gh555\.com\/api\/me\/goods/.test(f.src)).map((f) => f.rel);
  assert.deepStrictEqual(hits, ['core/login.js'], '激活状态探测请求出现在多处：' + hits.join(', '));
});

test('唯一通道：激活页 / 个人中心 URL 只有一处硬编码', () => {
  // 只认激活门两个锚点（#price = 激活页 / #profile = 个人中心）；落地页其它 tab（#docs / #season）非激活门
  const hits = FILES.filter((f) => /gh555\.com\/gaea\/d\/qqqide[^'"` ]*#(price|profile)/.test(f.src)).map((f) => f.rel);
  assert.deepStrictEqual(hits, ['core/entitlement.js'], '激活页 URL 硬编码出现在多处：' + hits.join(', '));
});

test('成本三闸：已激活短路 + 合并窗常量单点 + 在飞复用', () => {
  assert.match(ENT, /var GESTURE_MS = \d+;/, '缺少手势档合并窗常量');
  assert.match(ENT, /var AMBIENT_MS = \d+;/, '缺少背景档合并窗常量');
  assert.match(ENT, /if \(_purchased\(\)\) return Promise\.resolve\(true\);/, '缺少已激活短路（激活用户必须零请求）');
  assert.match(ENT, /!login \|\| !login\.checkPurchased \|\| !login\.isPurchased\) return Promise\.resolve\(_purchased\(\)\);/, '机器缺失时未短路本地真值');
  assert.match(LOGIN, /if \(self\._purchasedInFlight\) return self\._purchasedInFlight;/, '缺少在飞复用（并发只发一次）');
  assert.match(LOGIN, /_persistAuthAsync\(\);/, '查到激活未落盘（下次启动又变成零缓存）');
});

test('激活页回来自解锁：openActivation 武装 + 回窗一次性核查', () => {
  assert.match(ENT, /function _armReturn\(\)/, '缺少回窗核查武装');
  assert.match(ENT, /openActivation: function \(\) \{ _armReturn\(\); _open\(ACT_URL\); \}/, 'openActivation 未武装回窗核查');
  assert.match(ENT, /window\.addEventListener\('focus', kick\)/, '缺少回窗聚焦核查');
  assert.match(ENT, /document\.addEventListener\('visibilitychange', kick\)/, '缺少可见性回到前台核查');
  assert.match(ENT, /_armAt = 0;\s+\/\/ 一次性/, '回窗核查未撤武装（未激活会反复打服务端）');
});

test('消费方一律走机器：激活判定禁自读真值层', () => {
  assert.match(PREFS, /window\.qqqEntitlement\.isActivated\(\)/, '偏好层未走机器判定');
  assert.ok(!/function isActivated\(\) \{\s*\n\s*try \{\s*\n\s*if \(window\.qqqLogin && typeof window\.qqqLogin\.isPurchased/.test(PREFS),
    '偏好层回潮：自读 qqqLogin.isPurchased');
});
