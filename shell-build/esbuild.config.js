// ============================================================================
// esbuild.config.js - bundle shell/*.ts -> shell-out/*.js for electron main.
// CommonJS output, target node16 (electron 22 ships node 16.17).
// ============================================================================

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shell');
const OUT = path.join(ROOT, 'shell-out');

const isWatch = process.argv.includes('--watch');

const entries = [
  path.join(SRC, 'main.ts'),
  path.join(SRC, 'preload.ts'),
];

const baseOpts = {
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  outdir: OUT,
  outExtension: { '.js': '.js' },
  sourcemap: true,
  external: ['electron', 'sql.js'],
  logLevel: 'info',
};

async function build() {
  fs.mkdirSync(OUT, { recursive: true });

  // Copy bootstrap.js (plain JS, not bundled — needs independent require('./main.js'))
  var bootstrapSrc = path.join(SRC, 'bootstrap.js');
  var bootstrapDst = path.join(OUT, 'bootstrap.js');
  if (fs.existsSync(bootstrapSrc)) {
    fs.copyFileSync(bootstrapSrc, bootstrapDst);
    console.log('[esbuild] copied bootstrap.js ->', OUT);
  }

  // Copy py-broker.py (Python broker, not bundled)
  var brokerSrc = path.join(SRC, 'py-broker.py');
  var brokerDst = path.join(OUT, 'py-broker.py');
  if (fs.existsSync(brokerSrc)) {
    fs.copyFileSync(brokerSrc, brokerDst);
    console.log('[esbuild] copied py-broker.py ->', OUT);
  }

  if (isWatch) {
    const ctx = await esbuild.context({ ...baseOpts, entryPoints: entries });
    await ctx.watch();
    console.log('[esbuild] watching shell/...');
  } else {
    await esbuild.build({ ...baseOpts, entryPoints: entries });
    console.log('[esbuild] built ->', OUT);
  }
}

build().catch(e => { console.error(e); process.exit(1); });
