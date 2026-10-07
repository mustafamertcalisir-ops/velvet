/**
 * Internal service authentication (DEC-070, docs/SECURITY_MODEL.md).
 *
 * Internal routes (/internal/*) are called by operator tooling — review
 * tooling, the billing provider adapter, the retention job, the staging smoke
 * test — never by the app. They never accept an applicant or member session.
 *
 * Every internal request is signed with a per-caller key:
 *
 *   X-Internal-Key-Id     which key (each caller has its own; keys carry scopes)
 *   X-Internal-Timestamp  unix seconds; accepted within ±5 minutes
 *   X-Internal-Nonce      random, single use per key (replay protection, stored)
 *   X-Internal-Signature  base64url HMAC-SHA256 over
 *                         ENV \n METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
 *
 * ENV is the API's APP_ENV (staging, production…): a request signed for one
 * environment is refused by another even if a key were shared by mistake.
 *
 * A captured request cannot be replayed (nonce), altered (signature covers
 * method, path, query and body) or used after the window (timestamp). A key
 * only reaches the routes its scopes allow; keys rotate by adding a new id and
 * removing the old one from INTERNAL_KEYS_JSON.
 *
 * This is the staging mechanism. In production, service-to-service identity
 * (private network, mTLS or the platform's workload identity) is a deployment
 * concern that sits IN FRONT of this check, not instead of it.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { InternalScope } from '../config';
import { safeEqual } from '../lib/crypto';

export const INTERNAL_HEADERS = {
  keyId: 'x-internal-key-id',
  timestamp: 'x-internal-timestamp',
  nonce: 'x-internal-nonce',
  signature: 'x-internal-signature',
} as const;

export const INTERNAL_WINDOW_SECONDS = 300;

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const KEY_ID = /^[a-z][a-z0-9-]{1,40}$/;

export function canonicalRequest(env: string, method: string, pathAndQuery: string, timestamp: string, nonce: string, body: string): string {
  return [env, method.toUpperCase(), pathAndQuery, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
}

export function signInternalRequest(opts: {
  env: string;
  keyId: string;
  secret: string;
  method: string;
  pathAndQuery: string;
  body?: string;
  now?: Date;
  nonce?: string;
}): Record<string, string> {
  const timestamp = String(Math.floor((opts.now ?? new Date()).getTime() / 1000));
  const nonce = opts.nonce ?? randomBytes(18).toString('base64url');
  const signature = createHmac('sha256', opts.secret)
    .update(canonicalRequest(opts.env, opts.method, opts.pathAndQuery, timestamp, nonce, opts.body ?? ''))
    .digest('base64url');
  return {
    [INTERNAL_HEADERS.keyId]: opts.keyId,
    [INTERNAL_HEADERS.timestamp]: timestamp,
    [INTERNAL_HEADERS.nonce]: nonce,
    [INTERNAL_HEADERS.signature]: signature,
  };
}

export type InternalPrincipal = { keyId: string; scopes: readonly InternalScope[] };

export type InternalVerdict =
  | { ok: true; principal: InternalPrincipal; nonce: string; timestamp: number }
  | { ok: false; reason: 'MISSING' | 'UNKNOWN_KEY' | 'STALE' | 'BAD_SIGNATURE' | 'SCOPE' };

/** Pure verification (no replay check — the caller records the nonce). */
export function verifyInternalRequest(
  keys: Record<string, { secret: string; scopes: readonly InternalScope[] }>,
  req: { method: string; pathAndQuery: string; body: string; header: (name: string) => string | undefined },
  required: InternalScope,
  now: Date,
  env: string,
): InternalVerdict {
  const keyId = req.header(INTERNAL_HEADERS.keyId) ?? '';
  const ts = req.header(INTERNAL_HEADERS.timestamp) ?? '';
  const nonce = req.header(INTERNAL_HEADERS.nonce) ?? '';
  const sig = req.header(INTERNAL_HEADERS.signature) ?? '';
  if (!KEY_ID.test(keyId) || !/^\d{9,12}$/.test(ts) || !NONCE.test(nonce) || !sig) return { ok: false, reason: 'MISSING' };
  const key = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  if (!key) return { ok: false, reason: 'UNKNOWN_KEY' };
  const timestamp = Number(ts);
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > INTERNAL_WINDOW_SECONDS) return { ok: false, reason: 'STALE' };
  const expected = createHmac('sha256', key.secret).update(canonicalRequest(env, req.method, req.pathAndQuery, ts, nonce, req.body)).digest('base64url');
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (!key.scopes.includes(required)) return { ok: false, reason: 'SCOPE' };
  return { ok: true, principal: { keyId, scopes: key.scopes }, nonce, timestamp };
}
