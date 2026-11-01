// ci/tests/page-deploy.test.js — 页面发布域结构守卫（2026-11-01 q449）。
// 守的是什么（每一条都对应一次「看起来能用、其实是另一个东西」的退化）：
//   ① 入口只在 Roam 右键（线下首行），恒在分组线之后、恒无快捷键文本 —— 不许混进线上有键组。
//   ② 文件类动作的宿主是主窗口模态：Roam 只发意图（postMessage），禁自己在 iframe 里造面板。
//   ③ 默认勾选 = 引用集，不是整目录（整目录会把草稿/notes 推上公网 = 泄露；少发只是残页）。
//   ④ 不新造上传器：其它文件一律走 bed 网页，「发布」只有 reserve→PUT→create 一条路。
//   ⑤ 客户端上限常量与服务端同值（5 MiB）：客户端只做早提示，但两边漂移会让提示变成谎话。
//   ⑥ i18n：deploy.* 引用键必须在 zh.json 里存在（禁裸 key 上屏）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROAM_HTML = read('server-app/goods/file-explorer/q2-roam.html');
const ROAM_JS = read('server-app/goods/file-explorer/q2-roam.js');
const ROAM_UI = read('server-app/goods/file-explorer/q2-roam-ui.js');
const RPC = read('server-app/core/shell-rpc.js');
const DEPLOY = read('server-app/core/page-deploy.js');
const ZH = JSON.parse(read('server-app/locales/zh.json'));
// 服务端同源文件（两侧同机开发；缺失时降级为只验客户端常量，禁因跨目录而误红）
let GO = '';
try { GO = read('../gaea/internal/http/site_deploy.go'); } catch (_) { GO = ''; }

test('页面发布：入口行在分组线之后、且无快捷键文本（线下首行）', () => {
    const sep = ROAM_HTML.indexOf('data-sep="nokey"');
    const pub = ROAM_HTML.indexOf('data-action="publish"');
    const bed = ROAM_HTML.indexOf('data-action="bedlink"');
    assert.ok(sep > 0 && pub > sep, 'publish 行必须排在无快捷键分组线之后');
    assert.ok(bed > pub, 'bed 取链行紧随其后');
    const row = ROAM_HTML.slice(pub - 60, pub + 260);
    assert.ok(/context-menu-shortcut"><\/span>/.test(row), '发布行必须不含快捷键文本（= 线下组）');
});

test('页面发布：Roam 只发意图，宿主是主窗口模态（禁在 iframe 里造第二套面板）', () => {
    assert.ok(ROAM_JS.indexOf("type: 'qqq-deploy-publish'") > 0, 'Roam 必须经 postMessage 发意图');
    assert.ok(ROAM_UI.indexOf("case 'publish':") > 0 && ROAM_UI.indexOf('_deployPublish(') > 0, '点击分派必须落到 _deployPublish');
    assert.ok(RPC.indexOf("e.data.type === 'qqq-deploy-publish'") > 0, '主窗口必须收该消息');
    assert.ok(RPC.indexOf('window.qqqPageDeploy.open(') > 0, '主窗口唯一承接者 = qqqPageDeploy.open');
    assert.ok(DEPLOY.indexOf('if (window.top !== window) return;') > 0, 'page-deploy.js 只在主窗口存在（iframe 里不跑）');
    const panel = read('server-app/ai-panel/index.html');
    assert.ok(panel.indexOf('qqq-deploy') < 0, 'AI 面板禁挂页面发布（文件类动作的宿主是主窗口）');
});

test('页面发布：默认勾选 = 引用集（不是整目录）', () => {
    assert.ok(DEPLOY.indexOf('function defaultSet(') > 0, '必须有引用集扫描');
    assert.ok(/st\.sel = d\.sel/.test(DEPLOY), '默认选中必须来自引用扫描结果');
    assert.ok(DEPLOY.indexOf("sel[entry] = 1") > 0, '入口必选');
    // 整目录只能在高级里由用户显式勾（全选），禁作为默认
    assert.ok(DEPLOY.indexOf('var allOn = st.selCount === st.files.length') > 0, '全选只存在于文件清单的显式操作里');
});

test('页面发布：不新造上传器（唯一路径 reserve → PUT → create；其它文件走 bed 网页）', () => {
    assert.ok(DEPLOY.indexOf("api('/deploy/reserve'") > 0, '上传必须经 reserve');
    assert.ok(DEPLOY.indexOf("api('/deploy/create'") > 0, '必须经 create 落租约');
    assert.ok(DEPLOY.indexOf('/api/upload') < 0, '禁出现 bed 上传接口（第二套上传器 = 出城口）');
    assert.ok(DEPLOY.indexOf('/gaea/d/bed') > 0, '非页面文件唯一去处 = bed 网页');
});

test('页面发布：客户端上限与服务端同值（5 MiB）+ 宿主路径前缀一致', () => {
    const m = DEPLOY.match(/MAX_SITE\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    assert.ok(m, '客户端必须有 MAX_SITE 常量');
    assert.strictEqual(Number(m[1]), 5, '客户端单页上限必须是 5 MiB');
    if (GO) {
        assert.ok(/siteTrialMaxSite\s*=\s*5\s*<<\s*20/.test(GO), '服务端单页上限必须同为 5 MiB');
        assert.ok(/sitePathPrefix\s*=\s*"\/d"/.test(GO), '宿主前缀恒 /d（与 /p 的五条隔离理由见 arch/分享 §3.3）');
    }
    assert.ok(DEPLOY.indexOf("https://www.gh555.com") > 0, '写请求/链接宿主恒 www（灰云直连，禁 apex 边缘超时）');
});

test('页面发布：路径保真 —— 上传路径不做大小写折叠或重命名', () => {
    assert.ok(DEPLOY.indexOf('function relOf(') > 0, '相对路径必须由发布根裁剪得出');
    const idx = DEPLOY.indexOf('files: ready.map(');
    assert.ok(idx > 0, 'reserve 必须提交逐文件原相对路径');
    const chunk = DEPLOY.slice(idx, idx + 200);
    assert.ok(chunk.indexOf('toLowerCase') < 0 && chunk.indexOf('.toUpperCase') < 0, '上传路径禁改写大小写');
});

test('页面发布：deploy.* 引用键全部存在于 zh.json（禁裸 key 上屏）', () => {
    const used = new Set();
    const re = /T\('([a-zA-Z0-9_.]+)'/g;
    let m;
    while ((m = re.exec(DEPLOY))) used.add(m[1]);
    assert.ok(used.size > 20, 'page-deploy.js 必须有成规模的词条引用');
    const missing = [];
    used.forEach(function (k) {
        let cur = ZH;
        k.split('.').forEach(function (seg) { cur = cur && cur[seg]; });
        if (typeof cur !== 'string') missing.push(k);
    });
    assert.deepStrictEqual(missing, [], '缺译：' + missing.join(','));
});
