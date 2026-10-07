/** Identifiers, tokens and keyed hashes. Node crypto only. */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Opaque, unguessable identifier with a readable prefix (`mem_…`, `itr_…`). */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(15).toString('base64url')}`;
}

/** A bearer secret (session token). Shown to the client once; stored only as a hash. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A six-digit one-time code from a CSPRNG. There is no fixed or development code. */
export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
