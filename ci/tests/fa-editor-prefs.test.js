// ci/tests/fa-editor-prefs.test.js — 编辑器域文件关联族 + 偏好存储位置（源级契约测试）
// 对象: shell/fa-editor.ts（族定义唯一真理源 / 偏好目录）· shell/ipc-fileassoc.ts（媒体族）· locales/zh.json
// 语义锚:
//   ① 族 = 72 类文本/代码，五组；网页族（.html/.htm 及其族亲）永不入族（归属=浏览器，夺来 = 用户上不了网）
//   ② 与媒体族零交集（两域同写 PlayerCapabilities\FileAssociations，交集会让一域归还另一域）
//   ③ 偏好/状态存 OS 级共享目录（getOsBaseDir()/qqqide）——放实例 Data 会分裂成两份真值
//      （dev 实例读不到绿色包的「不参与」勾选 → 把用户关掉的类型重新注册回候选面）
// 结构契约破坏（数组消失/分组改名/路径回潮）→ 测试红，不许静默。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FA_EDITOR = path.join(ROOT, 'shell', 'fa-editor.ts');
const FA_MEDIA = path.join(ROOT, 'shell', 'ipc-fileassoc.ts');
const ZH = path.join(ROOT, 'server-app', 'locales', 'zh.json');

function readSrc(p) {
  if (!fs.existsSync(p)) throw new Error(p + ' missing — structure contract broken');
  return fs.readFileSync(p, 'utf8');
}

function groupsOf(src) {
  const m = /export const EDITOR_ASSOC_GROUPS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!m) throw new Error('EDITOR_ASSOC_GROUPS not found in shell/fa-editor.ts');
  const out = [];
  const re = /\{\s*id:\s*'([^']+)',\s*exts:\s*\[([^\]]*)\]/g;
  let g;
  while ((g = re.exec(m[1]))) {
    const exts = (g[2].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
    out.push({ id: g[1], exts });
  }
  return out;
}

function mediaOf(src) {
  const m = /export const MEDIA_ASSOC_EXTS: string\[\] = \[([\s\S]*?)\n\];/.exec(src);
  if (!m) throw new Error('MEDIA_ASSOC_EXTS not found in shell/ipc-fileassoc.ts');
  return (m[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1).toLowerCase());
}

test('fa-editor 族: 五组 72 类 · 无重复 · 全小写点号', () => {
  const groups = groupsOf(readSrc(FA_EDITOR));
  assert.deepEqual(groups.map((g) => g.id), ['text', 'config', 'web', 'lang', 'misc'], '分组 id/顺序是 UI 契约（1 by 1 面板按此渲染）');
  const all = [];
  for (const g of groups) {
    assert.ok(g.exts.length > 0, 'group ' + g.id + ' 空族');
    for (const e of g.exts) {
      assert.match(e, /^\.[a-z0-9]+$/, '扩展名必须小写点号开头: ' + e + '（组 ' + g.id + '）');
      all.push(e);
    }
  }
  assert.equal(all.length, 72, '族总数变了 → 同步 locales 的 72 文案与 arch/doc');
  const dup = all.filter((e, i) => all.indexOf(e) !== i);
  assert.deepEqual(dup, [], '重复扩展名（会重复计数/重复注册）: ' + dup.join(','));
});

test('fa-editor 族: 网页族永不入族（夺来 = 用户上不了网）', () => {
  const all = groupsOf(readSrc(FA_EDITOR)).reduce((a, g) => a.concat(g.exts), []);
  for (const web of ['.html', '.htm', '.xhtml', '.shtml', '.mht', '.mhtml']) {
    assert.equal(all.indexOf(web), -1, web + ' 不该在编辑器族（浏览器归属）');
  }
});

test('fa-editor 族 与 媒体族 零交集（两域共写同一 Capabilities 表）', () => {
  const editor = groupsOf(readSrc(FA_EDITOR)).reduce((a, g) => a.concat(g.exts), []);
  const media = mediaOf(readSrc(FA_MEDIA));
  assert.ok(media.length > 0, '媒体族解析为空——结构契约破坏');
  const both = editor.filter((e) => media.indexOf(e) >= 0);
  assert.deepEqual(both, [], '同一扩展名同属两域（一域归还会拆掉另一域候选面）: ' + both.join(','));
});

test('fa-editor 偏好: 存 OS 级共享目录（禁回潮到实例 Data）', () => {
  const src = readSrc(FA_EDITOR);
  assert.match(src, /function _faStoreDir\(\): string \{[\s\S]*?getOsBaseDir\(\)/, '_faStoreDir 必须基于 getOsBaseDir()（跨实例唯一）');
  assert.match(src, /function _prefsFile\(\): string \{ return path\.join\(_faStoreDir\(\)/, 'prefs 必须落 _faStoreDir()');
  assert.match(src, /const stateFile = path\.join\(_faStoreDir\(\), 'fa-editor-state\.json'\)/, 'state 必须落 _faStoreDir()');
  assert.match(src, /_faMigrateOnce\(\)/, '旧位置一次性迁移必须保留（丢偏好 = 用户关掉的类型被重新注册）');
});

test('fa-editor 自愈: 开发态不自动写系统关联（防把 .txt 指向 electron.exe）', () => {
  const src = readSrc(FA_EDITOR);
  const m = /export function startEditorAssocHeal\(\): void \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'startEditorAssocHeal not found');
  assert.match(m[1], /if \(!app\.isPackaged\) \{ return; \}/, 'startEditorAssocHeal 必须拦开发态（否则每次开发启动都会重写用户系统关联）');
});

test('fa-editor 1 by 1 分组名: zh.json 覆盖全部五组', () => {
  const j = JSON.parse(fs.readFileSync(ZH, 'utf8'));
  const g = j.settings && j.settings.faEditor && j.settings.faEditor.group;
  assert.ok(g && typeof g === 'object', 'settings.faEditor.group 缺失');
  for (const id of ['text', 'config', 'web', 'lang', 'misc']) {
    assert.ok(typeof g[id] === 'string' && g[id].length > 0, 'zh.json 缺组名: ' + id);
  }
});
