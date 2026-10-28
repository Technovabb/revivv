// Small helpers shared by every part of the API.

// A 4xx error carries a message the page shows as it is.
export function fail(status, message) {
  throw Object.assign(new Error(message), { statusCode: status });
}

export const text = v => (v == null ? '' : String(v).trim());

export function cleanEmail(v) {
  const e = text(v).toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

export function maxLen(value, n, what) {
  if (value && value.length > n) fail(400, `${what} is too long.`);
  return value;
}

// Optional free text: trimmed, length-checked, '' becomes null.
export const opt = (v, n, what) => maxLen(text(v), n, what) || null;

export function posId(v, what = 'record') {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, `Unknown ${what}.`);
  return id;
}

export function money(v, what = 'The amount') {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n)) fail(400, `${what} must be a number.`);
  if (Math.abs(n) > 100000) fail(400, `${what} is too large.`);
  return Math.round(n * 100) / 100;
}

export const round2 = n => Math.round(n * 100) / 100;
export const likeEscape = s => s.replace(/[\\%_]/g, m => '\\' + m);
export const letters = n => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
export const digits = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
export const firstName = name => text(name).split(/\s+/)[0] || '';
