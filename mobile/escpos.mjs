// Conversion des tickets HTML 80 mm (backend/receipts.mjs) en commandes ESC/POS.
// Module pur (sans DOM) : utilisé dans la WebView Android et testé sous Node.
const ESC = 0x1b, GS = 0x1d;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, name) => {
    if (name[0] === '#') { const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

const attr = (raw, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(raw) || new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(raw); return m ? decodeEntities(m[1]) : ''; };

// Modèle de blocs : {type:'text', text, align, bold, size, indent, box} | {type:'row', left, right, bold, size, indent, small}
// | {type:'rule'} | {type:'image', src}
export function parseReceipt(html) {
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const body = (bodyMatch ? bodyMatch[1] : html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const blocks = [];
  const stack = [];
  let current = null;
  let row = null;
  let spanIndex = -1;
  const blockTags = new Set(['h1', 'h2', 'h3', 'p', 'div', 'footer', 'section', 'header', 'li']);
  const flush = () => {
    if (current && current.text.replace(/\s+/g, '') !== '') blocks.push({ ...current, text: current.text.replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim() });
    current = null;
  };
  const tokenizer = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokenizer.exec(body))) {
    const [, closing, rawTag, rawAttrs, selfClosing, textChunk] = m;
    if (textChunk !== undefined) {
      const text = decodeEntities(textChunk.replace(/\s+/g, ' '));
      if (row) { if (spanIndex === 0) row.left += text; else if (spanIndex >= 1) row.right += text; else row.left += text; }
      else if (current) current.text += text;
      else if (text.trim()) current = { type: 'text', text, align: 'left', bold: false, size: 0, indent: 0 };
      continue;
    }
    const tag = rawTag.toLowerCase();
    const classes = new Set(attr(rawAttrs || '', 'class').split(/\s+/).filter(Boolean));
    if (!closing) {
      if (tag === 'br') { if (row) row.left += ' '; else if (current) current.text += '\n'; continue; }
      if (tag === 'img') { if (classes.has('logo') || attr(rawAttrs, 'src').startsWith('data:image')) { flush(); blocks.push({ type: 'image', src: attr(rawAttrs, 'src') }); } continue; }
      if (tag === 'span' && row) { spanIndex++; stack.push({ tag, classes }); continue; }
      if (blockTags.has(tag)) {
        const parent = stack[stack.length - 1];
        const inherited = parent?.style || {};
        if (tag === 'div' && classes.has('rule')) { flush(); blocks.push({ type: 'rule' }); if (!selfClosing) stack.push({ tag, classes, rule: true }); continue; }
        if (tag === 'div' && classes.has('row')) {
          flush();
          row = { type: 'row', left: '', right: '', bold: classes.has('bold') || !!inherited.bold, size: classes.has('large') ? 1 : 0, indent: classes.has('option') ? 2 : 0, small: classes.has('small') || classes.has('option') };
          spanIndex = -1;
          stack.push({ tag, classes, row: true });
          continue;
        }
        flush();
        const style = {
          align: classes.has('center') || tag === 'h1' || tag === 'h2' || tag === 'footer' ? 'center' : (classes.has('right') ? 'right' : (inherited.align || 'left')),
          bold: tag === 'h1' || tag === 'h2' || classes.has('bold') || classes.has('comment') || classes.has('void') || !!inherited.bold,
          size: tag === 'h1' ? 2 : tag === 'h2' ? 1 : (classes.has('large') ? 1 : 0),
          indent: classes.has('comment') || classes.has('option') ? 2 : 0,
          box: classes.has('void'),
          small: classes.has('small'),
        };
        stack.push({ tag, classes, style });
        if (tag !== 'section' && tag !== 'header') current = { type: 'text', text: '', ...style };
        continue;
      }
      stack.push({ tag, classes });
      continue;
    }
    // Fermeture
    let opened;
    while (stack.length) { const top = stack.pop(); if (top.tag === tag) { opened = top; break; } }
    if (!opened) continue;
    if (opened.row) {
      if (row) blocks.push({ ...row, left: row.left.replace(/\s+/g, ' ').trim(), right: row.right.replace(/\s+/g, ' ').trim() });
      row = null; spanIndex = -1;
    } else if (blockTags.has(tag) && !opened.rule) {
      flush();
      const parent = stack[stack.length - 1];
      if (parent?.style && parent.tag !== 'section' && parent.tag !== 'header') current = { type: 'text', text: '', ...parent.style };
    }
  }
  flush();
  return blocks;
}

// Translittération pour le mode texte (police interne de l'imprimante, ASCII sûr sur tous les modèles).
const MAP = { '×': 'x', '−': '-', '–': '-', '—': '-', '↳': '>', '→': '->', '←': '<-', '’': "'", '‘': "'", '“': '"', '”': '"', '«': '"', '»': '"', '…': '...', '€': 'EUR', 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE', 'ß': 'ss', '·': '-', '•': '*', '°': 'o', ' ': ' ', ' ': ' ' };
export function toAscii(text) {
  return String(text).replace(/[×−–—↳→←’‘“”«»…€œŒæÆß·•°  ]/g, c => MAP[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\n]/g, '?');
}
// Vrai si le texte contient une écriture que la police interne ne sait pas imprimer (arabe, etc.).
export const needsGraphics = blocks => blocks.some(b => /[^\u0000-ɏ×−–—↳→←’‘“”«»…€·•°  ]/.test(b.type === 'row' ? b.left + b.right : (b.text || '')));

export function wrap(text, width) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (!word) continue;
      let w = word;
      while (w.length > width) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, width)); w = w.slice(width); }
      if (!w) continue;
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

class Bytes {
  constructor() { this.parts = []; this.size = 0; }
  push(...values) { for (const v of values) { if (typeof v === 'number') { this.parts.push(Uint8Array.of(v)); this.size += 1; } else { this.parts.push(v); this.size += v.length; } } return this; }
  text(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f; return this.push(b); }
  done() { const out = new Uint8Array(this.size); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

export const commands = {
  init: () => Uint8Array.of(ESC, 0x40),
  align: a => Uint8Array.of(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0),
  bold: on => Uint8Array.of(ESC, 0x45, on ? 1 : 0),
  size: s => Uint8Array.of(GS, 0x21, s === 2 ? 0x11 : s === 1 ? 0x01 : 0x00),
  feed: n => Uint8Array.of(ESC, 0x64, n),
  cut: () => Uint8Array.of(GS, 0x56, 0x42, 0x00),
  // Impulsion tiroir-caisse : broche 2 (m=0) ou 5 (m=1), 50 ms / 500 ms.
  drawer: pin => Uint8Array.of(ESC, 0x70, pin === 5 ? 1 : 0, 25, 250),
};

// Image monochrome (1 = noir), largeur multiple de 8, en bandes GS v 0 pour ménager la mémoire des imprimantes.
export function rasterCommands(bits, width, height, band = 128) {
  const bytesPerRow = width >> 3;
  const out = new Bytes();
  for (let y = 0; y < height; y += band) {
    const h = Math.min(band, height - y);
    out.push(Uint8Array.of(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, h & 0xff, h >> 8));
    out.push(bits.subarray(y * bytesPerRow, (y + h) * bytesPerRow));
  }
  return out.done();
}

// Mode texte rapide : quelques Ko par ticket, idéal en Bluetooth. `images` : Map src -> {bits,width,height} déjà rasterisés.
export function textCommands(blocks, { paper = 80, images = new Map(), cut = true } = {}) {
  const cols = paper === 58 ? 32 : 48;
  const out = new Bytes();
  out.push(commands.init());
  let bold = false, size = 0, align = 'left';
  const set = (b, s, a) => { if (b !== bold) { out.push(commands.bold(b)); bold = b; } if (s !== size) { out.push(commands.size(s)); size = s; } if (a !== align) { out.push(commands.align(a)); align = a; } };
  for (const block of blocks) {
    if (block.type === 'rule') { set(false, 0, 'left'); out.text('-'.repeat(cols) + '\n'); continue; }
    if (block.type === 'image') { const img = images.get(block.src); if (img) { set(false, 0, 'center'); out.push(rasterCommands(img.bits, img.width, img.height)); out.text('\n'); } continue; }
    if (block.type === 'row') {
      set(block.bold, block.size, 'left');
      const width = cols - block.indent;
      const right = toAscii(block.right);
      const leftWidth = Math.max(8, width - right.length - (right ? 1 : 0));
      const lines = wrap(toAscii(block.left), leftWidth);
      lines.forEach((line, i) => {
        const pad = ' '.repeat(block.indent);
        if (i === 0 && right) out.text(pad + line + ' '.repeat(Math.max(1, width - line.length - right.length)) + right + '\n');
        else out.text(pad + line + '\n');
      });
      continue;
    }
    const width = Math.floor((block.size === 2 ? cols / 2 : cols) - block.indent);
    set(block.bold, block.size, block.align);
    if (block.box) { out.text('='.repeat(Math.min(width, 24)) + '\n'); }
    for (const line of wrap(toAscii(block.text), width)) out.text(' '.repeat(block.indent) + line + '\n');
    if (block.box) { out.text('='.repeat(Math.min(width, 24)) + '\n'); }
  }
  set(false, 0, 'left');
  out.push(commands.feed(4));
  if (cut) out.push(commands.cut());
  return out.done();
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
