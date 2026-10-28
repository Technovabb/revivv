/*
 * Passwords are stored as scrypt hashes. Accounts brought over from Supabase
 * keep their bcrypt hash until the person next signs in, when it is replaced.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, LEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// { ok, rehash } — rehash is true for an old bcrypt hash that should be upgraded.
export async function verifyPassword(password, stored) {
  if (!stored) return { ok: false, rehash: false };
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, key] = stored.split('$');
    const want = Buffer.from(key, 'base64');
    const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
    return { ok: crypto.timingSafeEqual(got, want), rehash: false };
  }
  if (/^\$2[aby]\$/.test(stored)) return { ok: await bcrypt.compare(password, stored), rehash: true };
  return { ok: false, rehash: false };
}

// Spend about the same time when the email is unknown, so timing doesn't reveal accounts.
const DUMMY = hashPassword('not-a-real-password');
export async function burnTime(password) {
  await verifyPassword(password, await DUMMY);
}

export function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}
export function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest();
}
