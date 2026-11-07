// Construit l'interface web embarquée dans l'application Android (dossier assets/www de l'APK).
// Usage : node scripts/build-android.cjs [dossier-de-sortie]
const fs = require('node:fs'), path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'android', 'app', 'src', 'main', 'assets', 'www'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'mobile', 'boot.mjs')],
  outfile: path.join(out, 'pos.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome70'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  alias: { 'node:crypto': path.join(root, 'mobile', 'shims', 'crypto.mjs') },
  // Modules réservés au bureau ou au serveur : ils ne doivent jamais entrer dans l'APK.
  external: [],
  logLevel: 'warning',
});

for (const [from, to] of [['frontend/styles.css', 'styles.css'], ['frontend/theme.css', 'theme.css'], ['mobile/android.css', 'android.css'], ['mobile/index.html', 'index.html']])
  fs.copyFileSync(path.join(root, from), path.join(out, to));

const pkg = require(path.join(root, 'package.json'));
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }));
const size = fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
console.log(`Interface Android construite : ${path.relative(root, out)} (${Math.round(size / 1024)} Ko)`);
