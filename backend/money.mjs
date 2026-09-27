export class PosError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function ensure(condition, message, status = 400) {
  if (!condition) throw new PosError(message, status);
}
export function integer(value, label, min = 0, max = 100_000_000) {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, `${label} invalide.`);
  return value;
}
export function label(value, field = 'Nom', max = 120) {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `${field} requis (maximum ${max} caractères).`);
  return value.trim();
}
export function dayInTunis(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export const dt = amount => (amount / 1000).toFixed(3) + ' DT';
