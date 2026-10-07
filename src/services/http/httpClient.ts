/**
 * The app's HTTP transport to the production API (docs/API_CONTRACT.md).
 *
 * - Every request carries the session as a bearer token; nothing else
 *   identifies the user.
 * - Errors arrive as typed codes and are mapped onto the ApiError union the
 *   screens already handle (toClientError). Transport failures (offline,
 *   timeout, unparseable response) are `network` — retryable.
 * - No retries happen here: submissions carry idempotency keys and the
 *   stores decide when to retry.
 * - `putBytes` sends a photo straight to private object storage through a
 *   short-lived signed URL (direct upload, DEC-063). It never carries the
 *   session: the signature is the only permission.
 */
import { IDEMPOTENCY_HEADER, toClientError, type ApiErrorBody, type Route } from '../api/contract';
import type { ApiResult, Session } from '../api/types';

export type HttpClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type CallOptions = {
  session?: Session | null;
  body?: unknown;
  idempotencyKey?: string;
};

export type HttpClient = (<T>(route: Route, options?: CallOptions) => Promise<ApiResult<T>>) & {
  putBytes(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<ApiResult<void>>;
};

export function createHttpClient({ baseUrl, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 }: HttpClientOptions): HttpClient {
  const base = baseUrl.replace(/\/+$/, '');
  async function putBytes(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<ApiResult<void>> {
    if (!/^https?:\/\//.test(url)) return { ok: false, error: { kind: 'server' } };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs * 3) : null;
    try {
      const res = await fetchImpl(url, { method: 'PUT', headers, body: bytes as unknown as BodyInit, signal: controller?.signal });
      if (res.ok) return { ok: true, value: undefined };
      if (res.status === 413) return { ok: false, error: { kind: 'validation', fields: ['photo'] } };
      return { ok: false, error: { kind: 'network' } };
    } catch {
      return { ok: false, error: { kind: 'network' } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return Object.assign(call, { putBytes });

  async function call<T>(route: Route, options: CallOptions = {}): Promise<ApiResult<T>> {
    if (!base) return { ok: false, error: { kind: 'server' } };
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.session) headers.Authorization = `Bearer ${options.session.token}`;
    if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`${base}${route.path}`, {
        method: route.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller?.signal,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (res.ok) return json === null ? { ok: false, error: { kind: 'network' } } : { ok: true, value: json as T };
      if (res.status >= 500 && !(json as ApiErrorBody | null)?.error) return { ok: false, error: { kind: 'network' } };
      return { ok: false, error: toClientError((json as ApiErrorBody | null)?.error) };
    } catch {
      return { ok: false, error: { kind: 'network' } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
