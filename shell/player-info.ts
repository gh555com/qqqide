// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-info.ts — 播放器「媒体信息」（[!] 钮悬停详情框）纯逻辑（2026-10-03 q319 定案）
//
//   数据源 = media-service.info（ffprobe -show_streams -show_format JSON + fs.stat）；
//   本文件只做归一 + 格式化（纯函数、可单测）——产出行 id + 语言中立的展示值：
//   row.id → 渲染层 i18n 标签映射（locales zh.json shell.player.info.lbl.*）；
//   技术值（编码/像素格式/色彩/采样格式/fps…）恒原样英文技术名词，禁翻译。
//   区块序 = 视频 → 音频 → 容器 → 文件 → 时间（用户定案：编码信息在上、时间垫底）。
//   主视频流判定必须剔除 attached_pic（mp3 封面图是 video 流——否则音频文件误出「视频」区块）。
//   ★ 修改必须同步：media-service.info（数据源）/ ipc-media（qqqide:media:info）/
//     player/player.html（_miRender 标签表）/ locales/zh.json（shell.player.info.*）。
// ============================================================================

export type ProbeState = 'ok' | 'unavailable' | 'failed';

export interface MediaInfoStat {
    path: string;
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
    ctimeMs: number;
}

export interface InfoRow { id: string; v: string; }
export interface InfoSection { id: string; rows: InfoRow[]; }

function _p2(n: number): string { return (n < 10 ? '0' : '') + n; }

/** 本地时间 'YYYY-MM-DD HH:MM:SS'（无值时 ''）。 */
export function fmtTs(ms: number): string {
    try {
        const d = new Date(ms);
        if (!isFinite(d.getTime())) { return ''; }
        return d.getFullYear() + '-' + _p2(d.getMonth() + 1) + '-' + _p2(d.getDate()) + ' ' +
            _p2(d.getHours()) + ':' + _p2(d.getMinutes()) + ':' + _p2(d.getSeconds());
    } catch { return ''; }
}

function _trimNum(v: number, dp: number): string {
    let s = v.toFixed(dp);
    if (s.indexOf('.') >= 0) { s = s.replace(/\.?0+$/, ''); }
    return s;
}

/** 人类可读体积：'39.5 MB' / '892 KB' / '1.5 GB'。 */
export function fmtBytes(n: number): string {
    try {
        if (!isFinite(n) || n < 0) { return ''; }
        if (n < 1024) { return Math.round(n) + ' B'; }
        const units = ['KB', 'MB', 'GB', 'TB'];
        let v = n / 1024, i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return _trimNum(v, v >= 100 ? 0 : (v >= 10 ? 1 : 2)) + ' ' + units[i];
    } catch { return ''; }
}

/** 千分位精确字节：'41,418,752'。 */
export function fmtExact(n: number): string {
    try { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); } catch { return String(n); }
}

/** 码率：'1.15 Mbps' / '128 kbps' / '800 bps'。 */
export function fmtBitrate(bps: number): string {
    try {
        if (!isFinite(bps) || bps <= 0) { return ''; }
        if (bps >= 1e6) { return _trimNum(bps / 1e6, 2) + ' Mbps'; }
        if (bps >= 1e3) { return _trimNum(bps / 1e3, bps >= 1e5 ? 0 : 1) + ' kbps'; }
        return Math.round(bps) + ' bps';
    } catch { return ''; }
}

/** 时长：'4:12' / '1:02:03'。 */
export function fmtDur(sec: number): string {
    try {
        if (!isFinite(sec) || sec < 0) { return ''; }
        const t = Math.round(sec);
        const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
        return h > 0 ? (h + ':' + _p2(m) + ':' + _p2(s)) : (m + ':' + _p2(s));
    } catch { return ''; }
}

/** 帧率（ffprobe 'num/den' 分数式）：'30000/1001' → '29.97'；非法 → ''。 */
export function fmtFps(rate: string): string {
    try {
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(rate || ''));
        if (!m) { return ''; }
        const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
        if (!den || !num) { return ''; }
        const v = num / den;
        if (!isFinite(v) || v <= 0 || v > 1000) { return ''; }
        return String(Math.round(v * 1000) / 1000);
    } catch { return ''; }
}

/** 采样率：'44.1 kHz' / '48 kHz'。 */
export function fmtHz(hz: number): string {
    try {
        if (!isFinite(hz) || hz <= 0) { return ''; }
        if (hz >= 1000) { return _trimNum(hz / 1000, 1) + ' kHz'; }
        return Math.round(hz) + ' Hz';
    } catch { return ''; }
}

// 常见编码显示名（技术名词恒英文；未收录 → codec_name 原样）
const _CODEC_LABELS: Record<string, string> = {
    h264: 'H.264', avc1: 'H.264', hevc: 'H.265 (HEVC)', h265: 'H.265 (HEVC)',
    av1: 'AV1', vp9: 'VP9', vp8: 'VP8', theora: 'Theora',
    mpeg1video: 'MPEG-1', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4',
    msmpeg4v3: 'MS MPEG-4 v3', wmv1: 'WMV 1', wmv2: 'WMV 2', wmv3: 'WMV 3 (VC-1)', vc1: 'VC-1',
    prores: 'Apple ProRes', dvvideo: 'DV', mjpeg: 'Motion JPEG', flv1: 'Sorenson Spark (FLV1)',
    aac: 'AAC', mp3: 'MP3', mp2: 'MP2', mp1: 'MP1',
    ac3: 'AC3 (Dolby Digital)', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD',
    flac: 'FLAC', alac: 'ALAC', opus: 'Opus', vorbis: 'Vorbis', wavpack: 'WavPack',
    pcm_s16le: 'PCM 16-bit LE', pcm_s16be: 'PCM 16-bit BE', pcm_u8: 'PCM 8-bit',
    pcm_s24le: 'PCM 24-bit LE', pcm_s32le: 'PCM 32-bit LE', pcm_f32le: 'PCM 32-bit float',
    wmapro: 'WMA Pro', wmav2: 'WMA v2', wmav1: 'WMA v1', cook: 'Cook (RealAudio)',
};

/** 编码显示名（未知 → 原样小写名）。 */
export function codecLabel(name: string): string {
    const n = String(name || '').toLowerCase();
    if (!n) { return ''; }
    return _CODEC_LABELS[n] || n;
}

/** 'High' + level 30 → 'High@L3.0'；无 level → 'High'；无 profile → 'L3.0'；全无 → ''。 */
export function profileLevel(profile: any, level: any): string {
    try {
        const p = String(profile || '').trim();
        const lv = parseInt(String(level || ''), 10);
        let tail = '';
        if (isFinite(lv) && lv > 0) {
            tail = (lv >= 10) ? ('L' + Math.floor(lv / 10) + '.' + (lv % 10)) : ('L' + lv);
        }
        if (p && tail) { return p + '@' + tail; }
        return p || tail;
    } catch { return ''; }
}

/** 扫描方式（ffprobe field_order）：progressive → 'Progressive'；隔行含场序标注。 */
export function fieldLabel(f: string): string {
    const t = String(f || '').toLowerCase();
    if (t === 'progressive') { return 'Progressive'; }
    if (t === 'tt') { return 'Interlaced (TFF)'; }
    if (t === 'bb') { return 'Interlaced (BFF)'; }
    if (t === 'tb') { return 'Interlaced (T/B)'; }
    if (t === 'bt') { return 'Interlaced (B/T)'; }
    return '';
}

/** 色彩行（去重）：bt709/bt709/bt709/tv → 'bt709 · tv'；全空 → ''。 */
export function colorLine(s: any): string {
    try {
        const parts: string[] = [];
        const push = (x: any): void => {
            const t = String(x || '').trim();
            if (t && t !== 'unknown' && t !== 'unspecified' && parts.indexOf(t) < 0) { parts.push(t); }
        };
        push(s && s.color_space);
        push(s && s.color_primaries);
        push(s && s.color_transfer);
        push(s && s.color_range);
        if (parts.length === 1 && parts[0] === 'tv') { return ''; }   // 仅 tv 无信息量（默认值）
        return parts.join(' · ');
    } catch { return ''; }
}

/** 主视频/主音频流：第一条 video（剔除 attached_pic 封面）+ 第一条 audio。 */
export function pickMainStreams(streams: any[]): { video: any; audio: any } {
    let video: any = null, audio: any = null;
    const list = Array.isArray(streams) ? streams : [];
    for (const s of list) {
        if (!s) { continue; }
        const t = String(s.codec_type || '');
        const pic = !!(s.disposition && Number(s.disposition.attached_pic) === 1);
        if (t === 'video' && !video && !pic) { video = s; }
        else if (t === 'audio' && !audio) { audio = s; }
    }
    return { video, audio };
}

function _videoRows(s: any): InfoRow[] {
    const rows: InfoRow[] = [];
    const codec = codecLabel(String(s.codec_name || ''));
    const pl = profileLevel(s.profile, s.level);
    if (codec || pl) { rows.push({ id: 'codec', v: pl ? (codec ? codec + ' · ' + pl : pl) : codec }); }
    const w = Number(s.width) || 0, h = Number(s.height) || 0;
    if (w > 0 && h > 0) {
        let r = w + ' × ' + h;
        const sar = String(s.sample_aspect_ratio || '');
        if (sar && sar !== '1:1' && sar !== '0:1') { r += ' · SAR ' + sar; }
        rows.push({ id: 'resolution', v: r });
    }
    const rf = fmtFps(String(s.r_frame_rate || ''));
    if (rf) {
        let v = rf + ' fps';
        const af = fmtFps(String(s.avg_frame_rate || ''));
        if (af && af !== rf) { v += ' · avg ' + af + ' fps'; }
        rows.push({ id: 'fps', v });
    }
    const pf = String(s.pix_fmt || '');
    if (pf) {
        let v = pf;
        const bits = parseInt(String(s.bits_per_raw_sample || ''), 10);
        if (isFinite(bits) && bits > 0) { v += ' · ' + bits + '-bit'; }
        rows.push({ id: 'pixfmt', v });
    }
    const fl = fieldLabel(String(s.field_order || ''));
    if (fl) { rows.push({ id: 'field', v: fl }); }
    const cl = colorLine(s);
    if (cl) { rows.push({ id: 'color', v: cl }); }
    const br = parseInt(String(s.bit_rate || ''), 10);
    if (isFinite(br) && br > 0) { rows.push({ id: 'vbitrate', v: fmtBitrate(br) }); }
    const refs = parseInt(String(s.refs || ''), 10);
    if (isFinite(refs) && refs > 0) { rows.push({ id: 'refs', v: refs + ' refs' }); }
    return rows;
}

function _audioRows(s: any): InfoRow[] {
    const rows: InfoRow[] = [];
    const codec = codecLabel(String(s.codec_name || ''));
    const pl = profileLevel(s.profile, 0);
    if (codec || pl) { rows.push({ id: 'codec', v: pl ? (codec ? codec + ' · ' + pl : pl) : codec }); }
    const ch = parseInt(String(s.channels || ''), 10);
    if (isFinite(ch) && ch > 0) {
        const lay = String(s.channel_layout || '');
        rows.push({ id: 'channels', v: ch + (lay ? ' (' + lay + ')' : '') });
    }
    const sr = parseInt(String(s.sample_rate || ''), 10);
    if (isFinite(sr) && sr > 0) { rows.push({ id: 'samplerate', v: fmtHz(sr) }); }
    const sf = String(s.sample_fmt || '');
    if (sf) { rows.push({ id: 'samplefmt', v: sf }); }
    const br = parseInt(String(s.bit_rate || ''), 10);
    if (isFinite(br) && br > 0) { rows.push({ id: 'abitrate', v: fmtBitrate(br) }); }
    return rows;
}

function _formatRows(fmt: any, streams: any[], v: any, a: any): InfoRow[] {
    const rows: InfoRow[] = [];
    if (fmt) {
        const fl = String(fmt.format_long_name || fmt.format_name || '');
        if (fl) { rows.push({ id: 'container', v: fl }); }
        const dur = parseFloat(String(fmt.duration || ''));
        if (isFinite(dur) && dur > 0) { rows.push({ id: 'duration', v: fmtDur(dur) }); }
        const br = parseInt(String(fmt.bit_rate || ''), 10);
        if (isFinite(br) && br > 0) { rows.push({ id: 'bitrate', v: fmtBitrate(br) }); }
    }
    const cnt: Record<string, number> = {};
    for (const s of streams) { const t = String((s && s.codec_type) || '?'); cnt[t] = (cnt[t] || 0) + 1; }
    const parts: string[] = [];
    for (const t of ['video', 'audio', 'subtitle', 'data', 'attachment']) { if (cnt[t]) { parts.push(cnt[t] + ' ' + t); } }
    rows.push({ id: 'streams', v: String(streams.length) + (parts.length ? ' (' + parts.join(' · ') + ')' : '') });
    // 附加流（主视频/主音频之外的每条）：'#2 · subtitle · subrip'（封面图 = 'video (cover)' 标注）
    for (const s of streams) {
        if (s === v || s === a) { continue; }
        const idx = Number(s && s.index);
        const t = String((s && s.codec_type) || '?');
        const c = String((s && s.codec_name) || '');
        const pic = (t === 'video' && s && s.disposition && Number(s.disposition.attached_pic) === 1) ? ' (cover)' : '';
        rows.push({ id: 'extra', v: '#' + (isFinite(idx) ? idx : '?') + ' · ' + t + pic + (c ? ' · ' + c : '') });
    }
    const enc = (fmt && fmt.tags) ? String(fmt.tags.encoder || '') : '';
    if (enc) { rows.push({ id: 'encoder', v: enc }); }
    return rows;
}

/** 归一 = ffprobe JSON + stat → 展示区块（渲染层只做 row.id→i18n 标签映射）。
 *  probeState !== 'ok' → 只出「文件/时间」区块（渲染层附「编码信息不可用」提示）。 */
export function buildMediaInfo(probe: any, st: MediaInfoStat, probeState: ProbeState): InfoSection[] {
    const sections: InfoSection[] = [];
    try {
        const streams = (probe && Array.isArray(probe.streams)) ? probe.streams : [];
        const fmt = (probe && probe.format && typeof probe.format === 'object') ? probe.format : null;
        if (probeState === 'ok') {
            const m = pickMainStreams(streams);
            if (m.video) { const rows = _videoRows(m.video); if (rows.length) { sections.push({ id: 'video', rows }); } }
            if (m.audio) { const rows = _audioRows(m.audio); if (rows.length) { sections.push({ id: 'audio', rows }); } }
            sections.push({ id: 'format', rows: _formatRows(fmt, streams, m.video, m.audio) });
        }
        const p = String((st && st.path) || '');
        const fp = p.replace(/\\/g, '/');
        const name = fp.split('/').pop() || p;
        const dir = fp.indexOf('/') >= 0 ? fp.slice(0, fp.lastIndexOf('/')) : '';
        const fileRows: InfoRow[] = [];
        if (name) { fileRows.push({ id: 'filename', v: name }); }
        if (dir) { fileRows.push({ id: 'location', v: dir }); }
        if (isFinite(st.size) && st.size > 0) {
            const human = fmtBytes(st.size);
            const exact = fmtExact(st.size) + ' B';
            fileRows.push({ id: 'size', v: (human === exact) ? exact : (human + ' · ' + exact) });
        }
        if (fileRows.length) { sections.push({ id: 'file', rows: fileRows }); }
        const timeRows: InfoRow[] = [];
        if (st.mtimeMs > 0) { timeRows.push({ id: 'mtime', v: fmtTs(st.mtimeMs) }); }
        // 创建时间：birthtime 优先；无 birthtime 的文件系统回落 ctime（尽力而为）
        const born = (st.birthtimeMs > 0) ? st.birthtimeMs : ((st.ctimeMs > 0) ? st.ctimeMs : 0);
        if (born > 0) { timeRows.push({ id: 'ctime', v: fmtTs(born) }); }
        if (timeRows.length) { sections.push({ id: 'time', rows: timeRows }); }
    } catch { /* 归一失败 → 保底空表（渲染层显示失败态） */ }
    return sections;
}
