/**
 * HTTP layer (Hono). Thin: correlate, authenticate, parse, call a service,
 * answer with its DTO.
 *
 * Routes are registered FROM the endpoint policy registry (endpoints.ts):
 * the authentication middleware comes from each endpoint's declared `auth`
 * (and internal `scope`), never from the shape of its path. Paths of app
 * routes come from the shared contract (src/services/api/contract.ts) — a
 * test checks the two agree.
 *
 *   session        bearer session → account id (expired, idle, revoked,
 *                  suspended, deleted → 401)
 *   internal       signed request with a scoped key (internalAuth.ts); never a
 *                  member or applicant session
 *   signed-url     the signature in the url is the permission (local storage)
 *
 * Every response carries X-Request-Id; errors carry it in the body too.
 * Server logs record the request id, route and outcome — never bodies.
 */
import { randomBytes } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { E164 } from '@/domain/admission/submissions';
import { InvalidTransitionError } from '@/domain/admission/status';
import { IDEMPOTENCY_HEADER, type CompletedUpload } from '@/services/api/contract';
import { isTestNumber } from '../auth/sms';
import { ipInCidrs } from '../config';
import { migrationStatus } from '../db/migrate';
import { requestContext } from '../lib/log';
import type { LocalObjectStore } from '../media/objectStore';
import { MAX_PHOTO_BYTES } from '../media/media';
import type { Services } from '../services';
import { ENDPOINTS, type EndpointId, type EndpointPolicy } from './endpoints';
import { AppError, errorResponse, fail } from './errors';
import { INTERNAL_HEADERS, verifyInternalRequest } from './internalAuth';

type Env = { Variables: { accountId: string; principal: string; rawBody: string } };
type Handler = (c: Context<Env>) => Promise<Response> | Response;

const JSON_LIMIT = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Private, loopback, link-local and carrier-grade NAT ranges: a platform proxy's address, never a client's. */
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'];

export function createApp(services: Services) {
  const { config, log, pool } = services;
  const app = new Hono<Env>();

  // --- Correlation, logging, headers ------------------------------------------------------------
  app.use('*', async (c, next) => {
    const inbound = c.req.header('x-request-id');
    const requestId = inbound && REQUEST_ID.test(inbound) ? inbound : `req_${randomBytes(9).toString('base64url')}`;
    const started = performance.now();
    await requestContext.run({ requestId }, async () => {
      await next();
      c.header('X-Request-Id', requestId);
      log.info('request', {
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
  });
  app.use(
    '*',
    cors({
      origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
      allowHeaders: ['Authorization', 'Content-Type', IDEMPOTENCY_HEADER, 'X-Request-Id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof InvalidTransitionError) {
      log.warn('request.invalid_transition', { route: c.req.routePath });
      const { status, body } = errorResponse(new AppError('NOT_ALLOWED'));
      return c.json(body, status as 403);
    }
    if (!(err instanceof AppError)) {
      // Server-side detail for operators: error class, database code / constraint, stack. Never request data.
      const e = err as Error & { code?: unknown; constraint?: unknown };
      log.error('request.failed', {
        method: c.req.method,
        route: c.req.routePath,
        errorName: e.name,
        dbCode: typeof e.code === 'string' ? e.code : undefined,
        constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
        stack: e.stack?.split('\n').slice(0, 8).join('\n'),
      });
    }
    const { status, body } = errorResponse(err);
    return c.json(body, status as 500);
  });
  app.notFound((c) => {
    const { status, body } = errorResponse(new AppError('NOT_FOUND'));
    return c.json(body, status as 404);
  });

  // --- Helpers ----------------------------------------------------------------------------------------
  const json = async (c: Context<Env>): Promise<unknown> => {
    const text = c.var.rawBody ?? (await c.req.text());
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return fail('VALIDATION_FAILED', { fields: ['body'] });
    }
  };
  /** The client address: the socket, or the entry our own proxy appended (TRUST_PROXY_HOPS). */
  const ip = (c: Context) => {
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    if (config.trustProxyHops > 0) {
      const chain = (c.req.header('x-forwarded-for') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const candidate = chain[chain.length - config.trustProxyHops];
      if (candidate) return candidate;
    }
    return socket ?? 'unknown';
  };
  const idem = (c: Context) => c.req.header(IDEMPOTENCY_HEADER);
  /** An optional JSON object with only the allowed keys (anything else is a validation error). */
  const strictBody = (b: unknown, allowed: string[]): Record<string, unknown> => {
    if (b === undefined) return {};
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return fail('VALIDATION_FAILED', { fields: ['body'] });
    const extra = Object.keys(b).filter((k) => !allowed.includes(k));
    if (extra.length) return fail('VALIDATION_FAILED', { fields: extra });
    return b as Record<string, unknown>;
  };
  const p = (c: Context, name: string) => c.req.param(name) ?? '';

  /**
   * An oversized body is refused before it is read. The connection is then
   * closed (`Connection: close`): the client may still be sending the rest of
   * the body, and a connection left open in that state was later dropped in
   * the middle of an unrelated request (found by the staging suite; behind a
   * platform proxy that reuses upstream connections it would surface as a 502).
   */
  const limitBody =
    (max: number): MiddlewareHandler<Env> =>
    (c, next) =>
      bodyLimit({
        maxSize: max,
        onError: (ctx) => {
          ctx.header('Connection', 'close');
          return fail('PAYLOAD_TOO_LARGE');
        },
      })(c, next);

  const authed: MiddlewareHandler<Env> = async (c, next) => {
    c.set('accountId', await services.auth.authenticate(c.req.header('authorization')));
    await next();
  };

  const internal =
    (policy: EndpointPolicy): MiddlewareHandler<Env> =>
    async (c, next) => {
      // Optional network restriction in front of the signature (INTERNAL_ALLOWED_CIDRS) — never instead of it.
      if (config.internalAllowedCidrs.length && !ipInCidrs(ip(c), config.internalAllowedCidrs)) {
        log.warn('internal.auth_refused', { route: c.req.routePath, reason: 'NETWORK', keyId: c.req.header(INTERNAL_HEADERS.keyId) ?? null });
        return fail('UNAUTHENTICATED');
      }
      // A member/applicant bearer token is never an internal credential.
      const rawBody = await c.req.text();
      c.set('rawBody', rawBody);
      const url = new URL(c.req.url);
      const verdict = verifyInternalRequest(
        config.internalKeys,
        { method: c.req.method, pathAndQuery: `${url.pathname}${url.search}`, body: rawBody, header: (n) => c.req.header(n) },
        policy.scope!,
        services.clock(),
        config.appEnv,
      );
      if (!verdict.ok) {
        log.warn('internal.auth_refused', { route: c.req.routePath, reason: verdict.reason, keyId: c.req.header(INTERNAL_HEADERS.keyId) ?? null });
        return fail('UNAUTHENTICATED');
      }
      const fresh = await pool.query(
        'INSERT INTO app.internal_nonces (key_id, nonce, seen_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [verdict.principal.keyId, verdict.nonce, services.clock().toISOString()],
      );
      if ((fresh.rowCount ?? 0) === 0) {
        log.warn('internal.auth_refused', { route: c.req.routePath, reason: 'REPLAY', keyId: verdict.principal.keyId });
        return fail('UNAUTHENTICATED');
      }
      c.set('principal', verdict.principal.keyId);
      log.info('internal.call', { route: c.req.routePath, keyId: verdict.principal.keyId });
      await next();
    };

  // --- Handlers (one per registered endpoint) ----------------------------------------------------------
  const a = services.admission;
  const m = services.member;
  const local = services.store.driver === 'local' ? (services.store as LocalObjectStore) : null;

  const handlers: Record<EndpointId, Handler> = {
    health: (c) => c.json({ ok: true }),
    'health.live': (c) => c.json({ status: 'ok' }),
    'health.ready': async (c) => {
      const database = await pool
        .query('SELECT 1')
        .then(() => 'ok' as const)
        .catch(() => 'fail' as const);
      // 'ahead': the database already carries migrations of a NEWER release (applied by its release step
      // while this instance still serves). Migrations are expand-first, so a running instance stays ready;
      // a fresh start of this older build is still refused (main.ts). Pending or edited migrations: not ready.
      const migrations =
        database === 'ok'
          ? await migrationStatus(pool)
              .then((s) => (s.pending.length || s.changed.length ? ('mismatch' as const) : s.unknown.length ? ('ahead' as const) : ('ok' as const)))
              .catch(() => 'fail' as const)
          : ('fail' as const);
      const storage = await services.store
        .ping()
        .then((ok) => (ok ? ('ok' as const) : ('fail' as const)))
        .catch(() => 'fail' as const);
      const ready = database === 'ok' && (migrations === 'ok' || migrations === 'ahead') && storage === 'ok';
      return c.json({ status: ready ? 'ready' : 'not_ready', checks: { database, migrations, storage } }, ready ? 200 : 503);
    },

    'auth.requestOtp': async (c) => c.json(await services.auth.requestOtp(((await json(c)) as { phoneE164?: unknown } | undefined)?.phoneE164, ip(c))),
    'auth.verifyOtp': async (c) => {
      const b = (await json(c)) as { challengeId?: unknown; code?: unknown } | undefined;
      return c.json(await services.auth.verifyOtp(b?.challengeId, b?.code, ip(c)));
    },
    'auth.signOut': async (c) => {
      await services.auth.signOut(c.req.header('authorization'));
      return c.json({ signedOut: true });
    },
    'auth.signOutEverywhere': async (c) => c.json(await services.auth.signOutEverywhere(c.var.accountId)),
    'auth.rotateSession': async (c) => c.json(await services.auth.rotate(c.req.header('authorization'))),
    'account.requestDeletion': async (c) => c.json(await services.account.requestDeletion(c.var.accountId, await json(c))),

    'media.createUpload': async (c) => c.json(await services.uploads.authorizeUpload(c.var.accountId, await json(c))),
    'media.completeUpload': async (c) => {
      const done = await services.uploads.completeUpload(c.var.accountId, p(c, 'id'));
      const body: CompletedUpload = {
        ...done,
        applicationMedia: done.mediaClass === 'PROFILE_MEDIA' ? null : await a.ownMedia(c.var.accountId, done.mediaId),
        member: done.mediaClass === 'PROFILE_MEDIA' ? await m.getMe(c.var.accountId) : null,
      };
      return c.json(body);
    },
    'storage.upload': async (c) => {
      const q = c.req.query();
      const v = local?.verifyUpload({ b: q.b ?? '', k: q.k ?? '', ct: q.ct, n: q.n, exp: q.exp ?? '', sig: q.sig ?? '' });
      if (!local || !v) return fail('NOT_FOUND');
      // Only while the upload is open: a valid url cannot re-create an object after completion.
      const open = await pool.query(`SELECT 1 FROM app.media_uploads WHERE incoming_key = $1 AND status = 'PENDING'`, [v.key]);
      if (!open.rowCount) return fail('NOT_FOUND');
      if ((c.req.header('content-type') ?? '').split(';')[0]!.trim() !== v.contentType) return fail('VALIDATION_FAILED', { fields: ['contentType'] });
      const bytes = Buffer.from(await c.req.arrayBuffer());
      if (bytes.length > MAX_PHOTO_BYTES || bytes.length > v.bytes) {
        c.header('Connection', 'close');
        return fail('PAYLOAD_TOO_LARGE');
      }
      if (bytes.length !== v.bytes) return fail('VALIDATION_FAILED', { fields: ['contentLength'] });
      local.write(v.bucket, v.key, bytes);
      return c.json({ stored: true });
    },
    'storage.object': (c) => {
      const q = c.req.query();
      const v = local?.verifyDownload({ b: q.b ?? '', k: q.k ?? '', exp: q.exp ?? '', sig: q.sig ?? '' });
      const bytes = v && local ? local.read(v.bucket, v.key) : null;
      if (!bytes) return fail('NOT_FOUND');
      c.header('Content-Type', 'image/jpeg');
      // Never cacheable for longer than the url itself lives.
      const left = Math.max(0, Number(q.exp) - Math.floor(services.clock().getTime() / 1000));
      c.header('Cache-Control', `private, max-age=${Math.min(300, left)}`);
      c.header('Content-Disposition', 'inline');
      return c.body(new Uint8Array(bytes));
    },

    'admission.mine': async (c) => c.json(await a.mine(c.var.accountId)),
    'admission.submitStage1': async (c) => c.json(await a.submitStage1(c.var.accountId, idem(c), await json(c))),
    'admission.startExtended': async (c) => c.json(await a.startExtendedApplication(c.var.accountId)),
    'admission.submitStage2': async (c) => c.json(await a.submitStage2(c.var.accountId, idem(c), await json(c))),
    'admission.respondToRequest': async (c) => c.json(await a.respondToInformationRequest(c.var.accountId, p(c, 'id'), await json(c))),
    'admission.submitInformationUpdate': async (c) => c.json(await a.submitInformationUpdate(c.var.accountId, idem(c))),
    'admission.beginMembership': async (c) => c.json(await a.beginMembership(c.var.accountId)),
    'admission.membershipPlans': async (c) => c.json(await a.getMembershipPlans(c.var.accountId)),

    'member.me': async (c) => c.json(await m.getMe(c.var.accountId)),
    'member.confirmProfile': async (c) => c.json(await m.confirmProfile(c.var.accountId)),
    'member.updateProfile': async (c) => c.json(await m.updateProfile(c.var.accountId, await json(c))),
    'member.datingSettings': async (c) => c.json(await m.getDatingSettings(c.var.accountId)),
    'member.saveDatingSettings': async (c) => c.json(await m.saveDatingSettings(c.var.accountId, await json(c))),
    'member.blocked': async (c) => c.json(await m.listBlocked(c.var.accountId)),
    'member.introductionsToday': async (c) => c.json(await m.getIntroductions(c.var.accountId)),
    'member.react': async (c) => c.json(await m.react(c.var.accountId, p(c, 'id'), ((await json(c)) as { type?: unknown } | undefined)?.type)),
    'member.member': async (c) => c.json(await m.getMemberProfile(c.var.accountId, p(c, 'id'))),
    'member.block': async (c) => c.json(await m.blockMember(c.var.accountId, p(c, 'id'))),
    'member.report': async (c) => c.json(await m.reportMember(c.var.accountId, p(c, 'id'), await json(c))),
    'member.match': async (c) => c.json(await m.getMatch(c.var.accountId, p(c, 'id'))),
    'member.openConversation': async (c) => c.json(await m.openConversation(c.var.accountId, p(c, 'id'))),
    'member.conversations': async (c) => c.json(await m.listConversations(c.var.accountId)),
    'member.sendMessage': async (c) => c.json(await m.sendMessage(c.var.accountId, p(c, 'id'), await json(c))),

    'internal.reviewQueue': async (c) => c.json(await services.reviewDesk.queue(c.req.query())),
    'internal.reviewApplication': async (c) => c.json(await services.reviewDesk.detail(p(c, 'id'), c.req.query(), c.var.principal)),
    'internal.invitedMembership': async (c) => c.json(await services.reviewDesk.startInvitedMembership(p(c, 'id'), await json(c))),
    'internal.reviewerAction': async (c) => c.json(await services.internal.reviewerAction(p(c, 'id'), await json(c))),
    'internal.reviewerMedia': async (c) =>
      c.json(await services.internal.reviewerMedia(p(c, 'id'), p(c, 'mediaId'), await json(c), c.var.principal)),
    'internal.paymentConfirmed': async (c) => c.json(await services.internal.paymentConfirmed(await json(c))),
    'internal.membershipExpired': async (c) => c.json(await services.internal.membershipExpired(await json(c))),
    'internal.suspend': async (c) => c.json(await services.account.suspend(p(c, 'id'), await json(c), c.var.principal)),
    'internal.reinstate': async (c) => c.json(await services.account.reinstate(p(c, 'id'), await json(c), c.var.principal)),
    'internal.placeHold': async (c) => c.json(await services.account.placeHold(p(c, 'id'), await json(c), c.var.principal)),
    'internal.releaseHold': async (c) => c.json(await services.account.releaseHold(p(c, 'id'), await json(c), c.var.principal)),
    'internal.retentionRun': async (c) => {
      // Strict: a misspelt flag must never turn a dry run into a real one.
      const b = strictBody(await json(c), ['dryRun']);
      if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return fail('VALIDATION_FAILED', { fields: ['dryRun'] });
      return c.json(await services.retention.run({ dryRun: b.dryRun === true }));
    },
    'internal.mediaReconcile': async (c) => {
      const b = strictBody(await json(c), ['mode']);
      const mode = b.mode ?? 'dry-run';
      if (mode !== 'dry-run' && mode !== 'repair') return fail('VALIDATION_FAILED', { fields: ['mode'] });
      return c.json(await services.reconcile.run({ mode }));
    },
    'internal.testClientAddress': async (c) => {
      // Staging diagnostics: which address the API resolves for this caller (TRUST_PROXY_HOPS check).
      const address = ip(c);
      return c.json({ address, privateRange: ipInCidrs(address, PRIVATE_RANGES), hops: config.trustProxyHops });
    },
    'internal.testReview': async (c) => c.json(await services.stagingFixture.review(p(c, 'id'), await json(c), c.var.principal)),
    'internal.testLookup': async (c) => c.json(await services.stagingFixture.lookup(await json(c))),
    'internal.testOtp': async (c) => {
      const phone = ((await json(c)) as { phoneE164?: unknown } | undefined)?.phoneE164;
      if (typeof phone !== 'string' || !E164.test(phone)) return fail('VALIDATION_FAILED', { fields: ['phoneE164'] });
      if (!isTestNumber(config.sms.testNumbers, phone)) return fail('NOT_FOUND');
      const { rows } = await pool.query<{ code: string }>(
        'DELETE FROM app.sms_test_outbox WHERE phone_e164 = $1 AND expires_at > $2 RETURNING code',
        [phone, services.clock().toISOString()],
      );
      return rows[0] ? c.json({ code: rows[0].code }) : fail('NOT_FOUND');
    },
  };

  // --- Registration, from the policy registry ------------------------------------------------------------
  for (const [id, policy] of Object.entries(ENDPOINTS) as [EndpointId, EndpointPolicy][]) {
    if (policy.when === 'local-storage' && !local) continue;
    if (policy.when === 'not-production' && config.appEnv === 'production') continue;
    const chain: MiddlewareHandler<Env>[] = [limitBody(policy.bodyLimit ?? JSON_LIMIT)];
    if (policy.auth === 'session') chain.push(authed);
    if (policy.auth === 'internal') {
      if (!policy.scope) throw new Error(`Internal endpoint ${id} has no scope`);
      chain.push(internal(policy));
    }
    const handler = handlers[id];
    app.on([policy.method], [policy.path], ...chain, (c: Context<Env>) => handler(c));
  }
  return app;
}

/** Ids of endpoints actually served under this configuration (for tests and docs). */
export function servedEndpoints(services: Pick<Services, 'config' | 'store'>): EndpointId[] {
  return (Object.entries(ENDPOINTS) as [EndpointId, EndpointPolicy][])
    .filter(([, p]) => !(p.when === 'local-storage' && services.store.driver !== 'local'))
    .filter(([, p]) => !(p.when === 'not-production' && services.config.appEnv === 'production'))
    .map(([id]) => id);
}
