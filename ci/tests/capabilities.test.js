// ci/tests/capabilities.test.js — 内置能力清单装配机（capabilities/*.md → 规则注入）
//   语义铁律：probe 命中才注入；载荷里没这件能力 → 提示自动消失（绝不指向空气）；旧文案行注入时屏蔽。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(ROOT, '_qqq', 'tmp', 'cap-test-' + process.pid);

function loadModule() {
  global.window = global;
  global.ContentGateway = { MAX_RESPONSE_TOKENS: 1024 };
  global.parent = {};
  global._qq = (k, d) => d;
  global._fmtTime = () => '2026-01-01 00:00:00';
  require(path.join(ROOT, 'server-app', 'ai-panel', 'system-prompt.js'));
  return global;
}

function fakeBridge(appRoot, dataDir) {
  return {
    app: { root: async () => appRoot },
    boot: { getInfo: async () => ({ userData: dataDir }) },
    fs: {
      stat: async (p) => { try { const st = fs.statSync(p); return { isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } },
      read: async (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
      list: async (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })); } catch { return []; } },
    },
  };
}

test('能力清单：载荷在役 → 注入且路径按本机实位解析', async () => {
  const g = loadModule();
  const caps = await g._loadQqqideCapabilities(fakeBridge(ROOT, path.join(ROOT, 'Data')));
  const readme = path.join(ROOT, 'server-app', 'ai-panel', 'webtools', 'README.md');
  assert.ok(fs.existsSync(readme), '前置：dev 树必须有 webtools/README.md');
  assert.ok(caps.text.includes('网页自动化'), '应在役并注入');
  assert.ok(caps.text.includes(readme.replace(/\\/g, '/')), '{{probe}} 应解析为绝对路径');
  assert.deepStrictEqual(caps.suppress, ['网页自动化（操作网站']);
});

test('能力清单：载荷被裁剪（probe 不存在）→ 零注入、零 suppress', async () => {
  const g = loadModule();
  fs.rmSync(TMP, { recursive: true, force: true });
  const capDir = path.join(TMP, 'server-app', 'capabilities');
  fs.mkdirSync(capDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server-app', 'capabilities', 'webtools.md'), path.join(capDir, 'webtools.md'));
  try {
    const caps = await g._loadQqqideCapabilities(fakeBridge(TMP, path.join(TMP, 'Data')));
    assert.strictEqual(caps.text, '', 'probe 缺失 → 不注入');
    assert.deepStrictEqual(caps.suppress, [], '未在役 → 不屏蔽任何行');
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

test('存量兼容：旧版写进用户规则的提示行注入时屏蔽，用户自己的规则一字不动', () => {
  const g = loadModule();
  const legacy = [
    '网页自动化（操作网站 / 填表 / 批量任务 / 登记申请等）：先读 D:/x/webtools/README.md，工具链在其同目录 kit/ 内。',
    '# 我的规则',
    'rule"D:/docs/a.md"',
  ].join('\n');
  const out = g._qqqStripSuppressed(legacy, ['网页自动化（操作网站']);
  assert.ok(!out.includes('网页自动化'), '旧提示行必须消失');
  assert.ok(out.includes('# 我的规则') && out.includes('rule"D:/docs/a.md"'), '用户规则原样保留');
});
