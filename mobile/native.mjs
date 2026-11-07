// Accès au pont natif Android (objet `SamuraiNative` injecté par MainActivity).
// Appels synchrones : base SQLite, PBKDF2, SHA-256, secrets.
// Appels asynchrones : Bluetooth, HTTP, sauvegarde ; le natif répond par window.__nativeReply(id, json).
const pending = new Map();
let nextId = 1;

export const native = globalThis.SamuraiNative;

globalThis.__nativeReply = (id, payload) => {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  let data = payload;
  try { if (typeof payload === 'string') data = JSON.parse(payload); } catch { /* texte brut */ }
  if (data && data.error) { const error = new Error(data.error); error.code = data.code; entry.reject(error); }
  else entry.resolve(data?.value ?? data);
};

// Le natif peut aussi envoyer des événements (imprimante appairée, Bluetooth activé…).
const listeners = new Map();
globalThis.__nativeEvent = (name, payload) => {
  let data = payload;
  try { if (typeof payload === 'string') data = JSON.parse(payload); } catch { /* texte brut */ }
  for (const fn of listeners.get(name) || []) { try { fn(data); } catch (error) { console.error(error); } }
};
export function onNativeEvent(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
}

export function nativeAsync(method, args = {}, timeoutMs = 60000) {
  if (!native || typeof native[method] !== 'function') return Promise.reject(new Error('Fonction Android indisponible : ' + method));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Le périphérique ne répond pas.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { native[method](id, JSON.stringify(args)); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

// fetch() natif pour la synchronisation : évite les blocages CORS de la WebView.
export async function nativeFetch(url, options = {}) {
  const result = await nativeAsync('http', {
    url: String(url), method: options.method || 'GET', headers: options.headers || {},
    body: typeof options.body === 'string' ? options.body : null, timeoutMs: 30000,
  }, 45000);
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    async json() { return JSON.parse(result.body || 'null'); },
    async text() { return result.body || ''; },
  };
}
