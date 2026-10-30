// ci/tests/media-kinds.test.js — 媒体分类唯一真理源（core/media-kinds.js）回归守卫
// 背景（2026-10-29 q466）：codelens 文件信息行改「qd 优先，开不了回退系统」——
// 「qd 能开哪些媒体」必须只有一份表；本测试同时守三件事：
//   ① 四表自身自洽（IMAGE ⊇ NATIVE_IMAGE；三域零交集；.ts 恒不进视频）；
//   ② kindOf 裁决口径（大小写/无扩展名/表外格式落空串）；
//   ③ 消费方零副本（q2-roam / qqq-codelens 里不得再出现本地扩展名表）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const mk = require(path.join(ROOT, 'server-app', 'core', 'media-kinds.js'));

test('四表自洽：IMAGE ⊇ NATIVE_IMAGE；图片/视频/音频三域零交集', () => {
    for (const k of Object.keys(mk.NATIVE_IMAGE)) {
        assert.ok(mk.IMAGE[k], 'NATIVE_IMAGE 必须全部落在 IMAGE 内: ' + k);
    }
    for (const k of Object.keys(mk.IMAGE)) {
        assert.ok(!mk.VIDEO[k], '图片与视频不得重叠: ' + k);
        assert.ok(!mk.AUDIO[k], '图片与音频不得重叠: ' + k);
    }
    for (const k of Object.keys(mk.VIDEO)) {
        assert.ok(!mk.AUDIO[k], '视频与音频不得重叠: ' + k);
    }
});

test('防回潮：.ts 恒不进视频（= TypeScript 文本）；.psd/.tif/.tiff 归转码图片组', () => {
    assert.ok(!mk.VIDEO['.ts'], '.ts 绝不能进视频表');
    assert.strictEqual(mk.kindOf('a.ts'), '');
    for (const k of ['.psd', '.tif', '.tiff']) {
        assert.strictEqual(mk.kindOf('x' + k), 'image');
        assert.strictEqual(mk.needsTranscodeImage(k), true);
        assert.strictEqual(mk.isNativeImage(k), false);
    }
    assert.strictEqual(mk.needsTranscodeImage('.png'), false);
    assert.strictEqual(mk.isNativeImage('.png'), true);
});

test('kindOf：大小写不敏感 / 无扩展名与表外格式恒空串（= 回退系统默认程序）', () => {
    assert.strictEqual(mk.kindOf('E:/a/b.MP4'), 'video');
    assert.strictEqual(mk.kindOf('D:\\x\\y\\Song.FLAC'), 'audio');
    assert.strictEqual(mk.kindOf('C:/p/图.PNG'), 'image');
    assert.strictEqual(mk.kindOf('C:/p/noext'), '');
    assert.strictEqual(mk.kindOf('C:/p/doc.pdf'), '');
    assert.strictEqual(mk.kindOf('C:/p/pack.zip'), '');
    assert.strictEqual(mk.kindOf(''), '');
    assert.strictEqual(mk.extOf('C:/p/a.TIFF'), '.tiff');
    assert.strictEqual(mk.extOf('plain'), '');
});

test('任意格式恒空串：快捷方式/可执行/脚本/安装包/图纸/压缩包/无扩展名 一律交系统默认', () => {
    const others = [
        'C:/p/calc.lnk', 'C:/p/calc.exe', 'C:/p/run.bat', 'C:/p/run.cmd', 'C:/p/x.ps1', 'C:/p/x.vbs',
        'C:/p/site.url', 'C:/p/setup.msi', 'C:/p/draw.dwg', 'C:/p/pack.7z', 'C:/p/disk.iso',
        'C:/p/doc.docx', 'C:/p/sheet.xlsx', 'C:/p/a.torrent', 'C:/p/lib.dll', 'C:/p/README',
        'C:/p/noext.with.dots.inside', 'C:/p/.gitignore', 'C:/p/trailing.',
    ];
    for (const f of others) assert.strictEqual(mk.kindOf(f), '', '表外格式必须落空串: ' + f);
    // 目录名带媒体后缀的路径（…/x.mp4/file 与 …/x.mp4/）不得被误判为媒体
    assert.strictEqual(mk.kindOf('C:/p/x.mp4/file'), '');
    assert.strictEqual(mk.kindOf('C:/p/x.mp4/'), '');
});

test('消费方零副本：q2-roam / qqq-codelens 不得再自带扩展名表（唯一真理源在本文件）', () => {
    const roam = fs.readFileSync(path.join(ROOT, 'server-app', 'goods', 'file-explorer', 'q2-roam.js'), 'utf8');
    const lens = fs.readFileSync(path.join(ROOT, 'server-app', 'core', 'qqq-codelens.js'), 'utf8');
    for (const probe of ["'.rmvb':1", "'.ogm':1", "'.ape':1", "'.apng':1"]) {
        assert.ok(roam.indexOf(probe) === -1, 'q2-roam 里出现了本地媒体表: ' + probe);
        assert.ok(lens.indexOf(probe) === -1, 'qqq-codelens 里出现了本地媒体表: ' + probe);
    }
    assert.ok(roam.indexOf('qqqMediaKinds') !== -1, 'q2-roam 必须消费 window.qqqMediaKinds');
    assert.ok(lens.indexOf('qqqMediaKinds') !== -1, 'qqq-codelens 必须消费 window.qqqMediaKinds');
});
