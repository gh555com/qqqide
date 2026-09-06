// ============================================================================
// file-encoding.ts — 文本文件编码机器（2026-09-05 GBK 乱码根治 · 最终闭环）
// ★ 唯一真理源：一切文本文件的读解码 / 写编码 / 编码固定 / 转换落盘全走本模块。
//   ★ 铁律：禁止在任何其他模块裸 readFile('utf8') / writeFile(str) 处理用户文本文件
//     （Node utf8 解码非 fatal → GBK 遗留文件必乱码；utf8 直写 → 保存即破坏原编码）。
//   详参 do/消除乱码（架构语义）与 do/拓扑/铁律 §8.1。
//
// 闭环语义（一句话）：检测错了也没关系 —— 读侧错 = 可逆（重新解码/固定即修）；
// 写侧 = 原编码回写 + 字节守恒 + 不可表示字符拒绝（永不静默 '?' 损伤）；
// 外部改写 = 新鲜度重测 + 固定与证据冲突自动弃固定（绝不带过期固定写盘）。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as iconv from 'iconv-lite';
import { ipcMain } from 'electron';

// ── 类型与常量 ────────────────────────────────────────────────────────────
export type EncName = 'utf8' | 'gbk' | 'gb18030' | 'big5' | 'shiftjis' | 'windows1252' | 'utf16le' | 'utf16be';
export interface FileEncInfo { enc: EncName; bom: boolean; pinned: EncName | null; }

interface EncRecord extends FileEncInfo { mtimeMs: number; size: number; }

const _mem = new Map<string, EncRecord>();          // 路径 → 最近一次解码/写入的编码证据（含文件指纹 mtime+size）
const _pins = new Map<string, EncName>();           // 路径 → 用户手动固定编码（逃生舱；null 语义=未固定）
const _MEM_MAX = 4000;

const _ICONV: Partial<Record<EncName, string>> = {
    gbk: 'gbk', gb18030: 'gb18030', big5: 'big5',
    shiftjis: 'shiftjis', windows1252: 'windows-1252'
};

// ★ 可丢失字符集：encode 遇不可表示字符写 '?'（静默损伤）→ 必须 roundtrip 守卫
//   gb18030 = 全 Unicode 映射（永不丢失）；utf8/utf16 = 全量无损 → 均免守卫
const _LOSSY_ENCS = new Set<EncName>(['gbk', 'big5', 'shiftjis', 'windows1252']);

export const ENC_LIST: Array<{ enc: EncName; label: string }> = [
    { enc: 'utf8', label: 'UTF-8' },
    { enc: 'gbk', label: 'GBK' },
    { enc: 'gb18030', label: 'GB18030' },
    { enc: 'big5', label: 'Big5' },
    { enc: 'shiftjis', label: 'Shift-JIS' },
    { enc: 'windows1252', label: 'Windows-1252' },
    { enc: 'utf16le', label: 'UTF-16 LE' },
    { enc: 'utf16be', label: 'UTF-16 BE' },
];
const _ENC_SET = new Set<string>(ENC_LIST.map(e => e.enc));

export function encLabel(enc: EncName): string {
    for (const e of ENC_LIST) if (e.enc === enc) return e.label;
    return String(enc);
}

function _key(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

function _encDefaultBom(enc: EncName): boolean {
    return enc === 'utf16le' || enc === 'utf16be';
}

const _tdUtf8Fatal = new TextDecoder('utf-8', { fatal: true });

// ── 原子写（本模块私有副本，防与 ipc-fs 循环依赖）──
async function _atomicWrite(absPath: string, data: Buffer): Promise<void> {
    const dir = path.dirname(absPath);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
    const tmp = absPath + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
    await fs.promises.writeFile(tmp, data as any);
    try {
        await fs.promises.rename(tmp, absPath);
    } catch (e: any) {
        if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
            try {
                const d = await fs.promises.readFile(tmp);
                await fs.promises.writeFile(absPath, d as any);
                try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            } catch (e2) {
                try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
                throw e2;
            }
        } else {
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            throw e;
        }
    }
}

// ── 检测链（权威）：BOM(UTF-8/UTF-16LE/BE) → 严格 UTF-8 → GBK 兜底 ──
export function detectEncoding(buf: Buffer): FileEncInfo {
    if (!buf || buf.length === 0) return { enc: 'utf8', bom: false, pinned: null };
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { enc: 'utf16le', bom: true, pinned: null };
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { enc: 'utf16be', bom: true, pinned: null };
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { enc: 'utf8', bom: true, pinned: null };
    try { _tdUtf8Fatal.decode(buf); return { enc: 'utf8', bom: false, pinned: null }; }
    catch { return { enc: 'gbk', bom: false, pinned: null }; } // GBK 超集解码几乎不失败
}

// ── 解码（BOM 剥离按 bom 标志；utf8 严格 fatal——失败由调用方裁决）──
function _decodeWith(enc: EncName, buf: Buffer, bom: boolean): string {
    let body = buf;
    if (bom) {
        const n = enc === 'utf8' ? 3 : 2;
        body = buf.length >= n ? buf.subarray(n) : Buffer.alloc(0);
    }
    if (enc === 'utf8') return _tdUtf8Fatal.decode(body);
    if (enc === 'utf16le') return body.toString('utf16le');
    if (enc === 'utf16be') {
        const sw = Buffer.from(body); // 拷贝再交换（swap16 原地）
        if (sw.length % 2 === 1) return body.toString('utf16le'); // 奇数长度不可能合法 → 不抛直接给调用方原始
        sw.swap16();
        return sw.toString('utf16le');
    }
    return iconv.decode(body, _ICONV[enc] as string);
}

// ── 编码 ──
export function encodeText(enc: EncName, bom: boolean, text: string): Buffer {
    if (enc === 'utf8') {
        const b = Buffer.from(text, 'utf8');
        return bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), b]) : b;
    }
    if (enc === 'utf16le') {
        const b = Buffer.from(text, 'utf16le');
        return bom ? Buffer.concat([Buffer.from([0xFF, 0xFE]), b]) : b;
    }
    if (enc === 'utf16be') {
        const b = Buffer.from(text, 'utf16le').swap16();
        return bom ? Buffer.concat([Buffer.from([0xFE, 0xFF]), b]) : b;
    }
    return iconv.encode(text, _ICONV[enc] as string);
}

// ★ 不可表示字符守卫：encode → decode 回读 ≠ 原文 = 有字符丢失 → 拒绝保存
//   （禁静默 '?' 损伤。GBK 无 emoji/生僻 Unicode 字符时保存必现此错误）
function _assertRepresentable(text: string, enc: EncName): void {
    if (!_LOSSY_ENCS.has(enc)) return;
    const map = _ICONV[enc] as string;
    const back = iconv.decode(iconv.encode(text, map), map);
    if (back === text) return;
    let i = 0;
    while (i < back.length && i < text.length && back[i] === text[i]) i++;
    const ch = text[i] != null ? text[i] : (back[i] != null ? back[i] : '?');
    let cp = '';
    try { cp = 'U+' + (ch.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0'); } catch { /* ignore */ }
    throw new Error('保存被拒：字符 "' + ch + '"（' + cp + '）无法用 ' + encLabel(enc) + ' 编码表示，内容未写入。可：① 删除该字符后重存；② 在标签页编码菜单选「另存为 UTF-8/GB18030」（全字符编码，永不丢失）。');
}

// ── 读取：解码 + 记忆/固定 语义 ──
//   字节未变（fresh）→ 固定优先，其次复用上次证据（零重复检测）；
//   字节已变 → 重新检测；固定与证据冲突 → 弃固定（外部改写后绝不带过期固定解码/写盘）。
//   固定 utf8 但字节并非合法 UTF-8 → 解码抛错 → 弃固定回落自动。
export async function decodeFile(p: string): Promise<{ text: string; info: FileEncInfo }> {
    const [buf, st] = await Promise.all([
        fs.promises.readFile(p),
        fs.promises.stat(p).catch(() => null)
    ]);
    const key = _key(p);
    let rec = _mem.get(key);
    const pin = _pins.get(key);
    const fresh = !!(rec && st && rec.mtimeMs === st.mtimeMs && rec.size === st.size);
    if (!fresh) {
        const det = detectEncoding(buf);
        if (pin && pin !== det.enc) _pins.delete(key); // 证据冲突弃固定
        rec = { enc: det.enc, bom: det.bom, pinned: null, mtimeMs: st ? st.mtimeMs : Date.now(), size: buf.length };
        _mem.set(key, rec);
    }
    const pinNow = _pins.get(key);
    const effEnc: EncName = (pinNow || rec.enc) as EncName;
    const effBom = (pinNow && pinNow !== rec.enc) ? _encDefaultBom(pinNow) : rec.bom;
    try {
        const text = _decodeWith(effEnc, buf, effBom);
        return { text, info: { enc: effEnc, bom: effBom, pinned: pinNow || null } };
    } catch (e) {
        // utf8 严格解码失败（固定 utf8 撞上非 utf8 字节）→ 弃固定回落自动证据
        if (pinNow) {
            _pins.delete(key);
            const det = detectEncoding(buf);
            _mem.set(key, { enc: det.enc, bom: det.bom, pinned: null, mtimeMs: st ? st.mtimeMs : Date.now(), size: buf.length });
            const text = _decodeWith(det.enc, buf, det.bom);
            return { text, info: { enc: det.enc, bom: det.bom, pinned: null } };
        }
        throw e;
    }
}

// ── 写入：原编码回写 / 强制另存 ──
//   forceEnc：null/undefined = 自动（固定优先，fresh 复用，外部已变则重测）；字符串 = 另存为该编码（清固定）。
export async function encodeFile(p: string, text: string, forceEnc?: EncName | null): Promise<void> {
    const key = _key(p);
    const pin = _pins.get(key);
    let st: any = null;
    try { st = await fs.promises.stat(p); } catch { /* ENOENT = 新文件 */ }
    let rec = _mem.get(key);
    const fresh = !!(rec && st && rec.mtimeMs === st.mtimeMs && rec.size === st.size);

    let enc: EncName;
    let bom: boolean;
    if (forceEnc) {
        enc = forceEnc;
        bom = _encDefaultBom(enc);
        _pins.delete(key); // 显式转换 = 新真理，旧固定一并作废
    } else if (!st) {
        // 新文件：固定 → 记录 → utf8
        enc = (pin || (rec ? rec.enc : 'utf8')) as EncName;
        bom = pin ? _encDefaultBom(pin) : (rec ? rec.bom : false);
    } else if (fresh) {
        enc = (pin || rec.enc) as EncName;
        bom = (pin && pin !== rec.enc) ? _encDefaultBom(pin) : rec.bom;
    } else {
        // 磁盘字节已变（外部写入）→ 重测证据；固定与证据冲突 → 弃固定
        const det = detectEncoding(await fs.promises.readFile(p));
        if (pin && pin !== det.enc) _pins.delete(key);
        enc = (_pins.get(key) || det.enc) as EncName;
        bom = (enc === det.enc) ? det.bom : _encDefaultBom(enc);
    }

    _assertRepresentable(text, enc);
    const out = encodeText(enc, bom, text);
    await _atomicWrite(p, out);
    let mtimeMs = Date.now();
    try { const s2 = await fs.promises.stat(p); if (s2) mtimeMs = s2.mtimeMs; } catch { /* ignore */ }
    if (_mem.size > _MEM_MAX) _mem.clear();
    _mem.set(key, { enc, bom, pinned: null, mtimeMs, size: out.length });
}

// ── 查询/固定（渲染层编码徽标 + 逃生舱 IPC）──
export function setFileEncoding(p: string, enc: EncName | null): void {
    const key = _key(p);
    if (!enc) { _pins.delete(key); return; }
    if (!_ENC_SET.has(enc)) return;
    _pins.set(key, enc);
}

// 有效信息（仅 fresh 时可信返回；渲染层均在 read 之后调用 → 恒 fresh）
export function fileEncInfo(p: string): FileEncInfo | null {
    const key = _key(p);
    const rec = _mem.get(key);
    if (!rec) return null;
    try {
        const st = fs.statSync(p);
        if (!(rec.mtimeMs === st.mtimeMs && rec.size === st.size)) return null; // 陈旧 → 等下次 read 重测
    } catch { return null; }
    const pin = _pins.get(key);
    return {
        enc: (pin || rec.enc) as EncName,
        bom: (pin && pin !== rec.enc) ? _encDefaultBom(pin) : rec.bom,
        pinned: pin || null
    };
}

// 同步纯解码（ipc-edit 语法门用；不触碰记忆/固定）
export function decodeFileSync(p: string): string {
    const buf = fs.readFileSync(p);
    if (!buf || buf.length === 0) return '';
    const det = detectEncoding(buf);
    return _decodeWith(det.enc, buf, det.bom);
}

// 同步编码（语法门还原用）
export function encodeTextSync(enc: EncName, bom: boolean, text: string): Buffer {
    return encodeText(enc, bom, text);
}

// ── IPC（经 registerFsIpc 注册）──
export function registerFileEncodingIpc(): void {
    ipcMain.handle('qqqide:fs:encoding', async (_e, p: string) => {
        try {
            const st = await fs.promises.stat(p);
            if (!st || !st.isFile()) return null;
            return fileEncInfo(p);
        } catch { return null; }
    });
    ipcMain.handle('qqqide:fs:setFileEncoding', async (_e, p: string, enc: EncName | null) => {
        setFileEncoding(p, enc || null);
        return true;
    });
}
