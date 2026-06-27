const fs = require('fs');
const dirs = ['E:/s/wol/py/gaea/qqq1/timeline', 'E:/s/wol/py/gaea/qqq2/timeline', 'E:/s/wol/py/gaea/qqq3/timeline'];

for (const dir of dirs) {
  console.log(`\n=== ${dir} ===`);
  if (!fs.existsSync(dir)) { console.log('  NOT EXIST'); continue; }
  
  const files = fs.readdirSync(dir);
  console.log('  Files:', files.join(', '));
  
  // Check WAL
  const wal = dir + '/timeline.wal';
  if (fs.existsSync(wal)) {
    const txt = fs.readFileSync(wal, 'utf8');
    const hits = txt.split('\n').filter(l => l.includes('handlers_ai_chat.go'));
    console.log(`  WAL matches: ${hits.length}`);
    hits.slice(0,3).forEach(h => console.log('   ', h.substring(0,200)));
  }
  
  // Grep DB
  const db = dir + '/timeline.db';
  if (fs.existsSync(db)) {
    const buf = fs.readFileSync(db);
    const str = buf.toString('utf8');
    const idx = str.indexOf('handlers_ai_chat.go');
    console.log(`  DB match: ${idx >= 0 ? 'FOUND at byte '+idx : 'NONE'}`);
  }
  
  // Check file-index.json
  const fidx = dir + '/file-index.json';
  if (fs.existsSync(fidx)) {
    const data = JSON.parse(fs.readFileSync(fidx, 'utf8'));
    const hits = data.filter(e => e.includes && e.includes('handlers_ai_chat.go'));
    console.log(`  file-index matches: ${hits.length}`);
    hits.forEach(h => console.log('   ', h));
  }
}
