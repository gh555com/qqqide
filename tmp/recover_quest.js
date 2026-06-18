const fs = require('fs');
const initSqlJs = require('../node_modules/sql.js');

const corruptPath = 'e:/s/wol/py/qqq-shell-v2/qqq/alphal/quest.sq3.corrupt.1781708232142';
const outPath = 'e:/s/wol/py/qqq-shell-v2/qqq/alphal/quest.sq3';

async function main() {
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(corruptPath);
    console.log('corrupt file size:', buf.length);

    // 尝试1：直接打开
    let db;
    try {
        db = new SQL.Database(buf);
        console.log('opened OK');
    } catch (e) {
        console.log('open failed:', e.message);
        console.log('trying hex edit: zero out first byte pointer...');
        // 尝试修复文件头
        const buf2 = Buffer.from(buf);
        // SQLite header: "SQLite format 3\0" at offset 0
        // page size at offset 16-17
        const pageSize = buf2.readUInt16BE(16);
        console.log('page size:', pageSize);
        // Try creating fresh db
        db = new SQL.Database();
        console.log('created fresh db - data unrecoverable via sql.js');
        process.exit(0);
    }

    // 尝试2：读取sqlite_master
    try {
        const r = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'");
        console.log('tables:', JSON.stringify(r).slice(0, 500));
    } catch (e) {
        console.log('master failed:', e.message);
        // 尝试 repair: export then re-import page by page
        const exported = db.export();
        console.log('exported size:', exported.length);

        // 尝试用备份文件头拼接
        try {
            const db2 = new SQL.Database(Buffer.from(exported));
            const r2 = db2.exec("SELECT name FROM sqlite_master");
            console.log('re-export ok, tables:', JSON.stringify(r2));
        } catch (e2) {
            console.log('re-export also fails:', e2.message);
        }
    }

    // 尝试3：PRAGMA integrity_check
    try {
        const r = db.exec("PRAGMA integrity_check");
        console.log('integrity:', JSON.stringify(r));
    } catch (e) {
        console.log('integrity check failed:', e.message);
    }

    // 尝试4：获取每个表的 row 数量
    const tables = ['data', 'schemas', 'changelog', 'floors'];
    for (const t of tables) {
        try {
            const r = db.exec("SELECT count(*) FROM " + t);
            console.log(t, 'count:', JSON.stringify(r));
        } catch (e) {
            console.log(t, 'error:', e.message.slice(0, 80));
        }
    }
}
main().catch(console.error);
