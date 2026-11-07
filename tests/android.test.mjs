import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, createHash } from 'node:crypto';
import { nativeDatabase } from '../mobile/native-db.mjs';
import { initDatabase } from '../backend/schema.mjs';
import { openDatabase } from '../backend/database.mjs';
import { PosService, DEFAULT_SETTINGS } from '../backend/service.mjs';
import { receiptHtml, closureHtml, reportHtml } from '../backend/receipts.mjs';
import { parseReceipt, textCommands, toAscii, wrap, needsGraphics, commands } from '../mobile/escpos.mjs';
import { PosBuffer } from '../mobile/shims/buffer.mjs';
import * as shim from '../mobile/shims/crypto.mjs';

// Pont natif simulé avec la même interface JSON que NativeBridge.java.
function fakeBridge(path = ':memory:') {
  let db;
  const wrapCall = fn => { try { return JSON.stringify({ v: fn() }); } catch (e) { return JSON.stringify({ e: e.message }); } };
  return {
    dbOpen: () => wrapCall(() => { db ||= new DatabaseSync(path); return { path }; }),
    dbQuery: (sql, params, limit) => wrapCall(() => { const st = db.prepare(sql); const p = JSON.parse(params); return limit === 1 ? [st.get(...p)].filter(Boolean) : st.all(...p); }),
    dbRun: (sql, params) => wrapCall(() => { const r = db.prepare(sql).run(...JSON.parse(params)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }),
    dbExec: sql => wrapCall(() => { db.exec(sql); return null; }),
    dbClose: () => wrapCall(() => { db.close(); return null; }),
    pbkdf2: (pin, salt, iterations, length) => pbkdf2Sync(pin, salt, iterations, length, 'sha256').toString('hex'),
    sha256: text => createHash('sha256').update(text).digest('hex'),
  };
}

const settings = { ...DEFAULT_SETTINGS, company: { ...DEFAULT_SETTINGS.company, name: 'Samurai Food', address: 'Sfax' } };
const sale = {
  id: 's1', ticket: 7, displayTicket: 7, mode: 'emporter', createdAt: '2026-11-08T10:00:00.000Z', userName: 'Amine', deviceId: 'abcdef123456', client: null,
  items: [
    { quantity: 2, name: 'Chapati chawarma très très garni avec double fromage', kitchenName: 'Chapati', price: 7000, supplements: [{ name: 'Fromage', price: 1000 }], comments: [{ name: 'Sans harissa', kitchen: true, client: false }], kitchenNote: 'Bien cuit' },
    { quantity: 1, name: 'Eau minérale', kitchenName: 'Eau', price: 1500, supplements: [], comments: [] },
  ],
  note: '', subtotal: 17500, discount: 0, total: 17500, payment: 'cash', received: 20000, change: 2500,
};

test('Android : ticket client 80 mm en ESC/POS texte, aligné sur 48 colonnes', () => {
  const blocks = parseReceipt(receiptHtml(sale, 'client', settings));
  assert.equal(blocks[0].text, 'Samurai Food');
  assert.equal(blocks[0].size, 2);
  const total = blocks.find(b => b.type === 'row' && b.left === 'TOTAL');
  assert.equal(total.right, '17.500 DT');
  assert.equal(total.bold, true);
  const option = blocks.find(b => b.type === 'row' && b.left.startsWith('↳ Fromage'));
  assert.equal(option.indent, 2);
  const bytes = textCommands(blocks, { paper: 80 });
  const text = new TextDecoder().decode(bytes);
  for (const line of text.split('\n')) assert.ok(line.replace(/\x1b[aE!d@].?|\x1d[!V]B?.?/g, '').replace(/[\x00-\x1f]/g, '').length <= 48 + 3, line);
  assert.match(text, /Especes {2,}20\.000 DT/);
  assert.match(text, /Chapati chawarma tres tres garni/);
  assert.ok(text.includes('-'.repeat(48)));
  assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 0x42, 0x00]);
});

test('Android : bon cuisine sans prix, avec commentaires et note ; 58 mm sur 32 colonnes', () => {
  const blocks = parseReceipt(receiptHtml(sale, 'kitchen', settings));
  assert.ok(blocks.every(b => b.type !== 'row' || b.right === ''));
  assert.ok(blocks.some(b => b.type === 'text' && b.text === 'Note cuisine : Bien cuit'));
  assert.ok(blocks.some(b => b.type === 'text' && b.text === '→ Sans harissa'));
  const text = new TextDecoder().decode(textCommands(blocks, { paper: 58 }));
  assert.ok(text.includes('-'.repeat(32)) && !text.includes('-'.repeat(33)));
});

test('Android : clôture et rapport convertis, translittération et retour à la ligne', () => {
  const closure = parseReceipt(closureHtml({ userName: 'Amine', openedAt: sale.createdAt, closedAt: sale.createdAt, id: 'sess', opening: 50000, expected: 67500, closing: 67500, variance: 0, summary: { cashSales: 17500, clientPayments: 0, refunds: 0, expenses: 0, card: 0, credit: 0 } }, settings));
  assert.ok(closure.some(b => b.type === 'row' && b.left === 'Espèces attendues' && b.right === '67.500 DT'));
  assert.equal(toAscii('Clôture «Espèces» × 2 − 1 €'), 'Cloture "Especes" x 2 - 1 EUR');
  assert.deepEqual(wrap('un deux trois quatre', 9), ['un deux', 'trois', 'quatre']);
  assert.deepEqual(wrap('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  assert.equal(needsGraphics(parseReceipt('<body><p>Merci</p></body>')), false);
  assert.equal(needsGraphics(parseReceipt('<body><p>شكرا</p></body>')), true);
  assert.deepEqual([...commands.drawer(5)], [0x1b, 0x70, 1, 25, 250]);
  const report = parseReceipt(reportHtml({ day: '2026-11-08', grossTotal: 1, refundsTotal: 0, total: 1, count: 1, voided: 0, cash: 1, card: 0, credit: 0, discount: 0, expensesTotal: 0, products: [{ quantity: 1, name: 'A&B <x>', total: 1 }], expenses: [], sessions: [] }, settings));
  assert.ok(report.some(b => b.type === 'row' && b.left === '1 × A&B <x>'));
});

test('Android : Buffer et node:crypto de remplacement identiques à Node', () => {
  globalThis.SamuraiNative = fakeBridge();
  try {
    assert.equal(PosBuffer.from('c3a9', 'hex').toString(), 'é');
    assert.equal(PosBuffer.byteLength('é€😀', 'utf8'), Buffer.byteLength('é€😀', 'utf8'));
    assert.equal(PosBuffer.from('Samurai').toString('base64'), Buffer.from('Samurai').toString('base64'));
    assert.equal(shim.randomBytes(24).toString('hex').length, 48);
    assert.equal(shim.pbkdf2Sync('246810', 'sel', 1000, 32, 'sha256').toString('hex'), pbkdf2Sync('246810', 'sel', 1000, 32, 'sha256').toString('hex'));
    assert.equal(shim.createHash('sha256').update('{"a":1}').digest('hex'), createHash('sha256').update('{"a":1}').digest('hex'));
    assert.equal(shim.timingSafeEqual(PosBuffer.from('ab', 'hex'), PosBuffer.from('ab', 'hex')), true);
    assert.throws(() => shim.timingSafeEqual(PosBuffer.from('ab', 'hex'), PosBuffer.from('abcd', 'hex')));
  } finally { delete globalThis.SamuraiNative; }
});

test('Android : moteur de caisse complet sur le pont SQLite natif (vente, clôture, base reprise du bureau)', async () => {
  const dir = await import('node:fs').then(fs => fs.mkdtempSync(new URL('../', import.meta.url).pathname + 'test-results-android-'));
  const path = dir + '/caisse.sqlite';
  // Base créée par la version Windows…
  const desktop = openDatabase(path);
  const pc = new PosService(desktop, {});
  await pc.call('setup', { company: 'Samurai Food', name: 'admin', pin: '246810' });
  desktop.db.close();
  // …puis ouverte par la version Android (restauration d'une sauvegarde).
  globalThis.SamuraiNative = fakeBridge(path);
  try {
    const db = nativeDatabase(globalThis.SamuraiNative);
    assert.throws(() => db.prepare('SELECT ?').get(true), /cannot be bound/);
    const store = initDatabase(db, 'android');
    const service = new PosService(store, {});
    const { token } = await service.call('login', { name: 'admin', pin: '246810' });
    await assert.rejects(service.call('login', { name: 'admin', pin: '000000' }));
    const family = await service.call('saveEntity', { kind: 'family', data: { name: 'Boissons', color: '#68a494' } }, token);
    const product = await service.call('saveEntity', { kind: 'product', data: { name: 'Café', price: 2500, familyId: family.id, emoji: '☕' } }, token);
    await service.call('openSession', { opening: 50000 }, token);
    const created = await service.call('sale', { requestId: 'r-1', items: [{ productId: product.id, quantity: 2, supplements: [], comments: [] }], payment: 'cash', received: 5000, print: false }, token);
    assert.equal(created.total, 5000);
    const again = await service.call('sale', { requestId: 'r-1', items: [{ productId: product.id, quantity: 2, supplements: [], comments: [] }], payment: 'cash', received: 5000, print: false }, token);
    assert.equal(again.id, created.id, 'vente idempotente');
    const boot = await service.call('bootstrap', {}, token);
    assert.equal(boot.catalog.product.length, 1);
    assert.equal(boot.session.opening, 50000);
    assert.equal((await service.call('sessionSummary', {}, token)).expected, 55000);
    const closure = await service.call('closeSession', { closing: 55000, reason: '' }, token);
    assert.equal(closure.variance, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM sales').get().n, 1);
    assert.ok(store.db.prepare('SELECT count(*) n FROM outbox').get().n >= 3);
  } finally {
    delete globalThis.SamuraiNative;
    (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
  }
});
