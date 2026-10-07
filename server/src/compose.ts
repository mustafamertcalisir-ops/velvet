/**
 * Provider selection from configuration — no side effects, shared by the
 * entry point (main.ts), the smoke tooling and tests.
 */
import type pg from 'pg';
import { consoleSms, iletimerkeziSms, netgsmSms, outboxFileSms, routeSms, unconfiguredSms, withTestNumbers, type SmsProvider } from './auth/sms';
import type { Config } from './config';
import { systemClock, type Clock } from './lib/clock';
import { localObjectStore, s3ObjectStore, type ObjectStore } from './media/objectStore';

/** How long a code in the staging test outbox stays readable (the code itself expires at the same time). */
export const TEST_OUTBOX_TTL_MS = 10 * 60 * 1000;

/**
 * The SMS provider for this configuration. Netgsm serves Türkiye (+90) only;
 * other countries have no route yet and fail closed (docs/SMS_PROVIDER.md).
 */
export function smsFor(config: Config, pool: pg.Pool, clock: Clock = systemClock): SmsProvider {
  let provider: SmsProvider;
  switch (config.sms.provider) {
    case 'console':
      provider = consoleSms(config.sms.template);
      break;
    case 'outbox-file':
      provider = outboxFileSms(config.sms.outboxFile!);
      break;
    case 'netgsm':
      provider = routeSms({ '+90': netgsmSms({ ...config.sms.netgsm!, template: config.sms.template }) });
      break;
    case 'iletimerkezi':
      provider = routeSms({ '+90': iletimerkeziSms({ ...config.sms.iletimerkezi!, template: config.sms.template }) });
      break;
    default:
      // 'capture' exists only inside the test harness; 'none' refuses to send (fail closed).
      provider = unconfiguredSms();
  }
  // Staging/test only (refused in production by loadConfig): designated test numbers go to the internal outbox.
  return config.sms.testNumbers.length
    ? withTestNumbers(provider, { numbers: config.sms.testNumbers, db: pool, clock, ttlMs: TEST_OUTBOX_TTL_MS })
    : provider;
}

export function storeFor(config: Config, clock: Clock = systemClock): ObjectStore {
  return config.storage.driver === 's3'
    ? s3ObjectStore(config.storage)
    : localObjectStore({ dir: config.storage.dir, baseUrl: config.publicBaseUrl, secret: config.mediaSigningSecret, clock });
}
