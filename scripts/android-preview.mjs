// Aperçu de la version Android dans un navigateur, avec un pont natif simulé
// (SQLite de Node, imprimante Bluetooth factice). Usage : node scripts/android-preview.mjs
// Les tickets « imprimés » sont enregistrés dans data/android-prints/*.bin (ESC/POS brut).
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const www = resolve(root, 'data', 'android-preview-www');
const port = Number(process.env.POS_ANDROID_PREVIEW_PORT || 4179);
execFileSync(process.execPath, [resolve(root, 'scripts', 'build-android.cjs'), www], { stdio: 'inherit' });
const dataDir = resolve(root, 'data');
mkdirSync(resolve(dataDir, 'android-prints'), { recursive: true });
const dbPath = process.env.POS_ANDROID_PREVIEW_DB || resolve(dataDir, 'android-preview.sqlite');
let db = null;
if (process.env.POS_ANDROID_PREVIEW_SEED) {
  const { openDatabase } = await import('../backend/database.mjs');
  const { PosService } = await import('../backend/service.mjs');
  const { seedDemo } = await import('../backend/demo.mjs');
  const store = openDatabase(dbPath);
  await seedDemo(new PosService(store, {}));
  store.db.close();
}
const secrets = new Map();
const devices = [
  { name: 'XP-P323B', address: '66:22:B0:11:22:33', printer: true, connected: false },
  { name: 'JBL Flip 5', address: 'F8:DF:15:AA:BB:CC', printer: false, connected: false },
];

const wrap = fn => { try { return { v: fn() }; } catch (error) { return { e: error.message }; } };
const sync = {
  dbOpen: () => wrap(() => { if (!db) db = new DatabaseSync(dbPath); return { path: dbPath }; }),
  dbQuery: (sql, params, limit) => wrap(() => { const st = db.prepare(sql); const p = JSON.parse(params); return limit === 1 ? [st.get(...p)].filter(Boolean) : st.all(...p); }),
  dbRun: (sql, params) => wrap(() => { const r = db.prepare(sql).run(...JSON.parse(params)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }),
  dbExec: sql => wrap(() => { db.exec(sql); return null; }),
  dbClose: () => wrap(() => { db?.close(); db = null; return null; }),
  pbkdf2: (pin, salt, iterations, length) => pbkdf2Sync(pin, salt, iterations, length, 'sha256').toString('hex'),
  sha256: text => createHash('sha256').update(text).digest('hex'),
  secretGet: key => secrets.get(key) || '',
  secretPut: (key, value) => { secrets.set(key, value); return ''; },
  ready: () => '',
};
let printCount = readdirSync(resolve(dataDir, 'android-prints')).length;
const asyncCalls = {
  btList: () => ({ enabled: true, permission: true, devices }),
  btWarmup: () => ({ ok: true }),
  btDiscover: () => ({ devices: [] }),
  btPair: () => ({ bonded: true }),
  btPrint: ({ address, data }) => { const file = resolve(dataDir, 'android-prints', `${String(++printCount).padStart(4, '0')}-${address.replace(/:/g, '')}.bin`); writeFileSync(file, Buffer.from(data, 'base64')); return { ok: true, bytes: Buffer.from(data, 'base64').length }; },
  openBluetoothSettings: () => ({ ok: true }),
  backupDb: () => ({ cancelled: true }),
  restoreDb: () => ({ cancelled: true }),
  http: async ({ url, method, headers, body }) => { const r = await fetch(url, { method, headers, body }); return { status: r.status, body: await r.text() }; },
};

const mock = `(()=>{const call=(m,a)=>{const x=new XMLHttpRequest();x.open('POST','/native/'+m,false);x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify(a));return x.responseText;};
const p=new Proxy({},{get:(_,m)=>{if(${JSON.stringify(Object.keys(sync))}.includes(m))return (...a)=>call(m,a);return (id,json)=>{fetch('/native-async/'+m,{method:'POST',headers:{'Content-Type':'application/json'},body:json}).then(r=>r.text()).then(t=>setTimeout(()=>window.__nativeReply(id,t),${Number(process.env.POS_ANDROID_PREVIEW_DELAY || 120)}));};}});
window.SamuraiNative=p;})();`;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (url.pathname.startsWith('/native/')) {
        const fn = sync[url.pathname.slice(8)];
        const out = fn(...JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(typeof out === 'string' ? out : JSON.stringify(out));
      }
      if (url.pathname.startsWith('/native-async/')) {
        const fn = asyncCalls[url.pathname.slice(14)];
        let out;
        try { out = fn ? { value: await fn(JSON.parse(raw || '{}')) } : { error: 'Inconnu' }; } catch (error) { out = { error: error.message }; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
    }
    if (url.pathname === '/mock-native.js') { res.writeHead(200, { 'Content-Type': types['.js'] }); return res.end(mock); }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = resolve(www, name);
    if (!file.startsWith(www) || !existsSync(file)) { res.writeHead(404); return res.end('Introuvable'); }
    let body = readFileSync(file);
    if (name === 'index.html') body = body.toString().replace('<script src="./pos.js"', '<script src="./mock-native.js"></script><script src="./pos.js"');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (error) { res.writeHead(500); res.end(error.message); }
}).listen(port, '127.0.0.1', () => console.log(`Aperçu Android : http://127.0.0.1:${port} (base ${dbPath})`));
