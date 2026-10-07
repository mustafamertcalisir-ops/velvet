/**
 * Composition root: one set of services over one pool, clock, logger, SMS
 * provider and object store.
 */
import type pg from 'pg';
import type { IntroductionPolicy } from '@/domain/member/introductions';
import { createAccountService } from './account/service';
import { createAdmissionService } from './admission/service';
import { createInternalService } from './admission/internal';
import { createReviewDesk } from './admission/reviewDesk';
import { createAuthService } from './auth/service';
import type { SmsProvider } from './auth/sms';
import type { Config } from './config';
import type { Clock } from './lib/clock';
import type { Logger } from './lib/log';
import type { ObjectStore } from './media/objectStore';
import { createMediaDelivery, createMediaUploads } from './media/pipeline';
import { createMediaReconciler } from './media/reconcile';
import { createStagingFixture } from './admission/stagingFixture';
import { createMemberService } from './member/service';
import { createRateLimiter, type RateLimiter } from './ratelimit';
import { createRetentionProcessor } from './retention/processor';

export type ServiceDeps = {
  pool: pg.Pool;
  config: Config;
  clock: Clock;
  log: Logger;
  sms: SmsProvider;
  store: ObjectStore;
  limiter?: RateLimiter;
  policy?: IntroductionPolicy;
};

export function createServices(deps: ServiceDeps) {
  const { pool, config, clock, sms, store, log } = deps;
  const limiter = deps.limiter ?? createRateLimiter(pool, clock);
  const delivery = createMediaDelivery(store);
  const uploads = createMediaUploads({ pool, clock, store, limiter, log });
  const internal = createInternalService({ pool, clock, config, store });
  return {
    pool,
    config,
    clock,
    log,
    store,
    limiter,
    uploads,
    auth: createAuthService({ pool, clock, config, sms, limiter, log }),
    account: createAccountService({ pool, clock, limiter, log }),
    admission: createAdmissionService({ pool, clock, config, delivery, limiter }),
    member: createMemberService({ pool, clock, config, store, delivery, limiter, policy: deps.policy }),
    internal,
    /** The membership team's read view and invited membership start (DEC-087, DEC-088). */
    reviewDesk: createReviewDesk({ pool, clock, config, store }),
    retention: createRetentionProcessor({ pool, clock, config, store, uploads, log }),
    reconcile: createMediaReconciler({ pool, store, clock, log }),
    /** Staging/test only (the route is absent in production and its scope refused there). */
    stagingFixture: createStagingFixture({ pool, internal }),
  };
}

export type Services = ReturnType<typeof createServices>;
