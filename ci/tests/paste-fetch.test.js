// ci/tests/paste-fetch.test.js — 网页媒体下载机纯函数回归守卫（shell/paste-fetch.ts，esbuild 打包为 CJS）。
// 覆盖: 安全档位三档快照 / header 清洗 / SSRF 私有网段判定 / MIME→扩展名 / 视频魔数 /
//       平台分片判定 / 视频命名 / Retry-After / 网页解码链（BOM/header/meta/UTF-8/GBK 兜底）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pf = require(path.join(__dirname, '.build', 'paste-fetch.cjs'));

test('resolveSecurityProfile: 三档快照（0 全关 / 1 平衡开 4 / 2 全开）', () => {
    const p0 = pf.resolveSecurityProfile(0);
    assert.strictEqual(p0.enableSSRFProtection, false);
    assert.strictEqual(p0.enableUrlProtocolAndCredsGuard, false);
    assert.strictEqual(p0.enableFailFast, false);

    const p1 = pf.resolveSecurityProfile(1);
    assert.strictEqual(p1.enableUrlProtocolAndCredsGuard, true);
    assert.strictEqual(p1.enableRedirectProtocolGuard, true);
    assert.strictEqual(p1.enableDownloadLock, true);
    assert.strictEqual(p1.enableHeaderSanitize, true);
    assert.strictEqual(p1.enableSSRFProtection, false);      // 平衡档不开 SSRF
    assert.strictEqual(p1.enableStrictRangeChecks, false);
    assert.strictEqual(p1.enableProbeOutputLimit, false);

    const p2 = pf.resolveSecurityProfile(2);
    for (const k of Object.keys(p2)) assert.strictEqual(p2[k], true, '严格档必须全开: ' + k);
});

test('sanitizeHeaders: CRLF 注入清洗 / 非法名 failFast 拒或跳过', () => {
    const r = pf.sanitizeHeaders({ 'User-Agent': 'a\r\nb' }, false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.headers['user-agent'], 'a b');

    const bad = pf.sanitizeHeaders({ 'bad header': 'x' }, true);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'invalid_header_name');

    const skip = pf.sanitizeHeaders({ 'bad header': 'x', ok: '1' }, false);
    assert.strictEqual(skip.ok, true);
    assert.strictEqual(skip.headers['ok'], '1');
    assert.strictEqual(skip.headers['bad header'], undefined);

    const arr = pf.sanitizeHeaders({ 'x-m': ['a', 'b'] }, false);
    assert.strictEqual(arr.headers['x-m'], 'a, b');
});

test('SSRF: 私有网段 / IP 字面量 / 主机名判定', () => {
    assert.strictEqual(pf.isNonPublicIPv4('127.0.0.1'), true);
    assert.strictEqual(pf.isNonPublicIPv4('10.1.2.3'), true);
    assert.strictEqual(pf.isNonPublicIPv4('192.168.1.1'), true);
    assert.strictEqual(pf.isNonPublicIPv4('169.254.1.1'), true);
    assert.strictEqual(pf.isNonPublicIPv4('172.16.5.5'), true);
    assert.strictEqual(pf.isNonPublicIPv4('172.32.5.5'), false);   // 172.32 已在公网侧
    assert.strictEqual(pf.isNonPublicIPv4('8.8.8.8'), false);

    assert.strictEqual(pf.isNonPublicIp('::1'), true);
    assert.strictEqual(pf.isNonPublicIp('fe80::1'), true);
    assert.strictEqual(pf.isNonPublicIp('2001:db8::1'), true);
    assert.strictEqual(pf.isNonPublicIp('::ffff:127.0.0.1'), true);
    assert.strictEqual(pf.isNonPublicIp('2606:4700:4700::1111'), false);
    assert.strictEqual(pf.isNonPublicIp('not-an-ip'), true);       // 非法输入按保守拦截

    assert.strictEqual(pf.isLocalHostname('localhost'), true);
    assert.strictEqual(pf.isLocalHostname('printer.local'), true);
    assert.strictEqual(pf.isLocalHostname('example.com'), false);
});

test('extFromMime / sniffVideoMagic / isPlatformOrSegmentVideo / platformVideoName', () => {
    assert.strictEqual(pf.extFromMime('image/jpeg', 'image'), '.jpg');
    assert.strictEqual(pf.extFromMime('video/mp4', 'video'), '.mp4');
    assert.strictEqual(pf.extFromMime('application/octet-stream', 'image'), '.png');
    assert.strictEqual(pf.extFromMime('text/plain', 'video'), '.mp4');

    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1')]);
    assert.strictEqual(pf.sniffVideoMagic(ftyp), true);
    assert.strictEqual(pf.sniffVideoMagic(Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0])), true);   // EBML
    assert.strictEqual(pf.sniffVideoMagic(Buffer.from('RIFF____AVI ', 'latin1')), true);
    assert.strictEqual(pf.sniffVideoMagic(Buffer.from('this is not a video', 'latin1')), false);
    assert.strictEqual(pf.sniffVideoMagic(Buffer.alloc(4)), false);

    assert.strictEqual(pf.isPlatformOrSegmentVideo('https://www.bilibili.com/video/BV1xx411c7mD'), true);
    assert.strictEqual(pf.isPlatformOrSegmentVideo('https://www.youtube.com/watch?v=abc'), true);
    assert.strictEqual(pf.isPlatformOrSegmentVideo('https://cdn.example.com/hls/stream.m3u8?x=1'), true);
    assert.strictEqual(pf.isPlatformOrSegmentVideo('https://cdn.example.com/a.mp4'), false);

    const yt = pf.platformVideoName('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.ok(yt.indexOf('youtube') >= 0, 'youtube 命名应含主机名: ' + yt);
    const bili = pf.platformVideoName('https://www.bilibili.com/video/BV1xx411c7mD?spm=1');
    assert.ok(bili.indexOf('bilibili') >= 0 && bili.indexOf('BV1xx411c7mD') >= 0, 'bilibili 命名异常: ' + bili);
});

test('parseRetryAfterMs: 秒数 / 空值 / 上限封顶', () => {
    assert.strictEqual(pf.parseRetryAfterMs('5'), 5000);
    assert.strictEqual(pf.parseRetryAfterMs(''), 0);
    assert.strictEqual(pf.parseRetryAfterMs(null), 0);
    assert.strictEqual(pf.parseRetryAfterMs('9999'), 60000);
});

test('decodeHtmlBuffer: BOM / header / meta / 严格 UTF-8 / GBK 兜底全链', () => {
    // 纯 UTF-8
    let r = pf.decodeHtmlBuffer(Buffer.from('<p>你好</p>', 'utf8'), 'text/html');
    assert.strictEqual(r.charset, 'utf-8');
    assert.strictEqual(r.text, '<p>你好</p>');

    // UTF-8 BOM 剥离
    r = pf.decodeHtmlBuffer(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('<p>hi</p>', 'utf8')]), '');
    assert.strictEqual(r.charset, 'utf-8');
    assert.strictEqual(r.text, '<p>hi</p>');

    // '<p>你好</p>' 的 GBK 字节
    const gbkBuf = Buffer.from([0x3C, 0x70, 0x3E, 0xC4, 0xE3, 0xBA, 0xC3, 0x3C, 0x2F, 0x70, 0x3E]);

    // header 声明 gbk（如实解码）
    r = pf.decodeHtmlBuffer(gbkBuf, 'text/html; charset=gbk');
    assert.strictEqual(r.charset, 'gbk');
    assert.strictEqual(r.text, '<p>你好</p>');

    // 无声明但 GBK 字节 → 启发式兜底（严格 UTF-8 失败 → GBK）
    r = pf.decodeHtmlBuffer(gbkBuf, 'text/html');
    assert.strictEqual(r.text, '<p>你好</p>');

    // header 声明 utf-8 但实为 GBK（声明冲突）→ 竞品对比选 GBK
    r = pf.decodeHtmlBuffer(gbkBuf, 'text/html; charset=utf-8');
    assert.strictEqual(r.text, '<p>你好</p>');

    // meta 声明（无 header charset）
    r = pf.decodeHtmlBuffer(Buffer.concat([Buffer.from('<meta charset="gb2312">', 'latin1'), gbkBuf]), 'text/html');
    assert.strictEqual(r.text.indexOf('你好') >= 0, true);

    // UTF-16LE BOM
    r = pf.decodeHtmlBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('<i>x</i>', 'utf16le')]), '');
    assert.strictEqual(r.charset, 'utf-16le');
    assert.strictEqual(r.text, '<i>x</i>');

    // windows-1252（iso-8859-1 别名归一）
    r = pf.decodeHtmlBuffer(Buffer.from('caf\xE9', 'latin1'), 'text/html; charset=iso-8859-1');
    assert.strictEqual(r.text, 'café');

    // 尾部多字节序列被切（头部探测场景）→ 截断回退 ≤3 字节，不误判 GBK
    const full = Buffer.from('你好世界', 'utf8');
    r = pf.decodeHtmlBuffer(full.subarray(0, full.length - 1), 'text/html');
    assert.strictEqual(r.charset, 'utf-8');
    assert.strictEqual(r.text, '你好世');
});

test('resolveCharset: 别名归一 / 未知返回空', () => {
    assert.strictEqual(pf.resolveCharset('UTF-8'), 'utf-8');
    assert.strictEqual(pf.resolveCharset('gb2312'), 'gbk');
    assert.strictEqual(pf.resolveCharset('latin1'), 'windows-1252');
    assert.strictEqual(pf.resolveCharset('GBK'), 'gbk');
    assert.strictEqual(pf.resolveCharset('shift_jis'), 'shiftjis');
    assert.strictEqual(pf.resolveCharset('no-such-charset-xyz'), '');
    assert.strictEqual(pf.resolveCharset(''), '');
});
