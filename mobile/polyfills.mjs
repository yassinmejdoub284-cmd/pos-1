// Compléments pour les WebView Android anciennes (tablettes non mises à jour).
import { PosBuffer } from './shims/buffer.mjs';

globalThis.Buffer = globalThis.Buffer || PosBuffer;
globalThis.posPlatform = 'android';

if (!Object.hasOwn) Object.hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
for (const proto of [Array.prototype, String.prototype]) {
  if (!proto.at) Object.defineProperty(proto, 'at', { configurable: true, writable: true, value(index) { const n = Math.trunc(index) || 0; const i = n < 0 ? this.length + n : n; return i < 0 || i >= this.length ? undefined : this[i]; } });
}
if (!Array.prototype.findLast) Object.defineProperty(Array.prototype, 'findLast', { configurable: true, writable: true, value(fn, self) { for (let i = this.length - 1; i >= 0; i--) if (fn.call(self, this[i], i, this)) return this[i]; return undefined; } });
if (!String.prototype.replaceAll) Object.defineProperty(String.prototype, 'replaceAll', { configurable: true, writable: true, value(search, replacement) { return search instanceof RegExp ? this.replace(search, replacement) : this.split(search).join(replacement); } });
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) AbortSignal.timeout = ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
if (globalThis.crypto && !globalThis.crypto.randomUUID) {
  globalThis.crypto.randomUUID = () => {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}
