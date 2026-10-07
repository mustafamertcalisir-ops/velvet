/**
 * Private object storage (DEC-063). Two drivers behind one interface:
 *
 *   s3     staging / production — any S3-compatible service (AWS S3,
 *          Cloudflare R2, Backblaze B2, GCS interoperability, MinIO).
 *          Uploads and downloads use the provider's own presigned URLs, so
 *          image bytes never pass through the API in production.
 *   local  development / test — files on disk; the API itself serves the
 *          signed upload and download URLs (an emulation of the same flow).
 *
 * Two buckets: `media` (application + member photos, incoming uploads) and
 * `verification` (identity photos only — a separate bucket and policy).
 * Keys are opaque; no URL is ever permanent or public.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from '../config';
import { hmac, safeEqual } from '../lib/crypto';
import type { Clock } from '../lib/clock';

export type Bucket = 'media' | 'verification';
export const BUCKETS: readonly Bucket[] = ['media', 'verification'];

/** Signed urls never live longer than this (local driver check; S3 enforces its own expiry). */
const MAX_SIGNED_TTL_SECONDS = 15 * 60;

const KEY = /^(incoming|application|verification|member)\/[A-Za-z0-9_-]{4,80}\/[A-Za-z0-9_-]{4,80}\.(jpg|bin)$/;
export const isObjectKey = (key: string) => KEY.test(key);

export type PresignedUpload = { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };

/** One stored object, as listed (no content). */
export type ListedObject = { key: string; bytes: number; lastModified: string };
/** One page of a listing; `next` continues it (null = done). */
export type ListPage = { objects: ListedObject[]; next: string | null };

export interface ObjectStore {
  readonly driver: 'local' | 's3';
  presignUpload(bucket: Bucket, key: string, opts: { contentType: string; bytes: number; ttlSeconds: number }): Promise<PresignedUpload>;
  presignDownload(bucket: Bucket, key: string, ttlSeconds: number): Promise<string>;
  /** Null when absent. Refuses objects larger than maxBytes (returns 'TOO_LARGE'). */
  get(bucket: Bucket, key: string, maxBytes: number): Promise<Buffer | null | 'TOO_LARGE'>;
  put(bucket: Bucket, key: string, bytes: Buffer, contentType: string): Promise<void>;
  copy(from: { bucket: Bucket; key: string }, to: { bucket: Bucket; key: string }): Promise<void>;
  delete(bucket: Bucket, key: string): Promise<void>;
  /**
   * List objects under a prefix, one page at a time, in key order (S3
   * ListObjectsV2). Keys are returned as stored — including ones that do not
   * match the application's key pattern (reconciliation reports those).
   */
  list(bucket: Bucket, prefix: string, cursor?: string | null): Promise<ListPage>;
  /** Readiness: can the store be reached? */
  ping(): Promise<boolean>;
}

/** Iterate a whole listing (page by page). */
export async function* listAll(store: ObjectStore, bucket: Bucket, prefix: string): AsyncGenerator<ListedObject> {
  let cursor: string | null = null;
  do {
    const page: ListPage = await store.list(bucket, prefix, cursor);
    for (const o of page.objects) yield o;
    cursor = page.next;
  } while (cursor);
}

// --- Local (development / test) -------------------------------------------------------------

export type LocalSignedParams = { b: string; k: string; exp: string; sig: string; ct?: string; n?: string };

export type LocalObjectStore = ObjectStore & {
  /** Verify a signed local upload URL; returns the declared type and size. */
  verifyUpload(p: LocalSignedParams): { bucket: Bucket; key: string; contentType: string; bytes: number } | null;
  verifyDownload(p: LocalSignedParams): { bucket: Bucket; key: string } | null;
  read(bucket: Bucket, key: string): Buffer | null;
  write(bucket: Bucket, key: string, bytes: Buffer): void;
};

export function localObjectStore(opts: { dir: string; baseUrl: string; secret: string; clock: Clock }): LocalObjectStore {
  const root = resolve(opts.dir);
  const pathOf = (bucket: Bucket, key: string) => {
    if (!BUCKETS.includes(bucket) || !isObjectKey(key)) throw new Error('Invalid object key');
    const p = resolve(root, bucket, key);
    if (!p.startsWith(`${root}/`)) throw new Error('Invalid object key');
    return p;
  };
  const nowS = () => Math.floor(opts.clock().getTime() / 1000);
  const sign = (parts: string[]) => hmac(opts.secret, parts.join('\n'));
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

  const store: LocalObjectStore = {
    driver: 'local',
    async presignUpload(bucket, key, { contentType, bytes, ttlSeconds }) {
      pathOf(bucket, key);
      const exp = String(nowS() + ttlSeconds);
      const n = String(bytes);
      const sig = sign(['PUT', bucket, key, contentType, n, exp]);
      return {
        url: `${opts.baseUrl}/v1/storage/upload?${q({ b: bucket, k: key, ct: contentType, n, exp, sig })}`,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Number(exp) * 1000).toISOString(),
      };
    },
    async presignDownload(bucket, key, ttlSeconds) {
      pathOf(bucket, key);
      const exp = String(nowS() + ttlSeconds);
      return `${opts.baseUrl}/v1/storage/object?${q({ b: bucket, k: key, exp, sig: sign(['GET', bucket, key, exp]) })}`;
    },
    verifyUpload(p) {
      if (!BUCKETS.includes(p.b as Bucket) || !isObjectKey(p.k) || !p.ct || !p.n) return null;
      const exp = Number(p.exp);
      if (!Number.isInteger(exp) || exp < nowS() || exp > nowS() + MAX_SIGNED_TTL_SECONDS) return null;
      const n = Number(p.n);
      if (!Number.isInteger(n) || n <= 0) return null;
      if (!safeEqual(sign(['PUT', p.b, p.k, p.ct, p.n, p.exp]), p.sig)) return null;
      return { bucket: p.b as Bucket, key: p.k, contentType: p.ct, bytes: n };
    },
    verifyDownload(p) {
      if (!BUCKETS.includes(p.b as Bucket) || !isObjectKey(p.k)) return null;
      const exp = Number(p.exp);
      if (!Number.isInteger(exp) || exp < nowS() || exp > nowS() + MAX_SIGNED_TTL_SECONDS) return null;
      if (!safeEqual(sign(['GET', p.b, p.k, p.exp]), p.sig)) return null;
      return { bucket: p.b as Bucket, key: p.k };
    },
    read(bucket, key) {
      const p = pathOf(bucket, key);
      return existsSync(p) ? readFileSync(p) : null;
    },
    write(bucket, key, bytes) {
      const p = pathOf(bucket, key);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, bytes, { mode: 0o600 });
    },
    async get(bucket, key, maxBytes) {
      const p = pathOf(bucket, key);
      if (!existsSync(p)) return null;
      if (statSync(p).size > maxBytes) return 'TOO_LARGE';
      return readFileSync(p);
    },
    async put(bucket, key, bytes) {
      store.write(bucket, key, bytes);
    },
    async copy(from, to) {
      const target = pathOf(to.bucket, to.key);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(pathOf(from.bucket, from.key), target);
    },
    async delete(bucket, key) {
      rmSync(pathOf(bucket, key), { force: true });
    },
    async list(bucket, prefix, cursor) {
      if (!BUCKETS.includes(bucket)) throw new Error('Invalid bucket');
      const base = resolve(root, bucket);
      const all: ListedObject[] = [];
      const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            const key = relative(base, full).split('\\').join('/');
            if (key.startsWith(prefix)) {
              const st = statSync(full);
              all.push({ key, bytes: st.size, lastModified: st.mtime.toISOString() });
            }
          }
        }
      };
      walk(base);
      all.sort((a, b) => (a.key < b.key ? -1 : 1));
      const start = cursor ? all.findIndex((o) => o.key > cursor) : 0;
      const from = start < 0 ? all.length : start;
      const objects = all.slice(from, from + LIST_PAGE);
      return { objects, next: from + LIST_PAGE < all.length ? objects[objects.length - 1]!.key : null };
    },
    async ping() {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return existsSync(root);
    },
  };
  return store;
}

/** Objects per listing page (S3's maximum is 1000). */
const LIST_PAGE = 1000;

// --- S3-compatible (staging / production) -----------------------------------------------------

export function s3ObjectStore(cfg: Extract<StorageConfig, { driver: 's3' }>, client?: S3Client): ObjectStore {
  const s3 =
    client ??
    new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint ?? undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
    });
  const name = (b: Bucket) => (b === 'verification' ? cfg.verificationBucket : cfg.bucket);
  const check = (key: string) => {
    if (!isObjectKey(key)) throw new Error('Invalid object key');
  };
  return {
    driver: 's3',
    async presignUpload(bucket, key, { contentType, bytes, ttlSeconds }) {
      check(key);
      // Content-Type and Content-Length are signed: the upload must be exactly what was authorised.
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: name(bucket), Key: key, ContentType: contentType, ContentLength: bytes }), {
        expiresIn: ttlSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    },
    async presignDownload(bucket, key, ttlSeconds) {
      check(key);
      return getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: name(bucket), Key: key, ResponseCacheControl: `private, max-age=${Math.min(ttlSeconds, 300)}` }),
        { expiresIn: ttlSeconds },
      );
    },
    async get(bucket, key, maxBytes) {
      check(key);
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: name(bucket), Key: key }));
        if ((head.ContentLength ?? 0) > maxBytes) return 'TOO_LARGE';
        const out = await s3.send(new GetObjectCommand({ Bucket: name(bucket), Key: key }));
        const bytes = Buffer.from(await out.Body!.transformToByteArray());
        return bytes.length > maxBytes ? 'TOO_LARGE' : bytes;
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (e as { name?: string }).name === 'NotFound' || (e as { name?: string }).name === 'NoSuchKey') return null;
        throw e;
      }
    },
    async put(bucket, key, bytes, contentType) {
      check(key);
      await s3.send(
        new PutObjectCommand({
          Bucket: name(bucket),
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentMD5: createHash('md5').update(bytes).digest('base64'),
        }),
      );
    },
    async copy(from, to) {
      check(from.key);
      check(to.key);
      // CopySource is "bucket/key", URL-encoded per path segment (slashes stay separators).
      const source = `${name(from.bucket)}/${from.key.split('/').map(encodeURIComponent).join('/')}`;
      await s3.send(new CopyObjectCommand({ Bucket: name(to.bucket), Key: to.key, CopySource: source }));
    },
    async delete(bucket, key) {
      check(key);
      await s3.send(new DeleteObjectCommand({ Bucket: name(bucket), Key: key }));
    },
    async list(bucket, prefix, cursor) {
      const out = await s3.send(
        new ListObjectsV2Command({ Bucket: name(bucket), Prefix: prefix, ContinuationToken: cursor ?? undefined, MaxKeys: LIST_PAGE }),
      );
      return {
        objects: (out.Contents ?? []).map((o) => ({
          key: o.Key ?? '',
          bytes: o.Size ?? 0,
          lastModified: (o.LastModified ?? new Date(0)).toISOString(),
        })),
        next: out.IsTruncated && out.NextContinuationToken ? out.NextContinuationToken : null,
      };
    },
    async ping() {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: 'incoming/healthcheck/probe.bin' }));
        return true;
      } catch (e) {
        // The probe object does not exist: a 404 proves the bucket is reachable with these credentials.
        return (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
      }
    },
  };
}
