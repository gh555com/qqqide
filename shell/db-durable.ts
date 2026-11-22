// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// db-durable.ts — SQLite 文件落盘耐久性唯一入口（fsync + 页 1 头校验）
//
// 为什么存在：
//   1) writeFile 不 fsync 时数据只停在系统页缓存 —— 掉电/硬重启后 NTFS 只保住「文件长度」，
//      内容全是 0。这样的库读起来就是 "file is not a database"，而且长度看起来完全正常，
//      极易被误判成「已落盘」。落盘必须 fsync。
//   2) 校验不能只跑 SELECT 1 —— 该语句不读页 1，全零/垃圾文件也能「验证通过」。
//      校验必须先看 16 字节魔数，再真读 sqlite_master。
//
// 用法（所有 sql.js 落盘路径共用，禁各自手写）：
//   writeFileDurableSync(tmp, buf) → renameSync(tmp, dbPath)
//   if (fs.existsSync(dbPath) && hasSqliteHeaderOnDisk(dbPath)) copyFileSync(dbPath, dbPath + '.prev')
// ============================================================================

import * as fs from 'fs';

/** SQLite 页 1 前 16 字节（文件头魔数） */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

/** 头魔数校验（页 1 前 16 字节） */
export function hasSqliteHeader(data: Uint8Array | Buffer | null | undefined): boolean {
    try {
        if (!data || data.length < 16) return false;
        for (let i = 0; i < 16; i++) { if (data[i] !== SQLITE_MAGIC[i]) return false; }
        return true;
    } catch { return false; }
}

/** 快速头校验（只读前 16 字节，不载入整库）—— 落盘前 / 备份轮换闸门用 */
export function hasSqliteHeaderOnDisk(file: string): boolean {
    let fd = -1;
    try {
        const st = fs.statSync(file);
        if (!st || st.size < 1024) return false;
        const buf = Buffer.alloc(16);
        fd = fs.openSync(file, 'r');
        const n = fs.readSync(fd, buf, 0, 16, 0);
        return n === 16 && hasSqliteHeader(buf);
    } catch { return false; }
    finally { if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** 写 + fsync（真落盘）。文件系统不支持 fsync 时退化为普通写，不阻断调用方。 */
export function writeFileDurableSync(file: string, buf: Buffer): void {
    fs.writeFileSync(file, buf as any);
    let fd = -1;
    try { fd = fs.openSync(file, 'r+'); fs.fsyncSync(fd); } catch { /* ignore */ }
    finally { if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** 写 + fsync（异步版，主进程热路径用） */
export async function writeFileDurable(file: string, buf: Buffer): Promise<void> {
    const fh = await fs.promises.open(file, 'w');
    try {
        await fh.writeFile(buf as any);
        try { await fh.sync(); } catch { /* 不支持 fsync → 退化为普通写 */ }
    } finally {
        try { await fh.close(); } catch { /* ignore */ }
    }
}
