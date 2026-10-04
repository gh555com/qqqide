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

test('isDouyinUrl / douyinPageUrl: 域名识别与页面归一（捕获机路由前置）', () => {
    assert.strictEqual(pf.isDouyinUrl('https://www.douyin.com/video/7678356530345442801'), true);
    assert.strictEqual(pf.isDouyinUrl('https://v.douyin.com/iAbCdEf/'), true);
    assert.strictEqual(pf.isDouyinUrl('https://www.iesdouyin.com/share/video/123'), true);
    assert.strictEqual(pf.isDouyinUrl('https://notdouyin.com/x'), false);
    assert.strictEqual(pf.isDouyinUrl('https://evil-douyin.com.evil.com/x'), false);
    assert.strictEqual(pf.isDouyinUrl(''), false);

    // /video/{id} 原样
    let r = pf.douyinPageUrl('https://www.douyin.com/video/7678356530345442801');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.videoId, '7678356530345442801');
    assert.strictEqual(r.pageUrl, 'https://www.douyin.com/video/7678356530345442801');

    // 作者分享页 ?modal_id=/vid= → 归一为 /video/{id}
    r = pf.douyinPageUrl('https://www.douyin.com/user/MS4wLjABAAAAx?from_tab_name=main&modal_id=7678356530345442801&relation=0&vid=7678356530345442801');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.videoId, '7678356530345442801');
    assert.strictEqual(r.pageUrl, 'https://www.douyin.com/video/7678356530345442801');

    // /note/{id} 图文帖（捕获层再判图文并给诚实错误）
    r = pf.douyinPageUrl('https://www.douyin.com/note/1234567890123456');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.videoId, '1234567890123456');

    // 短链原样（窗口跟随重定向自动落位）
    r = pf.douyinPageUrl('https://v.douyin.com/iAbCdEf/');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.videoId, '');

    // 作者主页无 modal_id → 未指向具体视频（诚实拒绝，不猜测）
    r = pf.douyinPageUrl('https://www.douyin.com/user/MS4wLjABAAAAx');
    assert.strictEqual(r.ok, false);
    r = pf.douyinPageUrl('not a url');
    assert.strictEqual(r.ok, false);
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

test('pickCookiesFile: 精确名优先 / 含 cookies 取最新 / 空与非 cookies 剔除', () => {
    assert.strictEqual(pf.pickCookiesFile([]), null);
    assert.strictEqual(pf.pickCookiesFile(null), null);
    // 空文件视为不存在
    assert.strictEqual(pf.pickCookiesFile([{ path: 'a', name: 'cookies.txt', mtimeMs: 9, size: 0 }]), null);
    // txt 但不含 cookies → 剔除
    assert.strictEqual(pf.pickCookiesFile([{ path: 'a', name: 'notes.txt', mtimeMs: 9, size: 5 }]), null);
    // 含 cookies 但非 txt → 剔除
    assert.strictEqual(pf.pickCookiesFile([{ path: 'a', name: 'cookies.json', mtimeMs: 9, size: 5 }]), null);
    // 宽松名（扩展导出常见名）：取最新 mtime
    const loose = pf.pickCookiesFile([
        { path: 'old', name: 'www.youtube.com_cookies.txt', mtimeMs: 1, size: 5 },
        { path: 'new', name: 'b_cookies.txt', mtimeMs: 2, size: 5 },
    ]);
    assert.strictEqual(loose, 'new');
    // 精确 cookies.txt 优先于更新的宽松名
    assert.strictEqual(pf.pickCookiesFile([
        { path: 'loose', name: 'a_cookies.txt', mtimeMs: 99, size: 5 },
        { path: 'exact', name: 'cookies.txt', mtimeMs: 1, size: 5 },
    ]), 'exact');
    // 多个精确名（大小写不敏感）→ 取最新
    assert.strictEqual(pf.pickCookiesFile([
        { path: 'e1', name: 'Cookies.TXT', mtimeMs: 1, size: 5 },
        { path: 'e2', name: 'cookies.txt', mtimeMs: 2, size: 5 },
    ]), 'e2');
});

test('serializeCookiesToNetscape: 头/制表符/#HttpOnly_/同键去重/结构防线', () => {
    const t = pf.serializeCookiesToNetscape([
        { domain: '.youtube.com', path: '/', name: 'SID', value: 'abc', secure: true, httpOnly: false, expirationDate: 1825650666 },
        { domain: '.youtube.com', path: '/', name: 'SID', value: 'dup' },
        { domain: 'www.youtube.com', path: '/', name: 'X', value: 'y', secure: false, httpOnly: true, expirationDate: 0 },
    ]);
    assert.ok(t.indexOf('# Netscape HTTP Cookie File') === 0, '应以 Netscape 头开始');
    assert.ok(t.indexOf('.youtube.com\tTRUE\t/\tTRUE\t1825650666\tSID\tabc') >= 0, 'SID 行格式异常: ' + t);
    assert.ok(t.indexOf('#HttpOnly_www.youtube.com\tFALSE\t/\tFALSE\t0\tX\ty') >= 0, '#HttpOnly_ 前缀缺失: ' + t);
    assert.ok(t.indexOf('dup') < 0, '同键应去重（保留先见）');
    // 值含制表符 → 丢弃（结构防线）；空列表 → 空串
    assert.strictEqual(pf.serializeCookiesToNetscape([{ domain: '.a.com', path: '/', name: 'N', value: 'a\tb' }]), '');
    assert.strictEqual(pf.serializeCookiesToNetscape([]), '');
});

test('mergeNetscapeCookies: 同键新者胜 / 旧文件其它站点保留 / 注释与坏行跳过', () => {
    const oldT = '# Netscape HTTP Cookie File\n# comment\n\n.b.com\tTRUE\t/\tFALSE\t1\tK\told\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tOLD\nbadline\n';
    const newT = '# Saved by qd (qqqide)\n\n.youtube.com\tTRUE\t/\tTRUE\t2\tSID\tNEW\n';
    const m = pf.mergeNetscapeCookies(oldT, newT);
    assert.ok(m.indexOf('.youtube.com\tTRUE\t/\tTRUE\t2\tSID\tNEW') >= 0, '新值应覆盖旧值: ' + m);
    assert.ok(m.indexOf('SID\tOLD') < 0, '旧 SID 行应被覆盖');
    assert.ok(m.indexOf('.b.com\tTRUE\t/\tFALSE\t1\tK\told') >= 0, '其它站点应保留');
    const m2 = pf.mergeNetscapeCookies(null, newT);
    assert.ok(m2.indexOf('SID\tNEW') >= 0, '无旧文件时应直出新值');
});

test('siteRootOf: 站点根归一（登录窗入口页；非法/缺省 → YouTube）', () => {
    assert.strictEqual(pf.siteRootOf('https://www.douyin.com/video/7678356530345442801?x=1'), 'https://www.douyin.com/');
    assert.strictEqual(pf.siteRootOf('http://example.com/a/b?c=d'), 'http://example.com/');
    assert.strictEqual(pf.siteRootOf('https://www.youtube.com/watch?v=R_PMTlFn0TQ'), 'https://www.youtube.com/');
    assert.strictEqual(pf.siteRootOf(''), 'https://www.youtube.com/');
    assert.strictEqual(pf.siteRootOf('not a url'), 'https://www.youtube.com/');
    assert.strictEqual(pf.siteRootOf('file:///E:/x/a.png'), 'https://www.youtube.com/');
    assert.strictEqual(pf.siteRootOf('qqqide-asset://file/a.png'), 'https://www.youtube.com/');
    assert.strictEqual(pf.siteRootOf(null), 'https://www.youtube.com/');
    assert.strictEqual(pf.siteRootOf(undefined), 'https://www.youtube.com/');
});

test('cookieBtnScript: 幂等守卫 / 双路回传标记 / 标签 JSON 转义', () => {
    const s = pf.cookieBtnScript('登录完成后点此保存 <b>"x"</b>');
    assert.ok(s.indexOf('__qqqCookieSaveBtn') >= 0, '幂等守卫缺失');
    assert.ok(s.indexOf('qqqide-cookies:save') >= 0, '伪协议缺失');
    assert.ok(s.indexOf('__qqq_cookie_save__') >= 0, 'console 标记缺失');
    assert.ok(s.indexOf('登录完成后点此保存') >= 0, '标签缺失');
    assert.ok(s.indexOf('\\"x\\"') >= 0, '标签必须 JSON 转义（防注入）');
    assert.ok(pf.cookieBtnScript('').indexOf('Save cookies') >= 0, '空标签应回落默认值');
});
