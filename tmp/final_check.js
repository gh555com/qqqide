const initSqlJs = require('sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync('E:/s/wol/py/qqq-shell-v2/qqq/timeline/timeline.db');
  const db = new SQL.Database(buf);
  
  const cols = ['id','ts','source','added_lines','deleted_lines','floor_id','file_path','blob_hash'];
  
  // Query entries 1-30 to see what's there
  console.log('=== Entries 1-30 ===');
  const res = db.exec('SELECT ' + cols.join(',') + ' FROM versions WHERE id BETWEEN 1 AND 30 ORDER BY id');
  if (res.length > 0) {
    res[0].values.forEach(v => {
      const r = {};
      res[0].columns.forEach((c,i) => { r[c] = v[i]; });
      r.file_path = (r.file_path||'').replace(/\\/g,'/').replace('E:/s/wol/py/qqq-shell-v2/','');
      console.log(JSON.stringify(r));
    });
  }
  
  // Query entries for agent-gateway.js specifically
  console.log('\n=== agent-gateway.js (exact) ===');
  const res2 = db.exec("SELECT " + cols.join(',') + " FROM versions WHERE file_path LIKE '%agent-gateway.js' ORDER BY id");
  if (res2.length > 0) {
    res2[0].values.forEach(v => {
      const r = {};
      res2[0].columns.forEach((c,i) => { r[c] = v[i]; });
      r.file_path = (r.file_path||'').replace(/\\/g,'/').replace('E:/s/wol/py/qqq-shell-v2/','');
      console.log(JSON.stringify(r));
    });
  } else { console.log('none'); }
  
  // Query all entries with floor_id containing q34
  console.log('\n=== floor_id LIKE q34% ===');
  const res3 = db.exec("SELECT " + cols.join(',') + " FROM versions WHERE floor_id LIKE 'q34%' ORDER BY id");
  if (res3.length > 0) {
    res3[0].values.forEach(v => {
      const r = {};
      res3[0].columns.forEach((c,i) => { r[c] = v[i]; });
      r.file_path = (r.file_path||'').replace(/\\/g,'/').replace('E:/s/wol/py/qqq-shell-v2/','');
      console.log(JSON.stringify(r));
    });
  } else { console.log('none'); }
  
  // Query entries with floor_id containing q40
  console.log('\n=== floor_id LIKE q40% ===');
  const res4 = db.exec("SELECT " + cols.join(',') + " FROM versions WHERE floor_id LIKE 'q40%' ORDER BY id");
  if (res4.length > 0) {
    res4[0].values.forEach(v => {
      const r = {};
      res4[0].columns.forEach((c,i) => { r[c] = v[i]; });
      r.file_path = (r.file_path||'').replace(/\\/g,'/').replace('E:/s/wol/py/qqq-shell-v2/','');
      console.log(JSON.stringify(r));
    });
  } else { console.log('none'); }
  
  db.close();
})();
