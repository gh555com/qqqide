// ci/tests/player-info.test.js — 播放器「媒体信息」归一纯逻辑回归（2026-10-03 q319）
// 覆盖：格式化（字节/码率/时长/帧率/采样率/时间）+ 主流入的选取（attached_pic 封面剔除）+
// 区块序（视频→音频→容器→文件→时间）+ 附加流/封面标注 + probe 失败降级（仅文件/时间区块）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pi = require(path.join(__dirname, '.build', 'player-info.cjs'));

// 真实形态的 ffprobe 样本（mkv：h264+aac）
const MKV = {
    streams: [
        { index: 0, codec_name: 'h264', codec_type: 'video', profile: 'High', level: 30, width: 352, height: 240, pix_fmt: 'yuv420p', r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001', bit_rate: '1150000', refs: 4, field_order: 'progressive', color_space: 'bt470bg', color_primaries: 'bt470bg', color_transfer: 'bt470bg', color_range: 'tv', sample_aspect_ratio: '1:1' },
        { index: 1, codec_name: 'aac', codec_type: 'audio', profile: 'LC', channels: 2, channel_layout: 'stereo', sample_rate: '44100', sample_fmt: 'fltp', bit_rate: '128000' },
    ],
    format: { format_name: 'matroska,webm', format_long_name: 'Matroska / WebM', duration: '252.48', size: '41418752', bit_rate: '1312000', nb_streams: 2, tags: { encoder: 'Lavf58.76.100' } },
};
const ST = { path: 'F:\\本地磁盘\\yy\\Spice Girls - Holler.mkv', size: 41418752, mtimeMs: 1758376443000, birthtimeMs: 1744336975000, ctimeMs: 1744336975000 };

test('fmtFps：分数式 → 小数（29.97 / 23.976 / 25）；非法 → 空', () => {
    assert.strictEqual(pi.fmtFps('30000/1001'), '29.97');
    assert.strictEqual(pi.fmtFps('24000/1001'), '23.976');
    assert.strictEqual(pi.fmtFps('25/1'), '25');
    assert.strictEqual(pi.fmtFps('0/0'), '');
    assert.strictEqual(pi.fmtFps(''), '');
    assert.strictEqual(pi.fmtFps('nope'), '');
});

test('fmtBytes / fmtExact：人类可读 + 千分位', () => {
    assert.strictEqual(pi.fmtBytes(41418752), '39.5 MB');
    assert.strictEqual(pi.fmtBytes(1024), '1 KB');
    assert.strictEqual(pi.fmtBytes(900), '900 B');
    assert.strictEqual(pi.fmtBytes(1610612736), '1.5 GB');
    assert.strictEqual(pi.fmtExact(41418752), '41,418,752');
    assert.strictEqual(pi.fmtExact(1024), '1,024');
});

test('fmtBitrate：Mbps / kbps / bps', () => {
    assert.strictEqual(pi.fmtBitrate(128000), '128 kbps');
    assert.strictEqual(pi.fmtBitrate(1150000), '1.15 Mbps');
    assert.strictEqual(pi.fmtBitrate(96000), '96 kbps');
    assert.strictEqual(pi.fmtBitrate(800), '800 bps');
    assert.strictEqual(pi.fmtBitrate(0), '');
});

test('fmtDur：M:SS / H:MM:SS', () => {
    assert.strictEqual(pi.fmtDur(252.48), '4:12');
    assert.strictEqual(pi.fmtDur(3723), '1:02:03');
    assert.strictEqual(pi.fmtDur(5), '0:05');
    assert.strictEqual(pi.fmtDur(-1), '');
});

test('fmtHz：44.1 kHz / 48 kHz', () => {
    assert.strictEqual(pi.fmtHz(44100), '44.1 kHz');
    assert.strictEqual(pi.fmtHz(48000), '48 kHz');
    assert.strictEqual(pi.fmtHz(8000), '8 kHz');
    assert.strictEqual(pi.fmtHz(0), '');
});

test('fmtTs：YYYY-MM-DD HH:MM:SS 形态 + 分量正确', () => {
    const d = new Date(1758376443000);
    const s = pi.fmtTs(1758376443000);
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(s.startsWith(d.getFullYear() + '-'));
    assert.ok(s.endsWith(':' + String(d.getSeconds()).padStart(2, '0')));
    assert.strictEqual(pi.fmtTs(NaN), '');
});

test('codecLabel / profileLevel / fieldLabel / colorLine', () => {
    assert.strictEqual(pi.codecLabel('h264'), 'H.264');
    assert.strictEqual(pi.codecLabel('hevc'), 'H.265 (HEVC)');
    assert.strictEqual(pi.codecLabel('weird'), 'weird');
    assert.strictEqual(pi.profileLevel('High', 30), 'High@L3.0');
    assert.strictEqual(pi.profileLevel('High', 41), 'High@L4.1');
    assert.strictEqual(pi.profileLevel('LC', 0), 'LC');
    assert.strictEqual(pi.profileLevel('', 0), '');
    assert.strictEqual(pi.fieldLabel('progressive'), 'Progressive');
    assert.strictEqual(pi.fieldLabel('tt'), 'Interlaced (TFF)');
    assert.strictEqual(pi.fieldLabel(''), '');
    assert.strictEqual(pi.colorLine({ color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv' }), 'bt709 · tv');
    assert.strictEqual(pi.colorLine({ color_range: 'tv' }), '');
    assert.strictEqual(pi.colorLine({ color_space: 'unknown', color_range: 'pc' }), 'pc');
});

test('buildMediaInfo：区块序 = 视频→音频→容器→文件→时间（含全部字段）', () => {
    const secs = pi.buildMediaInfo(MKV, ST, 'ok');
    assert.deepStrictEqual(secs.map((s) => s.id), ['video', 'audio', 'format', 'file', 'time']);
    const vid = secs[0].rows;
    assert.deepStrictEqual(vid.find((r) => r.id === 'codec').v, 'H.264 · High@L3.0');
    assert.deepStrictEqual(vid.find((r) => r.id === 'resolution').v, '352 × 240');
    assert.deepStrictEqual(vid.find((r) => r.id === 'fps').v, '29.97 fps');
    assert.deepStrictEqual(vid.find((r) => r.id === 'pixfmt').v, 'yuv420p');
    assert.deepStrictEqual(vid.find((r) => r.id === 'field').v, 'Progressive');
    assert.deepStrictEqual(vid.find((r) => r.id === 'color').v, 'bt470bg · tv');
    assert.deepStrictEqual(vid.find((r) => r.id === 'vbitrate').v, '1.15 Mbps');
    assert.deepStrictEqual(vid.find((r) => r.id === 'refs').v, '4 refs');
    const aud = secs[1].rows;
    assert.deepStrictEqual(aud.find((r) => r.id === 'codec').v, 'AAC · LC');
    assert.deepStrictEqual(aud.find((r) => r.id === 'channels').v, '2 (stereo)');
    assert.deepStrictEqual(aud.find((r) => r.id === 'samplerate').v, '44.1 kHz');
    assert.deepStrictEqual(aud.find((r) => r.id === 'samplefmt').v, 'fltp');
    assert.deepStrictEqual(aud.find((r) => r.id === 'abitrate').v, '128 kbps');
    const fmt = secs[2].rows;
    assert.deepStrictEqual(fmt.find((r) => r.id === 'container').v, 'Matroska / WebM');
    assert.deepStrictEqual(fmt.find((r) => r.id === 'duration').v, '4:12');
    assert.deepStrictEqual(fmt.find((r) => r.id === 'bitrate').v, '1.31 Mbps');
    assert.deepStrictEqual(fmt.find((r) => r.id === 'streams').v, '2 (1 video · 1 audio)');
    assert.deepStrictEqual(fmt.find((r) => r.id === 'encoder').v, 'Lavf58.76.100');
    const file = secs[3].rows;
    assert.deepStrictEqual(file.find((r) => r.id === 'filename').v, 'Spice Girls - Holler.mkv');
    assert.deepStrictEqual(file.find((r) => r.id === 'location').v, 'F:/本地磁盘/yy');
    assert.deepStrictEqual(file.find((r) => r.id === 'size').v, '39.5 MB · 41,418,752 B');
    const time = secs[4].rows;
    assert.strictEqual(time.length, 2);
    assert.deepStrictEqual(time.map((r) => r.id), ['mtime', 'ctime']);
});

test('buildMediaInfo：mp3+封面（attached_pic）→ 无视频区块；封面/字幕进附加流', () => {
    const probe = {
        streams: [
            { index: 0, codec_name: 'mp3', codec_type: 'audio', channels: 2, channel_layout: 'stereo', sample_rate: '44100', bit_rate: '320000' },
            { index: 1, codec_name: 'mjpeg', codec_type: 'video', disposition: { attached_pic: 1 }, width: 600, height: 600 },
            { index: 2, codec_name: 'subrip', codec_type: 'subtitle' },
        ],
        format: { format_name: 'mp3', format_long_name: 'MP3 (MPEG audio layer 3)', duration: '213.5', bit_rate: '320000', nb_streams: 3 },
    };
    const secs = pi.buildMediaInfo(probe, { path: 'E:/a/b.mp3', size: 8600000, mtimeMs: 1, birthtimeMs: 0, ctimeMs: 2 }, 'ok');
    assert.deepStrictEqual(secs.map((s) => s.id), ['audio', 'format', 'file', 'time']);
    const fmt = secs[1].rows;
    assert.deepStrictEqual(fmt.find((r) => r.id === 'streams').v, '3 (1 video · 1 audio · 1 subtitle)');
    const extras = fmt.filter((r) => r.id === 'extra').map((r) => r.v);
    assert.deepStrictEqual(extras, ['#1 · video (cover) · mjpeg', '#2 · subtitle · subrip']);
    // birthtime=0 → ctime 回落为创建时间
    assert.deepStrictEqual(secs[3].rows.map((r) => r.id), ['mtime', 'ctime']);
});

test('buildMediaInfo：probe 失败/缺失 → 仅文件+时间区块（不炸）', () => {
    const a = pi.buildMediaInfo(null, ST, 'unavailable');
    assert.deepStrictEqual(a.map((s) => s.id), ['file', 'time']);
    const b = pi.buildMediaInfo({}, ST, 'failed');
    assert.deepStrictEqual(b.map((s) => s.id), ['file', 'time']);
    const c = pi.buildMediaInfo(MKV, ST, 'failed');   // 全量 JSON 在手但状态失败 → 仍不出编码区块
    assert.deepStrictEqual(c.map((s) => s.id), ['file', 'time']);
    assert.deepStrictEqual(pi.buildMediaInfo(null, { path: '', size: 0, mtimeMs: 0, birthtimeMs: 0, ctimeMs: 0 }, 'failed'), []);
});
