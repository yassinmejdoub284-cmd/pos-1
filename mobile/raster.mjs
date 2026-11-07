// Rendu graphique des tickets (accents, arabe, logo) dans un canvas, puis conversion 1 bit
// pour l'imprimante thermique. 80 mm = 576 points, 58 mm = 384 points.
import { rasterCommands, commands } from './escpos.mjs';

const FONT = 'Roboto, "Noto Sans", "Noto Sans Arabic", Arial, sans-serif';
const MAX_HEIGHT = 7000; // au-delà (longs rapports), le mode texte est utilisé : mémoire maîtrisée sur 3 Go.

export const paperWidth = paper => (paper === 58 ? 384 : 576);

async function loadImage(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  try { await img.decode(); } catch { await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; }); }
  return img.naturalWidth ? img : null;
}

// Logo seul (utilisé aussi par le mode texte) : tramage Floyd-Steinberg.
export async function rasterLogo(src, paper) {
  const img = await loadImage(src);
  if (!img) return null;
  const width = paperWidth(paper);
  const maxW = Math.round(width * 0.62), maxH = paper === 58 ? 130 : 176;
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1.5);
  const w = Math.max(8, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = h + 6;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, Math.round((width - w) / 2), 0, w, h);
  const bits = toBits(ctx, width, canvas.height, [{ x: 0, y: 0, w: width, h: canvas.height }]);
  canvas.width = canvas.height = 0;
  return { bits, width, height: h + 6 };
}

function layout(ctx, blocks, width, base) {
  const margin = 6, inner = width - margin * 2;
  const style = (block, extra = {}) => {
    const size = block.size === 2 ? base * 1.55 : block.size === 1 ? base * 1.3 : (block.small ? base * 0.86 : base);
    return { px: Math.round(size), weight: block.bold || block.size ? '700' : '500', ...extra };
  };
  const font = s => `${s.weight} ${s.px}px ${FONT}`;
  const wrapPx = (text, max, s) => {
    ctx.font = font(s);
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        if (!word) continue;
        const candidate = line ? line + ' ' + word : word;
        if (ctx.measureText(candidate).width <= max) { line = candidate; continue; }
        if (line) lines.push(line);
        line = word;
        while (ctx.measureText(line).width > max && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > max) cut--;
          lines.push(line.slice(0, cut)); line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  };
  const ops = [];
  let y = 4;
  for (const block of blocks) {
    if (block.type === 'rule') { ops.push({ kind: 'rule', y: y + 8 }); y += 18; continue; }
    if (block.type === 'image') { ops.push({ kind: 'image', y, src: block.src }); y += block.height || 0; continue; }
    const s = style(block);
    const lh = Math.round(s.px * 1.28);
    const indent = block.indent ? Math.round(base * 0.9) : 0;
    if (block.type === 'row') {
      ctx.font = font(s);
      const rightW = block.right ? ctx.measureText(block.right).width : 0;
      const lines = wrapPx(block.left, Math.max(60, inner - indent - rightW - (rightW ? 14 : 0)), s);
      lines.forEach((line, i) => ops.push({ kind: 'text', text: line, x: margin + indent, y: y + i * lh, s, align: 'left' }));
      if (block.right) ops.push({ kind: 'text', text: block.right, x: width - margin, y, s, align: 'right' });
      y += lines.length * lh + 3;
      continue;
    }
    const lines = wrapPx(block.text, inner - indent - (block.box ? 16 : 0), s);
    const top = y;
    if (block.box) y += 6;
    lines.forEach(line => {
      const x = block.align === 'center' ? width / 2 : block.align === 'right' ? width - margin : margin + indent;
      ops.push({ kind: 'text', text: line, x, y, s, align: block.align });
      y += lh;
    });
    if (block.box) { y += 6; ops.push({ kind: 'box', y: top, h: y - top }); }
    y += 4;
  }
  return { ops, height: y + 8, font, margin };
}

// Convertit le canvas en bits : seuil net pour le texte, tramage dans les zones d'image.
function toBits(ctx, width, height, ditherRects = []) {
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) * a + 255 * (1 - a);
  }
  const inDither = new Uint8Array(width * height);
  for (const r of ditherRects) for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) inDither.fill(1, y * width + Math.max(0, r.x), y * width + Math.min(width, r.x + r.w));
  const bytesPerRow = width >> 3;
  const bits = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let black;
      if (inDither[i]) {
        const old = gray[i];
        black = old < 128;
        const err = old - (black ? 0 : 255);
        if (x + 1 < width) gray[i + 1] += err * 7 / 16;
        if (y + 1 < height) { if (x > 0) gray[i + width - 1] += err * 3 / 16; gray[i + width] += err * 5 / 16; if (x + 1 < width) gray[i + width + 1] += err / 16; }
      } else black = gray[i] < 170;
      if (black) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bits;
}

// Ticket complet en image. Retourne null si trop long (le mode texte prend le relais).
export async function imageCommands(blocks, { paper = 80, cut = true } = {}) {
  const width = paperWidth(paper);
  const base = paper === 58 ? 21 : 24;
  const images = new Map();
  for (const block of blocks) if (block.type === 'image' && !images.has(block.src)) images.set(block.src, await loadImage(block.src));
  const sized = blocks.map(block => {
    if (block.type !== 'image') return block;
    const img = images.get(block.src);
    if (!img) return { ...block, height: 0 };
    const scale = Math.min((width * 0.62) / img.naturalWidth, (paper === 58 ? 130 : 176) / img.naturalHeight, 1.5);
    return { ...block, w: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) + 8 };
  });
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = 10;
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  const plan = layout(ctx, sized, width, base);
  if (plan.height > MAX_HEIGHT) { canvas.width = canvas.height = 0; return null; }
  canvas.height = plan.height;
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, plan.height);
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.textBaseline = 'top';
  const dither = [];
  let imageIndex = 0;
  const imageBlocks = sized.filter(b => b.type === 'image');
  for (const op of plan.ops) {
    if (op.kind === 'rule') { ctx.setLineDash([7, 5]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(plan.margin, op.y); ctx.lineTo(width - plan.margin, op.y); ctx.stroke(); ctx.setLineDash([]); continue; }
    if (op.kind === 'box') { ctx.lineWidth = 3; ctx.strokeRect(plan.margin + 2, op.y, width - plan.margin * 2 - 4, op.h); continue; }
    if (op.kind === 'image') {
      const block = imageBlocks[imageIndex++]; const img = images.get(op.src);
      if (img && block?.w) { const x = Math.round((width - block.w) / 2); ctx.drawImage(img, x, op.y, block.w, block.height - 8); dither.push({ x, y: op.y, w: block.w, h: block.height - 8 }); }
      continue;
    }
    ctx.font = plan.font(op.s);
    ctx.textAlign = op.align === 'center' ? 'center' : op.align === 'right' ? 'right' : 'left';
    ctx.fillText(op.text, op.x, op.y);
  }
  const bits = toBits(ctx, width, plan.height, dither);
  canvas.width = canvas.height = 0; // libère la mémoire tout de suite
  const head = commands.init();
  const body = rasterCommands(bits, width, plan.height);
  const tail = cut ? Uint8Array.of(...commands.feed(4), ...commands.cut()) : commands.feed(4);
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0); out.set(body, head.length); out.set(tail, head.length + body.length);
  return out;
}
