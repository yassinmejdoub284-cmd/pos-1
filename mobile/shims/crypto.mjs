// Remplace node:crypto dans la version Android. Les calculs lourds (PBKDF2 150 000 tours,
// SHA-256) sont faits en natif : connexion instantanée même sur une tablette d'entrée de gamme.
import { PosBuffer } from './buffer.mjs';

const bridge = () => {
  const n = globalThis.SamuraiNative;
  if (!n) throw new Error('Pont Android indisponible.');
  return n;
};

export function randomUUID() { return globalThis.crypto.randomUUID(); }

export function randomBytes(size) {
  const out = new PosBuffer(size);
  for (let i = 0; i < size; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(size, i + 65536)));
  return out;
}

export function pbkdf2Sync(password, salt, iterations, keyLength, digest) {
  if (String(digest).toLowerCase() !== 'sha256') throw new Error('Algorithme PBKDF2 non pris en charge : ' + digest);
  return PosBuffer.from(bridge().pbkdf2(String(password), String(salt), iterations, keyLength), 'hex');
}

export function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== 'sha256') throw new Error('Empreinte non prise en charge : ' + algorithm);
  let data = '';
  return {
    update(value) { data += typeof value === 'string' ? value : new TextDecoder().decode(value); return this; },
    digest(encoding) { const hex = bridge().sha256(data); return encoding === 'hex' ? hex : PosBuffer.from(hex, 'hex'); },
  };
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default { randomUUID, randomBytes, pbkdf2Sync, createHash, timingSafeEqual };
