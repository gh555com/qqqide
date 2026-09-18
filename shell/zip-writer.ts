// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// zip-writer.ts — 导出机专用 ZIP 写入器（零依赖，~200 行）
//
// 老 q3 语义移植（原实现 = npm archiver "zip" { zlib: { level: 9 } }）：
//   · deflate level 9 流式压缩（大文件零整读——防 175MB 视频全量进内存）
//   · 数据描述符模式（general purpose bit 3）：本地头先写、CRC/尺寸流后补
//     —— 与 zip-stream 同机制，条目顺序流式产出
//   · 路径净化 = zip-stream sanitizePath 同款（\ → /、去首斜杠、去 . / .. 段）
//   · UTF-8 文件名（bit 11）——Win10+/macOS/Linux 全支持
//   · 目录条目（尾部 /，method 0 零字节）
//
// 边界（诚实声明）：不支持 ZIP64——单文件 ≥4GB 或压缩包总量 ≥4GB 直接抛错
//   （老 archiver 默认也走 zip64 关闭路径同样受限；导出场景无此必要）。
// ============================================================================

import * as fs from 'fs';
import * as zlib from 'zlib';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c >>> 0;
    }
    return t;
})();

/** 增量 CRC32（返回值 = 原始累加域，末次调用后由 finalizeCrc 收尾异或） */
function crc32Update(crc: number, buf: Buffer): number {
    let c = crc;
    for (let i = 0; i < buf.length; i++) {
        c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    }
    return c >>> 0;
}
function crc32(data: Buffer): number {
    return (crc32Update(0xFFFFFFFF, data) ^ 0xFFFFFFFF) >>> 0;
}
/** 流式 CRC 收尾（配合起点 0xFFFFFFFF 的预反域） */
function crcFlush(c: number): number {
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d?: Date): { time: number; date: number } {
    const t = d || new Date();
    const year = Math.max(1980, t.getFullYear());
    const time = ((t.getHours() << 11) | (t.getMinutes() << 5) | (Math.floor(t.getSeconds() / 2))) & 0xFFFF;
    const date = (((year - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()) & 0xFFFF;
    return { time, date };
}

/** zip-stream sanitizePath 同款：整理为安全的正斜杠路径 */
export function sanitizeZipName(raw: string): string {
    const parts = String(raw || '').replace(/\\/g, '/').split('/');
    const out: string[] = [];
    for (const p of parts) {
        if (!p || p === '.') { continue; }
        if (p === '..') { continue; }
        out.push(p);
    }
    return out.join('/');
}

interface ZipEntry {
    name: string;       // zip 内部路径（UTF-8）
    nameBuf: Buffer;
    method: 0 | 8;
    crc: number;
    csize: number;
    usize: number;
    offset: number;
    time: number;
    date: number;
    isDir: boolean;
}

const MAX32 = 0xFFFFFFFF;

export class ZipWriter {
    private out: fs.WriteStream | null = null;
    private offset = 0;
    private entries: ZipEntry[] = [];
    private _names = new Set<string>();
    private _bytesTotal = 0;

    constructor(private outPath: string) { }

    get bytesTotal(): number { return this._bytesTotal; }
    get entryCount(): number { return this.entries.length; }

    async open(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const ws = fs.createWriteStream(this.outPath);
            ws.once('open', () => resolve());
            ws.once('error', reject);
            this.out = ws;
        });
    }

    /** 低层写：正确尊重 backpressure（write 返 false → 等 drain） */
    private _w(buf: Buffer): Promise<void> {
        const ws = this.out;
        if (!ws) { return Promise.reject(new Error('zip_not_open')); }
        return new Promise<void>((resolve, reject) => {
            const ok = ws.write(buf);
            if (ok) { resolve(); return; }
            const onDrain = () => { ws.removeListener('error', onErr); resolve(); };
            const onErr = (e: Error) => { ws.removeListener('drain', onDrain); reject(e); };
            ws.once('drain', onDrain);
            ws.once('error', onErr);
        });
    }

    private _checkSize(v: number, what: string): void {
        if (v > MAX32) { throw new Error('zip64_unsupported: ' + what); }
    }

    /** 空目录条目 */
    async addDir(name: string): Promise<void> {
        const clean = sanitizeZipName(name);
        if (!clean) { return; }
        const dirName = clean + '/';
        if (this._names.has(dirName)) { return; }
        this._names.add(dirName);
        const dt = dosDateTime();
        const nameBuf = Buffer.from(dirName, 'utf8');
        const offset = this.offset;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);            // version needed
        lh.writeUInt16LE(0x0800, 6);        // UTF-8 flag
        lh.writeUInt16LE(0, 8);             // store
        lh.writeUInt16LE(dt.time, 10);
        lh.writeUInt16LE(dt.date, 12);
        lh.writeUInt32LE(0, 14);            // crc
        lh.writeUInt32LE(0, 18);            // csize
        lh.writeUInt32LE(0, 22);            // usize
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        await this._w(lh);
        await this._w(nameBuf);
        this.offset += lh.length + nameBuf.length;
        this.entries.push({ name: dirName, nameBuf, method: 0, crc: 0, csize: 0, usize: 0, offset, time: dt.time, date: dt.date, isDir: true });
    }

    /** 内存缓冲条目（docx XML / 图片 / 小文件） */
    async addBuffer(name: string, data: Buffer): Promise<void> {
        const clean = sanitizeZipName(name);
        if (!clean) { return; }
        if (this._names.has(clean)) { return; }
        this._names.add(clean);
        const dt = dosDateTime();
        const nameBuf = Buffer.from(clean, 'utf8');
        const crc = crc32(data);
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        if (compressed.length < data.length) {
            await this._addKnown(clean, nameBuf, 8, crc, compressed, data.length, dt);
        } else {
            await this._addKnown(clean, nameBuf, 0, crc, data, data.length, dt);
        }
    }

    private async _addKnown(name: string, nameBuf: Buffer, method: 0 | 8, crc: number,
        payload: Buffer, usize: number, dt: { time: number; date: number }): Promise<void> {
        this._checkSize(usize, name);
        this._checkSize(payload.length, name);
        this._checkSize(this.offset, 'archive');
        const offset = this.offset;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(dt.time, 10);
        lh.writeUInt16LE(dt.date, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(payload.length, 18);
        lh.writeUInt32LE(usize, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        await this._w(lh);
        await this._w(nameBuf);
        await this._w(payload);
        this.offset += lh.length + nameBuf.length + payload.length;
        this._bytesTotal += usize;
        this.entries.push({ name, nameBuf, method, crc, csize: payload.length, usize, offset, time: dt.time, date: dt.date, isDir: false });
    }

    /**
     * 磁盘文件条目——流式（数据描述符模式）。
     * onProgress(已压缩字节) 供 zip 导出进度条。
     */
    async addFileFromDisk(name: string, srcPath: string, onProgress?: (compressedBytes: number) => void): Promise<void> {
        const clean = sanitizeZipName(name);
        if (!clean) { return; }
        if (this._names.has(clean)) { return; }
        this._names.add(clean);
        const st = await fs.promises.stat(srcPath);
        this._checkSize(st.size, clean);
        this._checkSize(this.offset, 'archive');
        const dt = dosDateTime(st.mtime);
        const nameBuf = Buffer.from(clean, 'utf8');
        const offset = this.offset;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0x0808, 6);        // bit3 (data descriptor) + bit11 (UTF-8)
        lh.writeUInt16LE(8, 8);             // deflate
        lh.writeUInt16LE(dt.time, 10);
        lh.writeUInt16LE(dt.date, 12);
        lh.writeUInt32LE(0, 14);
        lh.writeUInt32LE(0, 18);
        lh.writeUInt32LE(0, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        await this._w(lh);
        await this._w(nameBuf);
        let written = lh.length + nameBuf.length;

        // —— 流式压体 ——（CRC 起点 = 0xFFFFFFFF 预反，末次 crcFlush 收尾异或——标准 CRC32）
        let crc = 0xFFFFFFFF, usize = 0, csize = 0;
        const def = zlib.createDeflateRaw({ level: 9 });
        const rs = fs.createReadStream(srcPath, { highWaterMark: 1 << 20 });
        const pendingWrites: Promise<void>[] = [];
        let writeErr: Error | null = null;
        def.on('data', (chunk: Buffer) => {
            csize += chunk.length;
            def.pause();
            pendingWrites.push(
                this._w(chunk).then(
                    () => { def.resume(); },
                    (e: Error) => { writeErr = e; },
                ),
            );
            if (onProgress) { try { onProgress(csize); } catch { /* ignore */ } }
        });
        rs.on('data', (chunk: Buffer) => { crc = crc32Update(crc, chunk); usize += chunk.length; });
        await new Promise<void>((resolve, reject) => {
            rs.once('error', reject);
            def.once('error', reject);
            def.once('end', () => resolve());
            rs.pipe(def);
        });
        await Promise.all(pendingWrites);
        if (writeErr) { throw writeErr; }
        const crcFinal = crcFlush(crc);
        this._checkSize(usize, clean);
        this._checkSize(csize, clean);
        // 数据描述符（带签名版本，兼容性最好）
        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crcFinal, 4);
        dd.writeUInt32LE(csize, 8);
        dd.writeUInt32LE(usize, 12);
        await this._w(dd);
        written += csize + dd.length;
        this.offset += written;
        this._bytesTotal += usize;
        this.entries.push({ name: clean, nameBuf, method: 8, crc: crcFinal, csize, usize, offset, time: dt.time, date: dt.date, isDir: false });
    }

    /** 收尾：中央目录 + EOCD，关闭流 */
    async finalize(): Promise<void> {
        const cdStart = this.offset;
        for (const e of this.entries) {
            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0);
            cd.writeUInt16LE(20, 4);         // version made by
            cd.writeUInt16LE(20, 6);         // version needed
            cd.writeUInt16LE(e.isDir ? 0x0800 : 0x0808, 8);
            cd.writeUInt16LE(e.method, 10);
            cd.writeUInt16LE(e.time, 12);
            cd.writeUInt16LE(e.date, 14);
            cd.writeUInt32LE(e.crc, 16);
            cd.writeUInt32LE(e.csize, 20);
            cd.writeUInt32LE(e.usize, 24);
            cd.writeUInt16LE(e.nameBuf.length, 28);
            cd.writeUInt16LE(0, 30);         // extra len
            cd.writeUInt16LE(0, 32);         // comment len
            cd.writeUInt16LE(0, 34);         // disk start
            cd.writeUInt16LE(0, 36);         // internal attrs
            cd.writeUInt32LE(e.isDir ? 0x10 : 0, 38);  // external attrs
            cd.writeUInt32LE(e.offset, 42);
            await this._w(cd);
            await this._w(e.nameBuf);
            this.offset += cd.length + e.nameBuf.length;
        }
        const cdSize = this.offset - cdStart;
        this._checkSize(cdSize, 'central-directory');
        this._checkSize(cdStart, 'central-directory-offset');
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(this.entries.length, 8);
        eocd.writeUInt16LE(this.entries.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);
        await this._w(eocd);
        await new Promise<void>((resolve, reject) => {
            const ws = this.out!;
            ws.once('error', reject);
            ws.end(() => resolve());
        });
        this.out = null;
    }

    /** 异常中止（调用方负责删半成品文件） */
    abort(): void {
        try { if (this.out) { this.out.destroy(); } } catch { /* ignore */ }
        this.out = null;
    }
}
