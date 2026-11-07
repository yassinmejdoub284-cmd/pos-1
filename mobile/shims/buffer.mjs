// Buffer minimal pour exécuter le moteur de caisse dans la WebView Android.
// Couvre uniquement les usages du dépôt : hex, utf8, ascii/latin1, base64, byteLength, concat.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export class PosBuffer extends Uint8Array {
  static from(value, encoding = 'utf8') {
    if (typeof value === 'string') {
      if (encoding === 'hex') {
        const clean = value.length % 2 ? value.slice(0, -1) : value;
        const out = new PosBuffer(clean.length / 2);
        for (let i = 0; i < out.length; i++) {
          const byte = parseInt(clean.substr(i * 2, 2), 16);
          if (Number.isNaN(byte)) return out.subarray(0, i);
          out[i] = byte;
        }
        return out;
      }
      if (encoding === 'base64') {
        const raw = atob(value);
        const out = new PosBuffer(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
      }
      if (encoding === 'ascii' || encoding === 'latin1' || encoding === 'binary') {
        const out = new PosBuffer(value.length);
        for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & (encoding === 'ascii' ? 0x7f : 0xff);
        return out;
      }
      const bytes = encoder.encode(value);
      const out = new PosBuffer(bytes.length);
      out.set(bytes);
      return out;
    }
    if (value instanceof ArrayBuffer) return new PosBuffer(value);
    const out = new PosBuffer(value.length);
    out.set(value);
    return out;
  }
  static alloc(size, fill = 0) { const out = new PosBuffer(size); if (fill) out.fill(fill); return out; }
  static isBuffer(value) { return value instanceof PosBuffer; }
  static byteLength(value, encoding = 'utf8') {
    if (typeof value !== 'string') return value.byteLength;
    if (encoding === 'hex') return value.length >>> 1;
    if (encoding === 'ascii' || encoding === 'latin1') return value.length;
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) { const n = value.charCodeAt(i + 1); if (n >= 0xdc00 && n <= 0xdfff) { bytes += 4; i++; } else bytes += 3; }
      else bytes += 3;
    }
    return bytes;
  }
  static concat(list) {
    const size = list.reduce((n, b) => n + b.length, 0);
    const out = new PosBuffer(size);
    let offset = 0;
    for (const b of list) { out.set(b, offset); offset += b.length; }
    return out;
  }
  toString(encoding = 'utf8') {
    if (encoding === 'hex') { let s = ''; for (let i = 0; i < this.length; i++) s += HEX[this[i]]; return s; }
    if (encoding === 'base64') { let s = ''; for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000)); return btoa(s); }
    if (encoding === 'ascii' || encoding === 'latin1' || encoding === 'binary') { let s = ''; for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]); return s; }
    return decoder.decode(this);
  }
  equals(other) { if (other.length !== this.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false; return true; }
}
