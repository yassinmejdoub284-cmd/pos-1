// Imprimantes Bluetooth ESC/POS : détection automatique, choix mémorisé, impression texte ou image.
import { nativeAsync, onNativeEvent } from './native.mjs';
import { parseReceipt, textCommands, needsGraphics, commands, toBase64 } from './escpos.mjs';
import { imageCommands, rasterLogo } from './raster.mjs';

const PREFS_KEY = 'pos-android-printer';
const DEFAULT_PREFS = { paper: 80, mode: 'text', lastAddress: '' };
export const BT_PREFIX = 'bt:';

export function prefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(patch) {
  const next = { ...prefs(), ...patch };
  next.paper = Number(next.paper) === 58 ? 58 : 80;
  next.mode = next.mode === 'image' ? 'image' : 'text';
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* préférences non bloquantes */ }
  return next;
}

const NAME_HINT = /print|prn|pos|xp-?|mtp|rpp|pt-?\d|inner|therm|receipt|ticket|goojprt|zjiang|zj-|hoin|sunmi|imin|bixolon|epson|star|munbyn|hprt|rongta|gprinter|peripage|cashino|netum|\b58|\b80/i;
const score = d => (d.printer ? 4 : 0) + (NAME_HINT.test(d.name || '') ? 2 : 0) + (d.connected ? 1 : 0);

export class BluetoothPrinters {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.cache = null;
    this.queue = Promise.resolve();
    this.logos = new Map();
    onNativeEvent('bluetooth', () => { this.cache = null; });
  }

  async scanBonded({ ask = false } = {}) {
    const result = await nativeAsync('btList', { ask }, 20000);
    this.cache = { at: Date.now(), ...result };
    return result;
  }

  async bonded() {
    if (this.cache && Date.now() - this.cache.at < 15000) return this.cache;
    return this.scanBonded();
  }

  // Meilleure imprimante appairée : la dernière qui a fonctionné, sinon classe « imprimante » ou nom connu,
  // sinon l'unique appareil appairé.
  best(devices) {
    const last = prefs().lastAddress;
    const lastDevice = devices.find(d => d.address === last);
    if (lastDevice) return lastDevice;
    const ranked = [...devices].sort((a, b) => score(b) - score(a));
    if (ranked[0] && score(ranked[0]) >= 2) return ranked[0];
    return devices.length === 1 ? devices[0] : null;
  }

  // Liste au format attendu par l'écran Paramètres (name = identifiant enregistré).
  async list() {
    let info;
    try { info = await this.scanBonded({ ask: true }); } catch { return []; }
    const auto = this.best(info.devices || []);
    return (info.devices || []).sort((a, b) => score(b) - score(a)).map(d => ({
      name: BT_PREFIX + d.address,
      displayName: `${d.name || 'Appareil Bluetooth'} · ${d.address.slice(-5)}${d.printer || NAME_HINT.test(d.name || '') ? ' 🖨' : ''}${auto?.address === d.address ? ' (auto)' : ''}`,
      isDefault: auto?.address === d.address,
    }));
  }

  // Recherche + appairage automatique d'une imprimante non encore appairée.
  async discover() {
    const found = await nativeAsync('btDiscover', { seconds: 10 }, 45000);
    return (found.devices || []).filter(d => d.printer || NAME_HINT.test(d.name || '')).sort((a, b) => score(b) - score(a));
  }

  async pair(address) { this.cache = null; return nativeAsync('btPair', { address }, 70000); }

  async resolve(deviceName) {
    if (deviceName && deviceName.startsWith(BT_PREFIX)) return deviceName.slice(BT_PREFIX.length);
    const info = await this.bonded();
    if (!info.enabled) throw new Error('Bluetooth désactivé : activez-le pour imprimer.');
    const device = this.best(info.devices || []);
    if (!device) throw new Error('Aucune imprimante Bluetooth trouvée. Appairez-la puis touchez « Détecter l’imprimante » dans Paramètres.');
    return device.address;
  }

  async logo(src, paper) {
    const key = paper + ':' + src;
    if (!this.logos.has(key)) { this.logos.clear(); this.logos.set(key, await rasterLogo(src, paper)); }
    return this.logos.get(key);
  }

  async render(html) {
    const { paper, mode } = prefs();
    const blocks = parseReceipt(html);
    if (mode === 'image' || needsGraphics(blocks)) {
      const bytes = await imageCommands(blocks, { paper });
      if (bytes) return bytes;
    }
    const images = new Map();
    for (const b of blocks) if (b.type === 'image' && b.src) { const img = await this.logo(b.src, paper); if (img) images.set(b.src, img); }
    return textCommands(blocks, { paper, images });
  }

  async send(address, bytes) {
    await nativeAsync('btPrint', { address, data: toBase64(bytes) }, 90000);
    if (prefs().lastAddress !== address) savePrefs({ lastAddress: address });
  }

  // Interface utilisée par PrintQueue (même signature que la version Windows).
  printHtml(html, deviceName, copies = 1) {
    const job = this.queue.then(async () => {
      const address = await this.resolve(deviceName);
      const bytes = await this.render(html);
      const print = this.getSettings().print;
      const parts = [];
      for (let i = 0; i < Math.max(1, copies); i++) parts.push(bytes);
      if (print.drawerEnabled) {
        try {
          const drawer = await this.resolve(print.drawerPrinter || print.clientPrinter || deviceName);
          if (drawer === address) parts.push(commands.drawer(print.drawerPin));
        } catch { /* Le ticket passe avant le tiroir. */ }
      }
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      await this.send(address, all);
      return { ok: true };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async kickDrawer() {
    const print = this.getSettings().print;
    const address = await this.resolve(print.drawerPrinter || print.clientPrinter);
    await this.send(address, commands.drawer(print.drawerPin));
    return { ok: true };
  }

  async testPage(companyName) {
    const { paper, mode } = prefs();
    const html = `<body><h1>${companyName.replace(/[<&>]/g, '')}</h1><h2>TEST IMPRIMANTE</h2><p class="center">Papier ${paper} mm · mode ${mode === 'image' ? 'image' : 'texte'}</p><div class="rule"></div><div class="row"><span>Café crème × 2</span><span>5.000 DT</span></div><div class="row option"><span>↳ Supplément</span><span>0.500 DT</span></div><div class="rule"></div><div class="row bold large"><span>TOTAL</span><span>5.500 DT</span></div><footer class="small">Éàçù — l’impression fonctionne.</footer></body>`;
    return this.printHtml(html, this.getSettings().print.clientPrinter, 1);
  }
}
