// ci/tests/transcode-hw.test.js — 硬编候选表回归守卫（纯函数）
// 背景：bundled ffmpeg 4.1 的 nvenc 忽略 -cq（实测 19/21/23 产物逐字节相同）——
// 若有人把质量参数改回 -cq，画质旋钮就静默失效；尺寸下限 640x360 同理（更小触发 init 失败）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const hw = require(path.join(__dirname, '.build', 'transcode-hw.cjs'));

test('win32 候选顺序 = nvenc → qsv → amf', () => {
    const c = hw.hwEncCandidatesFor('win32');
    assert.deepStrictEqual(c.map((x) => x.name), ['h264_nvenc', 'h264_qsv', 'h264_amf']);
});

test('nvenc 质量旋钮 = -rc constqp -qp 30（禁 -cq：本版 ffmpeg 忽略它）', () => {
    const nv = hw.hwEncCandidatesFor('win32')[0];
    const i = nv.args.indexOf('-rc');
    assert.ok(i >= 0 && nv.args[i + 1] === 'constqp', 'nvenc 必须 constqp 模式');
    const j = nv.args.indexOf('-qp');
    assert.ok(j >= 0 && nv.args[j + 1] === '30', 'nvenc qp 应为 30（≈x264 crf23 实测对标）');
    for (const cand of hw.hwEncCandidatesFor('win32')) {
        assert.ok(cand.args.indexOf('-cq') < 0, cand.name + ' 禁含 -cq（本版 ffmpeg 4.1 忽略）');
    }
});

test('darwin = videotoolbox；其余平台 = 空（纯软编）', () => {
    assert.deepStrictEqual(hw.hwEncCandidatesFor('darwin').map((x) => x.name), ['h264_videotoolbox']);
    assert.deepStrictEqual(hw.hwEncCandidatesFor('linux'), []);
    assert.deepStrictEqual(hw.hwEncCandidatesFor('freebsd'), []);
});

test('探测试编参数 = 640x360 合成源（128x128 触发 NVENC init 失败——尺寸下限守卫）', () => {
    const a = hw.hwProbeArgs(hw.hwEncCandidatesFor('win32')[0]);
    const s = a.join(' ');
    assert.ok(s.includes('s=640x360'), '探测源必须 640x360');
    assert.ok(!s.includes('128x128'), '禁回 128x128（NVENC invalid param 实锤）');
    assert.ok(s.includes('lavfi'), '合成源（不依赖用户文件）');
    assert.ok(a[a.length - 1] === '-', 'null muxer 输出');
    // 候选自身参数必须原样带入（探测即预演真实编码参数）
    for (const tok of ['-c:v', 'h264_nvenc', 'constqp']) { assert.ok(a.includes(tok), '探测须带 ' + tok); }
});
