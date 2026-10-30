// ci/tests/file-url.test.js — 本机路径 → file URL 唯一机器（core/file-url.js）回归守卫
// 背景（2026-10-30 q466）：旧写法处处 'file:///' + path。
//   Windows 路径 E:/x/a.png → file:///E:/x/a.png 恰好正确；POSIX 绝对路径 /Users/q/a.png
//   → file:////Users/q/a.png —— 第 4 个斜杠起被 URL 解析器当 authority（主机名）：
//   Chromium 实测 new URL('file:////Users/q/a b.png').href === 'file://users/q/a%20b.png'
//   （主机 = users）。file URL 带非空主机在 POSIX 一律拒载 → mac/Linux 上本机媒体全灭。
// 本测试同时守四件事：
//   ① 输出恒为三斜杠规范式（POSIX 主机段必须为空、Windows 盘符冒号保留）；
//   ② UNC 走主机段；# ? % 与空格/中文逐段转义；
//   ③ 幂等（已是 file URL 原样返回）；
//   ④ 消费方零副本（禁再手拼 'file:///' + path；载入页必须引 core/file-url.js）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const toUrl = require(path.join(ROOT, 'server-app', 'core', 'file-url.js'));

/** 主机段（file:// 与第一个 / 之间的部分）；空串 = 无主机 = POSIX 可加载 */
function codeOnly(src) {
    // 只扫代码：注释里举例说明旧写法不该被当违规
    return src.split('\n').filter((l) => {
        const s = l.trim();
        return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'));
    }).join('\n');
}

function hostOf(url) {
    const m = /^file:\/\/([^/]*)/i.exec(url);
    return m ? m[1] : '<不匹配>';
}

test('Windows 盘符：三斜杠 + 冒号保留 + 斜杠归一（改动前后逐字等价）', () => {
    assert.strictEqual(toUrl('E:/s/wol/py/x.png'), 'file:///E:/s/wol/py/x.png');
    assert.strictEqual(toUrl('E:\\s\\wol\\py\\x.png'), 'file:///E:/s/wol/py/x.png');
    assert.strictEqual(toUrl('c:\\tmp\\a.mp4'), 'file:///c:/tmp/a.mp4');
    assert.strictEqual(hostOf(toUrl('E:\\s\\x.png')), '', 'Windows 路径不得产生主机段');
});

test('POSIX 绝对路径：恒三斜杠、主机段为空（四斜杠 = 主机名误判 = mac/Linux 全灭）', () => {
    const cases = ['/Users/q/a.png', '/home/q/v.mp4', '/Volumes/外置/图.png', '/'];
    for (const p of cases) {
        const u = toUrl(p);
        assert.ok(!u.startsWith('file:////'), 'POSIX 路径不得拼出四个斜杠: ' + p + ' → ' + u);
        assert.strictEqual(hostOf(u), '', 'POSIX 路径的主机段必须为空: ' + p + ' → ' + u);
        assert.ok(u.startsWith('file:///'), '恒三斜杠前缀: ' + p + ' → ' + u);
    }
    assert.strictEqual(toUrl('/Users/q/a.png'), 'file:///Users/q/a.png');
    assert.strictEqual(toUrl('/Users/q/a b.png'), 'file:///Users/q/a%20b.png');
});

test('UNC：服务器名进主机段（\\\\nas\\share 与 //nas/share 同式）', () => {
    assert.strictEqual(toUrl('\\\\nas\\share\\a.png'), 'file://nas/share/a.png');
    assert.strictEqual(toUrl('//nas/share/a.png'), 'file://nas/share/a.png');
    assert.strictEqual(hostOf(toUrl('//nas/share/a.png')), 'nas');
});

test('# ? % 空格 中文：逐段转义（旧写法把这些交给 URL 解析器 = 片段/查询/非法转义）', () => {
    assert.strictEqual(toUrl('/Users/q/a#1.png'), 'file:///Users/q/a%231.png');
    assert.strictEqual(toUrl('/Users/q/a?b.png'), 'file:///Users/q/a%3Fb.png');
    assert.strictEqual(toUrl('/Users/q/100%.png'), 'file:///Users/q/100%25.png');
    assert.strictEqual(toUrl('E:\\x\\a#1 ho%20.png'), 'file:///E:/x/a%231%20ho%2520.png');
    assert.strictEqual(toUrl('/home/q/视频.mp4'), 'file:///home/q/%E8%A7%86%E9%A2%91.mp4');
});

test('逆映射（qqqFilePathFromUrl）：盘符/POSIX/UNC 三形态回得来；非 file URL 返回 null', () => {
    const back = toUrl.filePathFromUrl;
    assert.strictEqual(typeof back, 'function');
    assert.strictEqual(back('file:///E:/x/a.png'), 'E:/x/a.png');
    assert.strictEqual(back('file:///Users/q/a%20b.png'), '/Users/q/a b.png');   // POSIX 前导斜杠必须补回
    assert.strictEqual(back('file:///home/q/a%231.png'), '/home/q/a#1.png');
    assert.strictEqual(back('file://nas/share/a.png'), '//nas/share/a.png');
    assert.strictEqual(back('E:/x/a.png'), null);
    assert.strictEqual(back(''), null);
    // 往返：给定路径 → URL → 路径必须回到原样（三形态全覆盖）
    for (const p of ['E:/x/a b.png', '/Users/q/a b.png', '/home/q/视频.mp4', '//nas/share/a.png']) {
        assert.strictEqual(back(toUrl(p)), p, '往返失真: ' + p);
    }
});

test('幂等：已是 file URL 原样返回；空入参空串', () => {
    for (const u of ['file:///E:/x/a.png', 'file:///Users/q/a.png', 'FILE://nas/share/a.png']) {
        assert.strictEqual(toUrl(u), u);
    }
    assert.strictEqual(toUrl(''), '');
    assert.strictEqual(toUrl(null), '');
    assert.strictEqual(toUrl(undefined), '');
});

test('消费方零副本：载荷侧不得再手拼 \'file:///\' + path；载入页必须引 core/file-url.js', () => {
    const codeFiles = [
        'core/qqq-codelens.js', 'core/shell-overlay.js', 'core/media-engine.js', 'core/frame-renderer.js',
        'core/ai-viewport.js', 'core/help-menu.js', 'ai-panel/panel-a4.js', 'ai-panel/tools-exec-effect.js',
        'goods/file-explorer/q2-roam.js',
    ];
    for (const rel of codeFiles) {
        const src = codeOnly(fs.readFileSync(path.join(ROOT, 'server-app', rel), 'utf8'));
        const bad = src.match(/'file:\/\/\/'\s*\+/g) || [];
        assert.strictEqual(bad.length, 0, rel + ' 仍有手拼 file URL（应用 window.qqqFileUrl）: ' + bad.length + ' 处');
    }
    for (const rel of ['index.html', 'ai-panel/index.html', 'player/player.html', 'goods/file-explorer/q2-roam.html', 'goods/mdview/mdview.html']) {
        const html = fs.readFileSync(path.join(ROOT, 'server-app', rel), 'utf8');
        assert.ok(/core\/file-url\.js/.test(html), rel + ' 未载入 core/file-url.js（消费方会拿不到唯一机器）');
    }
});

test('壳层同口径：播放器条目走 Node pathToFileURL（禁手拼）', () => {
    for (const rel of ['shell/ipc-player.ts', 'shell/player-host.ts']) {
        const src = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        assert.ok(src.includes("from 'url'") && src.includes('pathToFileURL'), rel + ' 必须用 pathToFileURL');
        const bad = src.match(/'file:\/\/\/'\s*\+/g) || [];
        assert.strictEqual(bad.length, 0, rel + ' 仍有手拼 file URL: ' + bad.length + ' 处');
    }
});
