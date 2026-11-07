// Pavé numérique tactile pour les champs montants, quantités et codes : grandes touches,
// pas de clavier Android qui masque la moitié de l'écran.
const SELECTOR = 'input[inputmode="decimal"],input[inputmode="numeric"],input[data-keypad]';
let panel, target, targetId, systemKeyboard = false;

const isNumeric = el => el && el.matches && el.matches(SELECTOR) && !el.disabled && !el.readOnly;

function current() {
  if (targetId) { const el = document.getElementById(targetId); if (el) target = el; }
  return target && target.isConnected ? target : null;
}

function build() {
  panel = document.createElement('div');
  panel.className = 'touch-keypad';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Pavé numérique');
  const keys = ['7', '8', '9', '⌫', '4', '5', '6', 'C', '1', '2', '3', '⌨', '0', '00', '.', 'OK'];
  panel.innerHTML = keys.map(k => `<button type="button" tabindex="-1" data-key="${k}" class="${k === 'OK' ? 'ok' : /[⌫C⌨]/.test(k) ? 'fn' : ''}">${k}</button>`).join('');
  // pointerdown + preventDefault : le champ garde le focus, aucune latence de clic.
  panel.addEventListener('pointerdown', event => {
    const key = event.target.closest('button')?.dataset.key;
    event.preventDefault();
    if (key) press(key);
  });
  document.body.appendChild(panel);
}

function emit(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }

function press(key) {
  const el = current();
  if (!el) return hide();
  const value = el.value;
  const start = el.selectionStart ?? value.length, end = el.selectionEnd ?? value.length;
  const decimal = (el.dataset.keypad || el.getAttribute('inputmode')) === 'decimal';
  let next = value, caret = start;
  if (key === 'OK') { hide(); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); return; }
  if (key === '⌨') {
    systemKeyboard = true; hide();
    for (const input of document.querySelectorAll('input[data-keypad]')) input.setAttribute('inputmode', input.dataset.keypad);
    el.blur(); setTimeout(() => el.focus(), 50); return;
  }
  if (key === 'C') { next = ''; caret = 0; }
  else if (key === '⌫') { if (start !== end) { next = value.slice(0, start) + value.slice(end); caret = start; } else if (start > 0) { next = value.slice(0, start - 1) + value.slice(start); caret = start - 1; } }
  else {
    let insert = key;
    if (insert === '.') { if (!decimal || value.includes('.') || value.includes(',')) return; if (!value.slice(0, start)) insert = '0.'; }
    const max = Number(el.getAttribute('maxlength')) || 0;
    if (max && value.length - (end - start) + insert.length > max) return;
    next = value.slice(0, start) + insert + value.slice(end); caret = start + insert.length;
  }
  el.value = next;
  try { el.setSelectionRange(caret, caret); } catch { /* type sans sélection */ }
  emit(el);
  // Le rendu de l'application peut remplacer le champ : on le retrouve par son id.
  requestAnimationFrame(() => { const again = current(); if (again && document.activeElement !== again) { again.focus({ preventScroll: true }); try { again.setSelectionRange(caret, caret); } catch { /* idem */ } } place(); });
}

function place() {
  const el = current();
  if (!panel || !el || panel.hidden) return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  let x, y;
  if (r.left - pw - 12 >= 0) { x = r.left - pw - 12; y = r.top + r.height / 2 - ph / 2; }
  else if (r.right + pw + 12 <= vw) { x = r.right + 12; y = r.top + r.height / 2 - ph / 2; }
  else { x = Math.min(Math.max(8, r.left), vw - pw - 8); y = r.bottom + ph + 12 <= vh ? r.bottom + 8 : r.top - ph - 8; }
  panel.style.left = Math.round(Math.max(8, Math.min(x, vw - pw - 8))) + 'px';
  panel.style.top = Math.round(Math.max(8, Math.min(y, vh - ph - 8))) + 'px';
}

function show(el) {
  if (!panel) build();
  target = el; targetId = el.id || '';
  panel.hidden = false;
  place();
}

function hide() { if (panel) panel.hidden = true; target = null; targetId = ''; }

// Les champs numériques n'ouvrent plus le clavier système (inputmode=none) tant que le pavé est utilisé.
function prepare(root) {
  if (systemKeyboard) return;
  for (const el of root.querySelectorAll(SELECTOR)) if (el.getAttribute('inputmode') !== 'none') { el.dataset.keypad = el.getAttribute('inputmode') || 'numeric'; el.setAttribute('inputmode', 'none'); }
}

export function installKeypad() {
  document.addEventListener('focusin', event => {
    const el = event.target;
    if (!systemKeyboard && isNumeric(el)) { if (!el.dataset.keypad) prepare(el.parentNode || document); show(el); }
    else if (panel && !panel.contains(el)) hide();
  });
  document.addEventListener('pointerdown', event => {
    if (!panel || panel.hidden) return;
    if (panel.contains(event.target) || event.target === current()) return;
    if (event.target.closest?.('input[data-keypad]')) return;
    hide();
  }, true);
  window.addEventListener('resize', place);
  document.addEventListener('scroll', place, true);
  const observer = new MutationObserver(() => { prepare(document); if (panel && !panel.hidden && !current()) hide(); });
  observer.observe(document.body, { childList: true, subtree: true });
  prepare(document);
}
