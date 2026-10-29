// ci/tests/timeline-key.test.js — 时间线路径键与撞名对账回归（方案 C：无损写入 + stat 仲裁）
//   铁律：path_key 查不到 ≠ 新文件；只有撞 fold_key 且 stat 证明同一 (dev,ino) 才归并。
//   方向恒为「裂而不并」——裂可自愈，并不可逆。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILD = path.join(__dirname, '.build', 'timeline-store.cjs');
const S = require(BUILD);

// 平台在模块加载期定格（_TL_WIN）——换平台 = 换缓存再 require
function loadFor(platform) {
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    delete require.cache[require.resolve(BUILD)];
    const mod = require(BUILD);
    return {
        mod,
        restore() {
            Object.defineProperty(process, 'platform', { value: prev, configurable: true });
            delete require.cache[require.resolve(BUILD)];
            require(BUILD);   // 把缓存恢复成真实平台实例，别污染后续测试
        },
    };
}

function mkProject(tag) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqqtl-' + tag + '-'));
    fs.mkdirSync(path.join(root, '_qqq', 'timeline'), { recursive: true });
    return root;
}
function rmProject(root) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { }
    try {
        for (const k of Array.from(S._timelineDbs.keys())) {
            if (k.indexOf(root.replace(/\\/g, '/')) !== -1 || k.indexOf(root) !== -1) S._timelineDbs.delete(k);
        }
    } catch (_) { }
}
function dbFile(root) { return path.join(root, '_qqq', 'timeline', 'timeline.db'); }

async function open(root) { return await S._tlOpenDb(root); }

function rowsOf(db, key) {
    const st = db.prepare('SELECT file_seq, blob_hash, path_key FROM versions WHERE path_key = ? ORDER BY file_seq ASC');
    st.bind([key]);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
}
function allRows(db) {
    const r = db.exec('SELECT path_key, file_seq, blob_hash, file_path, path_raw FROM versions ORDER BY ts ASC, id ASC');
    if (!r[0]) return [];
    return r[0].values.map((v) => ({ path_key: v[0], file_seq: v[1], blob_hash: v[2], file_path: v[3], path_raw: v[4] }));
}

// ─────────────────────────── 纯函数层 ───────────────────────────

test('显示路径：win32 才转分隔符并大写盘符；POSIX 反斜杠是合法文件名字符，原样保留', () => {
    const w = loadFor('win32');
    try {
        assert.strictEqual(w.mod._tlNormDisplayPath('e:\\a\\b.txt'), 'E:/a/b.txt');
        assert.strictEqual(w.mod._tlPathKey('E:\\a\\b.txt'), 'E:/a/b.txt');
        assert.strictEqual(w.mod._tlPathKey('e:/a/b.txt'), 'E:/a/b.txt');   // 盘符大小写 = 零信息，归一
    } finally { w.restore(); }

    const l = loadFor('linux');
    try {
        assert.strictEqual(l.mod._tlNormDisplayPath('/tmp/a\\b.txt'), '/tmp/a\\b.txt');
        assert.notStrictEqual(l.mod._tlPathKey('/tmp/a\\b.txt'), l.mod._tlPathKey('/tmp/a/b.txt'));
    } finally { l.restore(); }
});

test('无损键：折叠 . / .. / 重复斜杠；大小写与 Unicode 组合式绝不进 path_key（那是提示键的事）', () => {
    assert.strictEqual(S._tlPathKey('/p/./a//b/../c.txt'), '/p/a/c.txt');
    assert.strictEqual(S._tlPathKey('/p/a/c.txt'), '/p/a/c.txt');
    assert.strictEqual(S._tlPathKey('/p/../../x'), '/x');            // 越过根 → 丢弃（与 OS 解析同义）
    assert.notStrictEqual(S._tlPathKey('/p/README.md'), S._tlPathKey('/p/readme.md'));
    assert.strictEqual(S._tlFoldKey('/p/README.md'), S._tlFoldKey('/p/readme.md'));

    const nfc = '/p/caf\u00e9.txt', nfd = '/p/cafe\u0301.txt';
    assert.notStrictEqual(S._tlPathKey(nfc), S._tlPathKey(nfd));     // 磁盘上可能是两个真文件
    assert.strictEqual(S._tlFoldKey(nfc), S._tlFoldKey(nfd));        // 提示键：可能同一个 → 对账去问文件系统
});

// ─────────────────────── 写入侧撞名对账（真库 + 真文件） ───────────────────────

test('写入：大小写变体且 stat 同一 inode → 归并为一条历史，file_seq 重排 1..N', async () => {
    const root = mkProject('merge');
    try {
        const file = path.join(root, 'Doc.txt');
        fs.writeFileSync(file, 'v1');
        const db = await open(root);
        const r1 = S._tlCommit(db, dbFile(root), root, { file_path: file, ts: 1000, blob_hash: S._sha256('v1'), source: 'q' });
        assert.strictEqual(r1.recorded, true);
        assert.strictEqual(r1.file_seq, 1);

        fs.writeFileSync(file, 'v2');
        const r2 = S._tlCommit(db, dbFile(root), root, { file_path: path.join(root, 'DOC.TXT'), ts: 2000, blob_hash: S._sha256('v2'), source: 'q' });
        assert.strictEqual(r2.recorded, true);
        assert.strictEqual(r2.file_seq, 2);                            // 归并后接着编号，不是从 1 重开

        const all = allRows(db);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 1);   // 只有一个键
        assert.deepStrictEqual(all.map((r) => r.file_seq), [1, 2]);

        // 换第三种写法查询也要取到同一段历史
        const keys = S._tlReadKeys(db, path.join(root, 'doc.txt'));
        assert.deepStrictEqual(rowsOf(db, keys[0]).length, 2);
    } finally { rmProject(root); }
});

test('写入：折叠撞名但 inode 不同（NFC/NFD 两只真文件）→ 保持两条历史（裂而不并）', async (t) => {
    if (process.platform === 'darwin') { t.skip('APFS 不允 NFC/NFD 并存'); return; }
    const root = mkProject('split');
    try {
        const nfc = path.join(root, 'caf\u00e9.txt');
        const nfd = path.join(root, 'cafe\u0301.txt');
        fs.writeFileSync(nfc, 'nfc');
        fs.writeFileSync(nfd, 'nfd');
        const db = await open(root);
        S._tlCommit(db, dbFile(root), root, { file_path: nfc, ts: 1000, blob_hash: S._sha256('nfc'), source: 'q' });
        S._tlCommit(db, dbFile(root), root, { file_path: nfd, ts: 2000, blob_hash: S._sha256('nfd'), source: 'q' });
        const all = allRows(db);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 2);   // 两个不同文件 → 两条线
    } finally { rmProject(root); }
});

test('写入：无 stat 证据（文件已删除）→ 不合并（方向恒为裂而不并）', async () => {
    const root = mkProject('gone');
    try {
        const gone = path.join(root, 'Gone.txt');
        fs.writeFileSync(gone, 'v1');
        const db = await open(root);
        S._tlCommit(db, dbFile(root), root, { file_path: gone, ts: 1000, blob_hash: S._sha256('v1'), source: 'q' });
        fs.unlinkSync(gone);                                           // 证据消失
        S._tlCommit(db, dbFile(root), root, { file_path: path.join(root, 'gone.txt'), ts: 2000, blob_hash: S._sha256('v2'), source: 'q' });
        const all = allRows(db);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 2);
    } finally { rmProject(root); }
});

test('写入：硬链接（同一 inode 两个名字）永不被合并——名字不折叠就永不撞名', async () => {
    const root = mkProject('hardlink');
    try {
        const a = path.join(root, 'a.txt');
        const b = path.join(root, 'b.txt');
        fs.writeFileSync(a, 'same');
        fs.linkSync(a, b);
        const db = await open(root);
        S._tlCommit(db, dbFile(root), root, { file_path: a, ts: 1000, blob_hash: S._sha256('same'), source: 'q' });
        S._tlCommit(db, dbFile(root), root, { file_path: b, ts: 2000, blob_hash: S._sha256('same'), source: 'q' });
        const all = allRows(db);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 2);
    } finally { rmProject(root); }
});

test('写入：path_raw 恒为调用方给的原始路径（POSIX 上反斜杠不被改写）', async () => {
    const root = mkProject('raw');
    try {
        const rawWin = path.join(root, 'raw.txt');
        fs.writeFileSync(rawWin, 'x');
        const db = await open(root);
        S._tlCommit(db, dbFile(root), root, { file_path: rawWin, ts: 1000, blob_hash: S._sha256('x'), source: 'q' });
        const all = allRows(db);
        assert.strictEqual(all[0].path_raw, rawWin);
    } finally { rmProject(root); }
});

// ─────────────────── 存量迁移：旧合并成果不回归（norm_ver 驱动） ───────────────────

test('迁移：旧折叠键库（norm_ver 缺失）→ 派生列重算，旧合并成果保留为 1..N', async () => {
    const root = mkProject('migrate');
    try {
        // 手工造旧库：两条被历史折成同一 path_key 的记录，文件已不存在（无 stat 证据）
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();
        const old = new SQL.Database();
        old.run(`CREATE TABLE versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL, ts INTEGER NOT NULL, blob_hash TEXT NOT NULL,
            source TEXT NOT NULL, floor_id TEXT, added_lines INTEGER, deleted_lines INTEGER,
            file_seq INTEGER, path_key TEXT)`);
        const p1 = 'E:/none/Deep.txt', p2 = 'e:/none/deep.txt';
        old.run('INSERT INTO versions (file_path, ts, blob_hash, source, file_seq, path_key) VALUES (?,?,?,?,?,?)',
            [p1, 1000, S._sha256('a'), 'q', 1, 'e:/none/deep.txt']);
        old.run('INSERT INTO versions (file_path, ts, blob_hash, source, file_seq, path_key) VALUES (?,?,?,?,?,?)',
            [p2, 2000, S._sha256('b'), 'q', 2, 'e:/none/deep.txt']);
        fs.writeFileSync(dbFile(root), Buffer.from(old.export()));

        const db = await open(root);
        const all = allRows(db);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 1);   // 无证据 → 继承旧结论，不回归
        assert.deepStrictEqual(all.map((r) => r.file_seq), [1, 2]);
        const nv = db.exec('SELECT COUNT(*) FROM versions WHERE norm_ver = ' + S.TL_NORM_VER);
        assert.strictEqual(nv[0].values[0][0], 2);
        const pre = path.join(root, '_qqq', 'timeline', 'timeline.db.pre-migrate');
        assert.ok(fs.existsSync(pre), '迁移前必须留底（唯一回滚通道）');
    } finally { rmProject(root); }
});

test('UNC 前缀 //server/share 恒原样保留（不得塔成单斜杠与 POSIX 绝对路径撞键）', () => {
    assert.strictEqual(S._tlPathKey('//srv/share/a.txt'), '//srv/share/a.txt');
    assert.notStrictEqual(S._tlPathKey('//srv/share/a.txt'), S._tlPathKey('/srv/share/a.txt'));
    assert.strictEqual(S._tlPathKey('//srv/share/./sub/../a.txt'), '//srv/share/a.txt');
});

test('写入：file_path 恒为显示形态（调用方给的反斜杠/小写盘符不落库）；path_raw 保留原样', async () => {
    const root = mkProject('display');
    try {
        const file = path.join(root, 'Raw.txt');
        fs.writeFileSync(file, 'v1');
        const db = await open(root);
        S._tlCommit(db, dbFile(root), root, { file_path: file, ts: 1000, blob_hash: S._sha256('v1'), source: 'q' });
        const all = allRows(db);
        assert.strictEqual(all[0].file_path, S._tlNormDisplayPath(file));
        assert.strictEqual(all[0].path_key, S._tlPathKey(file));
        assert.strictEqual(all[0].path_raw, file);          // 原始路径不改写（stat 对账要用它）
    } finally { rmProject(root); }
});

test('启动：旧库 + 未压缩 WAL → 回放先于迁移，历史归并为一段 1..N', async () => {
    const root = mkProject('wal-migrate');
    try {
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();
        const old = new SQL.Database();
        old.run(`CREATE TABLE versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL, ts INTEGER NOT NULL, blob_hash TEXT NOT NULL,
            source TEXT NOT NULL, floor_id TEXT, added_lines INTEGER, deleted_lines INTEGER,
            file_seq INTEGER, path_key TEXT)`);
        // 旧规则：这两行曾被折成同一个 key（文件名小写），历史被拆成两段的典型现场
        old.run('INSERT INTO versions (file_path, ts, blob_hash, source, file_seq, path_key) VALUES (?,?,?,?,?,?)',
            ['E:/none/deep.txt', 1000, S._sha256('a'), 'q', 1, 'e:/none/deep.txt']);
        fs.writeFileSync(dbFile(root), Buffer.from(old.export()));
        // 未压缩的 WAL：上一次会话按旧键写下的第二行（文件已删 → 无 stat 证据，靠旧结论继承）
        fs.writeFileSync(path.join(root, '_qqq', 'timeline', 'timeline.wal'),
            JSON.stringify({ p: 'E:/none/Deep.txt', k: 'e:/none/deep.txt', r: 'E:/none/Deep.txt', q: 2, t: 2000, h: S._sha256('b'), s: 'q' }) + '\n');

        const db = await open(root);
        const all = allRows(db);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 1);    // 回放行参与了归并，没把组撞开
        assert.deepStrictEqual(all.map((r) => r.file_seq), [1, 2]);
    } finally { rmProject(root); }
});

test('归并是库内 UPDATE（WAL 记不到）→ 必须当场落盘，重启不被旧 WAL 行撞回两段', async (t) => {
    const root = mkProject('merge-durable');
    try {
        const a = path.join(root, 'Doc.txt');
        fs.writeFileSync(a, 'v1');
        if (!fs.existsSync(path.join(root, 'DOC.TXT'))) { t.skip('大小写敏感卷：两个名字是两个文件，归并语义不适用'); return; }
        const db1 = await open(root);
        S._tlCommit(db1, dbFile(root), root, { file_path: a, ts: 1000, blob_hash: S._sha256('v1'), source: 'q' });
        fs.writeFileSync(a, 'v2');
        S._tlCommit(db1, dbFile(root), root, { file_path: path.join(root, 'DOC.TXT'), ts: 2000, blob_hash: S._sha256('v2'), source: 'q' });
        S._timelineDbs.clear();          // 模拟进程重启（不做退出落盘）
        const db2 = await open(root);
        const all = allRows(db2);
        assert.strictEqual(new Set(all.map((r) => r.path_key)).size, 1);
        assert.deepStrictEqual(all.map((r) => r.file_seq), [1, 2]);
    } finally { rmProject(root); }
});

test('开库修复：已迁移的库（norm_ver 当前，不跑全量重算）仍会重号重排', async () => {
    const root = mkProject('repair');
    try {
        const file = path.join(root, 'Rep.txt');
        fs.writeFileSync(file, 'v1');
        const db = await open(root);
        S._tlCommit(db, dbFile(root), root, { file_path: file, ts: 1000, blob_hash: S._sha256('v1'), source: 'q' });
        S._tlCommit(db, dbFile(root), root, { file_path: file, ts: 2000, blob_hash: S._sha256('v2'), source: 'q' });
        db.run("UPDATE versions SET file_seq = 1");          // 人为造重号
        S._tlFlushNow(db, dbFile(root), root);
        S._timelineDbs.clear();

        const db2 = await open(root);
        const all = allRows(db2);
        assert.deepStrictEqual(all.map((r) => r.file_seq), [1, 2]);
    } finally { rmProject(root); }
});

test('迁移：幂等——同一库再开一次不改任何行', async () => {
    const root = mkProject('idem');
    try {
        const file = path.join(root, 'Idem.txt');
        fs.writeFileSync(file, 'v1');
        const db1 = await open(root);
        S._tlCommit(db1, dbFile(root), root, { file_path: file, ts: 1000, blob_hash: S._sha256('v1'), source: 'q' });
        S._tlFlushNow(db1, dbFile(root), root);
        S._timelineDbs.clear();

        const db2 = await open(root);
        const all = allRows(db2);
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0].file_seq, 1);
        assert.strictEqual(all[0].path_key, S._tlPathKey(file));
    } finally { rmProject(root); }
});
