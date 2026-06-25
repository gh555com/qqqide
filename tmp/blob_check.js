const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync('E:/s/wol/py/qqq-shell-v2/qqq/timeline/timeline.db');
  const db = new SQL.Database(buf);
  
  // Search by blob hash from q40 f1 a4Snapshots
  const hashes = [
    'd53d79af3c67560cd8e56585978da727778a17cb29a7fc0f6c5e420585e2c8b0',
    '529d39ef592aac7b87d841aa1dcf2c431807cf603ab2a267bf9f447ad93c7676',
    '77d5ab432f5c789d17b27621993911cefbcecc66f543c5fb76b7e985d0d2171e',
    'ec86ae3816e37e53aac1ffb89a612e0b60750caafd3b5d63fb8f7ce7074ef1b5'
  ];
  
  for (const h of hashes) {
    const res = db.exec("SELECT id, ts, source, added_lines, deleted_lines, floor_id, file_path FROM versions WHERE blob_hash = '" + h + "'");
    if (res.length > 0) {
      console.log('blob ' + h.substring(0,12) + '...:');
      res[0].values.forEach(v => {
        const r = {};
        res[0].columns.forEach((c,i) => { r[c] = v[i]; });
        r.file_path = (r.file_path||'').replace(/\\/g,'/').replace('E:/s/wol/py/qqq-shell-v2/','');
        console.log('  ' + JSON.stringify(r));
      });
    } else {
      console.log('blob ' + h.substring(0,12) + '...: NOT FOUND');
    }
  }
  
  // Also check: all file paths containing 'gateway'
  console.log('\n=== All *gateway* files ===');
  const res = db.exec("SELECT id, ts, source, added_lines, deleted_lines, floor_id, file_path FROM versions WHERE file_path LIKE '%gateway%' ORDER BY id");
  if (res.length > 0) {
    res[0].values.forEach(v => {
      const r = {};
      res[0].columns.forEach((c,i) => { r[c] = v[i]; });
      r.file_path = (r.file_path||'').replace(/\\/g,'/').replace('E:/s/wol/py/qqq-shell-v2/','');
      console.log(JSON.stringify(r));
    });
  } else { console.log('none'); }
  
  // Check all entries for index.html context (specifically looking at entries near index.html)
  console.log('\n=== index.html entries ===');
  const res2 = db.exec("SELECT id, ts, source, added_lines, deleted_lines, floor_id FROM versions WHERE file_path LIKE '%index.html' ORDER BY id");
  if (res2.length > 0) {
    res2[0].values.forEach(v => {
      const r = {};
      res2[0].columns.forEach((c,i) => { r[c] = v[i]; });
      console.log(JSON.stringify(r));
    });
  } else { console.log('none'); }

  db.close();
})();
