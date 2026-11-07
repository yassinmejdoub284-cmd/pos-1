// Démarrage de la caisse Android hors ligne : le moteur de caisse (backend/) tourne dans la WebView
// avec la base SQLite native de la tablette, puis l'interface habituelle (frontend/app.mjs) est chargée.
import './polyfills.mjs';
import { native, nativeAsync, nativeFetch, onNativeEvent } from './native.mjs';
import { nativeDatabase } from './native-db.mjs';
import { initDatabase } from '../backend/schema.mjs';
import { PosService } from '../backend/service.mjs';
import { SyncEngine } from '../backend/sync.mjs';
import { PrintQueue } from '../backend/print-queue.mjs';
import { receiptHtml, reportHtml, closureHtml } from '../backend/receipts.mjs';
import { VfdDisplay } from '../backend/vfd.mjs';
import { BluetoothPrinters, prefs, savePrefs } from './printer.mjs';
import { installKeypad } from './keypad.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(message, error = false) {
  const root = document.querySelector('#toast');
  if (!root) return;
  root.textContent = message; root.className = error ? 'error' : ''; root.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { root.style.display = 'none'; }, 5000);
}
function fatal(message) {
  document.querySelector('#app').innerHTML = `<div class="android-fatal"><h1>Samurai POS</h1><p>${esc(message)}</p><button type="button" class="btn primary">Réessayer</button></div>`;
  document.querySelector('.android-fatal button').addEventListener('click', () => location.reload());
  try { native?.ready(); } catch { /* rien */ }
}

function chromeVersion() { const m = /Chrome\/(\d+)/.exec(navigator.userAgent); return m ? Number(m[1]) : 0; }

async function start() {
  if (!native) return fatal('Cette page doit être ouverte depuis l’application Android Samurai POS.');
  if (chromeVersion() && chromeVersion() < 70) return fatal('Mettez à jour « Android System WebView » (ou Chrome) depuis le Play Store, puis relancez la caisse.');

  const store = initDatabase(nativeDatabase(native), 'android');
  let service;
  const printer = new BluetoothPrinters(() => service.settings());
  const noVfd = new VfdDisplay({ ports: async () => [], write: async () => { throw new Error('Afficheur VFD non disponible sur Android.'); }, close: async () => {} });
  let printQueue;
  service = new PosService(store, {
    vfd: noVfd,
    printers: () => printer.list(),
    saveSyncToken: token => { native.secretPut('syncToken', token); },
    receipt: receiptHtml,
    closureReceipt: closureHtml,
    printSale: (sale, kind) => printQueue.printSale(sale, kind),
    printClosure: session => printQueue.printClosure(session),
    printReport: (report, settings) => printer.printHtml(reportHtml(report, settings), settings.print.clientPrinter),
    testDrawer: async () => { try { const r = await printer.kickDrawer(); service.put('drawerLastError', ''); return r; } catch (error) { service.put('drawerLastError', error.message); throw error; } },
    backup: () => nativeAsync('backupDb', { name: `Samurai-POS-${new Date().toISOString().slice(0, 10)}.sqlite` }, 15 * 60000),
  });
  const engine = new SyncEngine(service, () => native.secretGet('syncToken') || '', nativeFetch);
  service.options.sync = engine;
  printQueue = new PrintQueue(service, { receiptHtml, closureHtml, printHtml: (html, device, copies) => printer.printHtml(html, device, copies) });
  printQueue.recover();
  const drain = () => { void printQueue.drain(); };

  window.pos = {
    call: async (action, args = {}, token) => {
      try {
        if (JSON.stringify(args).length > 2_000_000) throw new Error('Requête trop volumineuse.');
        const result = await service.call(action, args, token);
        if (action === 'sale' || action === 'closeSession') drain();
        return result;
      } catch (error) { return { error: error.message, status: error.status || 400 }; }
    },
  };

  // Détection automatique : la meilleure imprimante appairée est retenue et sa connexion préparée,
  // pour que le premier ticket sorte sans attente.
  let printerStatus = '';
  async function autoDetect({ ask = false, quiet = true } = {}) {
    try {
      const info = await printer.scanBonded({ ask });
      if (!info.permission) { printerStatus = 'Autorisez l’accès Bluetooth pour imprimer.'; return null; }
      if (!info.enabled) { printerStatus = 'Bluetooth désactivé.'; return null; }
      const best = printer.best(info.devices || []);
      if (!best) { printerStatus = 'Aucune imprimante appairée.'; return null; }
      savePrefs({ lastAddress: best.address });
      printerStatus = `Imprimante détectée : ${best.name || best.address}`;
      nativeAsync('btWarmup', { address: best.address }, 30000).catch(() => {});
      return best;
    } catch (error) { printerStatus = error.message; if (!quiet) throw error; return null; }
  }
  onNativeEvent('bluetooth', () => { void autoDetect(); });
  onNativeEvent('resume', () => { drain(); void autoDetect(); });

  // Panneau propre à Android dans Paramètres → Imprimantes & tickets.
  globalThis.posAndroidPrinterPanel = () => {
    const p = prefs();
    const opt = (v, label, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    return `<div class="android-printer"><div class="android-printer-status"><span class="dot"></span>${esc(printerStatus || 'Bluetooth : détection automatique au démarrage.')}</div>
      <div class="form-grid"><div class="field"><label for="android-paper">Largeur du papier</label><select id="android-paper" data-android-pref="paper">${opt(80, '80 mm (48 caractères)', p.paper)}${opt(58, '58 mm (32 caractères)', p.paper)}</select></div>
      <div class="field"><label for="android-mode">Mode d’impression</label><select id="android-mode" data-android-pref="mode">${opt('text', 'Texte rapide (recommandé)', p.mode)}${opt('image', 'Graphique : accents, arabe, logo', p.mode)}</select></div></div>
      <div class="android-actions"><button type="button" class="btn primary" data-android-action="detect">Détecter l’imprimante</button><button type="button" class="btn" data-android-action="test-print">Ticket de test</button><button type="button" class="btn" data-android-action="bt-settings">Réglages Bluetooth</button><button type="button" class="btn subtle" data-android-action="restore">Restaurer une sauvegarde</button></div>
      <p class="android-help">Laissez « Détection automatique » : la caisse choisit l’imprimante Bluetooth appairée. Si elle n’est pas encore appairée, « Détecter l’imprimante » la recherche et l’appaire (code habituel : 0000 ou 1234).</p></div>`;
  };
  const reopenSettings = () => document.querySelector('[data-action="nav"][data-id="parametres"]')?.click();

  document.addEventListener('change', event => {
    const el = event.target.closest?.('[data-android-pref]');
    if (!el) return;
    savePrefs({ [el.dataset.androidPref]: el.value });
    toast('Réglage d’impression enregistré sur cette tablette.');
  });
  let androidBusy = false;
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-android-action]');
    if (!button || androidBusy) return;
    event.preventDefault(); event.stopPropagation();
    androidBusy = true; button.disabled = true;
    const action = button.dataset.androidAction;
    try {
      if (action === 'detect') {
        toast('Recherche de l’imprimante…');
        let best = await autoDetect({ ask: true, quiet: false });
        if (!best) {
          const info = printer.cache || {};
          if (!info.permission || !info.enabled) throw new Error(printerStatus);
          toast('Recherche des imprimantes Bluetooth à proximité (10 s)…');
          const found = await printer.discover();
          if (!found.length) throw new Error('Aucune imprimante trouvée. Allumez-la, rapprochez-la de la tablette puis réessayez.');
          toast(`Appairage de ${found[0].name || found[0].address}…`);
          await printer.pair(found[0].address);
          best = await autoDetect({ ask: false, quiet: false });
          if (!best) throw new Error('Appairage refusé. Essayez le code 0000 ou 1234 dans les réglages Bluetooth.');
        }
        toast(`Imprimante prête : ${best.name || best.address}`);
        reopenSettings();
      } else if (action === 'test-print') {
        await printer.testPage(service.settings().company.name);
        toast('Ticket de test envoyé.');
      } else if (action === 'bt-settings') {
        await nativeAsync('openBluetoothSettings', {});
      } else if (action === 'restore') {
        if (!confirm('Remplacer toutes les données de cette tablette par une sauvegarde (.sqlite) ? Une copie de sécurité de la base actuelle est conservée.')) return;
        const result = await nativeAsync('restoreDb', {}, 15 * 60000);
        if (result?.cancelled) return toast('Restauration annulée.');
        toast('Sauvegarde restaurée. Redémarrage de la caisse…');
        setTimeout(() => location.reload(), 800);
      }
    } catch (error) { toast(error.message, true); }
    finally { androidBusy = false; button.disabled = false; }
  }, true);

  // Bouton retour Android : ferme d'abord la fenêtre ouverte.
  globalThis.__androidBack = () => {
    const keypad = document.querySelector('.touch-keypad:not([hidden])');
    if (keypad) { keypad.hidden = true; document.activeElement?.blur?.(); return true; }
    const close = document.querySelector('#modal [data-action="close-modal"]');
    if (close) { close.click(); return true; }
    return false;
  };

  installKeypad();
  await import('../frontend/app.mjs');
  engine.start();
  drain();
  setTimeout(() => { void autoDetect(); }, 1500);
  try { native.ready(); } catch { /* écran de démarrage déjà masqué */ }
}

start().catch(error => { console.error(error); fatal('Impossible d’ouvrir la caisse : ' + error.message); });
