// ci/tests/share-assets.test.js — 分享图片资产域回归守卫（2026-10-29 q449）。
// 守的是什么：
//   ① 提问气泡里的图片必须进快照（旧实现取提问原文只用 textContent，而 <img> 对 textContent 恒为空串
//      → 提问里贴的图 100% 丢失且不报错——这正是用户实测「分享出去的病历单截图没了」的根因）。
//   ② 图片只以 asset:N 形态进快照（与分享 id 解耦），字节只经资产域（reserve → 直传 → create 绑定）。
//   ③ 失败要说得出口：传不上的图从快照里整行剔除并向作者报数（禁裂图、禁静默）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'ai-panel', 'share-machine.js'), 'utf8');

const B64_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const B64_JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDQ0NDP/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmwA/9k=';

function load(opts) {
  opts = opts || {};
  const calls = { reserve: null, puts: [], fetchCount: 0 };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.TextEncoder = TextEncoder;
  sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
  sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
  sandbox.Blob = class { constructor(parts, o) { this.size = parts.reduce((a, p) => a + p.length, 0); this.type = o && o.type; } };
  sandbox.Image = class {
    set src(_v) { if (this.onload) setTimeout(() => this.onload(), 0); }
    get naturalWidth() { return 10; }
    get naturalHeight() { return 20; }
  };
  sandbox.crypto = globalThis.crypto;
  sandbox.parent = {
    qqqLogin: { getAuthToken: () => 'tk' },
    qqqideBridge: { fs: { readBase64: async (p) => ({ base64: (opts.files || {})[p] || '' }) } }
  };
  sandbox.fetch = async (url, init) => {
    calls.fetchCount++;
    if (String(url).endsWith('/share/asset/reserve')) {
      calls.reserve = JSON.parse(init.body);
      const items = calls.reserve.items.map((it) => ({
        n: it.n, uid: 'uid' + String(it.n).padStart(17, '0'), put_url: 'https://r2.example/' + it.n, mime: it.mime, expires_in: 900
      }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, items }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  sandbox.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; }
    open(m, url) { this._url = url; }
    setRequestHeader() { }
    send() {
      calls.puts.push(this._url);
      const self = this;
      setTimeout(() => {
        self.status = (opts.failPut && opts.failPut(self._url)) ? 500 : 200;
        if (self.onload) self.onload();
      }, 0);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'share-machine.js' });
  return { S: sandbox.window.QqqShare, calls };
}

function b64Img(v, mime, name) {
  return { kind: 'b64', v: v, mime: mime, name: name };
}

test('分享图片：提问气泡图 + md 内 file:/// 图 → 同一条资产路，快照只写 asset:N', async () => {
  const { S, calls } = load({ files: { 'E:/p/shot.png': B64_PNG } });
  const items = [
    {
      role: 'q', n: 1, md: '看这张 [img:1] 和这张 [img:2]',
      imgs: [
        { id: 1, name: 'a.png', ref: b64Img(B64_PNG, 'image/png', 'a.png') },
        { id: 2, name: 'b.jpg', ref: b64Img(B64_JPG, 'image/jpeg', 'b.jpg') }
      ]
    },
    { role: 'a', n: 1, md: '结果如下\n\n![截图](file:///E:/p/shot.png)' }
  ];

  const list = S.listImages(items);
  assert.strictEqual(list.length, 3, '三张图必须全部被发现（提问两张 + 正文一张）');

  const prep = await S.prepareAssets(items, { tier: 'trial' });
  assert.strictEqual(prep.assets.length, 3, '三张图都必须拿到资产槽');
  assert.strictEqual(prep.count, 3);
  assert.deepStrictEqual(calls.reserve.items.map((x) => x.n), [1, 2, 3], '槽号必须从 1 连续编号');
  assert.strictEqual(calls.puts.length, 3, '每张图各直传一次');

  const q = prep.items.find((x) => x.role === 'q');
  assert.strictEqual(q.md, '看这张 ![a.png](asset:1) 和这张 ![b.jpg](asset:2)', '[img:N] 令牌必须就地换成 asset:N');
  const a = prep.items.find((x) => x.role === 'a');
  assert.strictEqual(a.md, '结果如下\n\n![截图](asset:3)', 'md 内 file:/// 必须换成 asset:N（禁残留本机路径）');
});

test('分享图片：逐张取消 → 既不直传也不进快照（令牌一并消失）', async () => {
  const { S, calls } = load();
  const items = [{
    role: 'q', n: 1, md: '甲 [img:1] 乙 [img:2]',
    imgs: [
      { id: 1, name: 'a.png', ref: b64Img(B64_PNG, 'image/png', 'a.png') },
      { id: 2, name: 'b.jpg', ref: b64Img(B64_JPG, 'image/jpeg', 'b.jpg') }
    ]
  }];
  const key = S.listImages(items)[0].key;
  const prep = await S.prepareAssets(items, { tier: 'trial', drop: { [key]: 1 } });
  assert.strictEqual(prep.assets.length, 1, '取消的那张不得上传');
  assert.strictEqual(calls.puts.length, 1);
  assert.strictEqual(prep.items[0].md, '甲  乙 ![b.jpg](asset:1)', '取消的令牌须移除，保留的图重新编号');
});

test('分享图片：直传失败 → 该图从快照整行剔除并计入 failed（禁裂图 / 禁静默）', async () => {
  const { S } = load({ files: { 'E:/p/b.png': B64_PNG }, failPut: (url) => String(url).endsWith('/2') });
  const items = [
    { role: 'q', n: 1, md: '一 [img:1]', imgs: [{ id: 1, name: 'a.png', ref: b64Img(B64_PNG, 'image/png', 'a.png') }] },
    { role: 'a', n: 1, md: '二\n\n![x](file:///E:/p/b.png)' },
    { role: 'sel', n: 1, md: '', imgs: [{ id: 0, name: 'c.png', ref: b64Img(B64_JPG, 'image/jpeg', 'c.png') }] }
  ];
  const prep = await S.prepareAssets(items, { tier: 'trial' });
  assert.strictEqual(prep.failed.length, 1, '恰好一张失败（必须如实报数）');
  assert.strictEqual(prep.assets.length, 2, '只有成功直传的图才拿到槽');
  assert.strictEqual(prep.items.find((x) => x.role === 'a').md, '二', '失败图必须整行剔除（不留裂图）');
  assert.strictEqual(prep.items.find((x) => x.role === 'q').md, '一 ![a.png](asset:1)');
});

// ── 回答正文的图（2026-10-29 q449）：DOM 是第二真相源 ──────────────────────
// 守的是什么：a) 回答里渲染出来的图即使不在 markdown 里（工具卡/历史楼/无 _rawMarkdown）也必须带得走；
//   b) 同一张图（md 图片位 + DOM 渲染）只能上传一次、只能出现一次；
//   c) <…> 尖括号与裸盘符写法必须与 file:/// 同等待遇——漏认就会被脱敏规则换成占位符而静默消失。
function fakeImgEl(src) {
  return { getAttribute: () => src, dataset: {}, style: {} };
}
function fakeAi(imgs, rawMd) {
  const wrapper = {
    classList: { contains: (c) => c === 'msg-ai' },
    querySelectorAll: (sel) => (String(sel).indexOf('img') >= 0 ? imgs : []),
    _rawMarkdown: rawMd,
    _contentWrap: { querySelectorAll: () => [] }
  };
  const holder = { children: [] };
  wrapper.parentNode = holder;
  holder.children.push(wrapper);
  return wrapper;
}

test('分享图片：回答 DOM 里的图（不在 markdown 内）必须带得走', async () => {
  const { S } = load({ files: { 'E:/p/doc.png': B64_PNG, 'E:/p/wide name.png': B64_JPG } });
  const ai = fakeAi([fakeImgEl('file:///E:/p/doc.png'), fakeImgEl('file:///E:/p/wide%20name.png')], '正文里没有图片位');
  const items = S.collect(ai, 0);
  const a = items.find((x) => x.role === 'a');
  assert.ok(a && a.imgs && a.imgs.length === 2, '回答里的两张图必须被采集');

  const prep = await S.prepareAssets(items, { tier: 'trial' });
  assert.strictEqual(prep.count, 2);
  assert.strictEqual(
    prep.items.find((x) => x.role === 'a').md,
    '正文里没有图片位\n\n![doc.png](asset:1)\n![wide name.png](asset:2)',
    '未被正文引用的图必须追到条目末尾（读者看得到 = 带得走）'
  );
});

test('分享图片：同一张图（md 图片位 + DOM）只传一次、只出现一次', async () => {
  const { S, calls } = load({ files: { 'E:/p/pic.png': B64_PNG } });
  const ai = fakeAi([fakeImgEl('file:///E:/p/pic.png')], '图在下面\n\n![截图](file:///E:/p/pic.png)');
  const items = S.collect(ai, 0);
  assert.strictEqual(S.listImages(items).length, 1, '同一张图（md + DOM）不得算作两张');
  // 键归一还须容大小写/斜杠差异（Windows 路径不分大小写）：只能算一张，且不因此改变读取路径
  assert.strictEqual(
    S.listImages([{ role: 'a', n: 1, md: '![x](file:///E:/p/PIC.png)', imgs: [{ id: 1, ref: { kind: 'path', v: 'E:\\p\\pic.png', mime: 'image/png', name: 'pic.png' } }] }]).length,
    1,
    '大小写/斜杠差异不得算作两张图'
  );
  const prep = await S.prepareAssets(items, { tier: 'trial' });
  assert.strictEqual(calls.puts.length, 1, '同一张图只直传一次');
  assert.strictEqual(prep.items[0].md, '图在下面\n\n![截图](asset:1)', '不得在末尾重复追加已就位的图');
});

test('分享图片：尖括号与裸盘符写法同样识别（漏认=图片被脱敏成占位符）', async () => {
  const { S } = load({ files: { 'E:/p/a b.png': B64_PNG, 'E:\\p\\c.png': B64_JPG } });
  const items = [
    { role: 'a', n: 1, md: '甲\n\n![甲](<file:///E:/p/a b.png>)' },
    { role: 'a', n: 2, md: '乙\n\n![乙](E:\\p\\c.png)' }
  ];
  assert.strictEqual(S.listImages(items).length, 2, '两种写法都必须被发现');
  const prep = await S.prepareAssets(items, { tier: 'trial' });
  assert.ok(prep.items[0].md.endsWith('![甲](asset:1)'), '尖括号（含空格/中文路径）须换成 asset:N');
  assert.ok(prep.items[1].md.endsWith('![乙](asset:2)'), '裸盘符路径须换成 asset:N');
});

test('分享图片：图片文件源（md 为空）→ 生成 asset:N 图片行；单图超限 → 明确拒绝', async () => {
  const { S } = load();
  const items = [{ role: 'doc', n: 1, name: 'c.png', md: '', imgs: [{ id: 0, name: 'c.png', ref: b64Img(B64_PNG, 'image/png', 'c.png') }] }];
  const prep = await S.prepareAssets(items, { tier: 'trial' });
  assert.strictEqual(prep.items[0].md, '![c.png](asset:1)', '图片文件源必须变成一条图片行');

  // 超过单图上限（base64 字符数 ≈ 原始字节 × 4/3）→ prepareAssets 必须拒绝而不是硬传
  const huge = 'A'.repeat(Math.ceil(16 * 1024 * 1024 * 4 / 3) + 1024);
  await assert.rejects(
    () => S.prepareAssets([{ role: 'doc', n: 1, name: 'big.png', md: '', imgs: [{ id: 0, name: 'big.png', ref: b64Img(huge, 'image/png', 'big.png') }] }], { tier: 'trial' }),
    /单张上限|太大/,
    '超过单图上限必须明确拒绝'
  );
});
