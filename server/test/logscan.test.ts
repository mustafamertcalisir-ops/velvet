/**
 * The log review tool (scripts/log-scan.ts) must catch what logs may never
 * contain — and pass the API's ordinary structured lines.
 */
import { describe, expect, it } from 'vitest';
import { scanLog } from '../scripts/log-scan';
import { memoryLogger } from '../src/lib/log';

describe('log scan', () => {
  it('flags canaries and secret shapes; masks what it found', () => {
    const lines = [
      '{"event":"otp.sent","providerRef":"17377215342605050417149344"}',
      '{"event":"debug","note":"code 482913 for you"}',
      '{"event":"x","to":"+905321234567"}',
      '{"event":"x","url":"https://b.s3.amazonaws.com/k?X-Amz-Signature=abc"}',
      'connecting to postgres://velvet_api:hunter2hunter2@db:5432/velvet',
      '{"token":"ses_live_value_here"}',
      '{"event":"x","dob":"1994-03-14"}',
    ].join('\n');
    const findings = scanLog(lines, { codes: ['482913'], dobs: ['1994-03-14'] });
    const rules = findings.map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'canary: codes',
        'full E.164 phone number',
        'signed S3 URL',
        'credentials in a connection string',
        'unredacted secret-like field',
        'canary: dobs',
      ]),
    );
    expect(findings.some((f) => f.line === 1)).toBe(false); // a provider job id is not a phone number
    expect(JSON.stringify(findings)).not.toContain('482913');
    expect(JSON.stringify(findings)).not.toContain('hunter2hunter2');
    // Several secrets on one line, and a value repeated: every occurrence is masked in every excerpt.
    const multi = scanLog('{"token":"ses_aaaaaaaa","x":"+905321234567 and +905329876543","again":"+905321234567"}', {});
    expect(JSON.stringify(multi)).not.toMatch(/ses_aaaaaaaa|5321234567|5329876543/);
  });

  it('without any canary, a six-digit number on an authentication line is flagged (the real-SMS check writes no codes anywhere)', () => {
    const findings = scanLog(
      [
        '{"event":"otp.verify_failed","detail":"expected 731904"}',
        '{"event":"http.request","path":"/v1/auth/otp/verify","status":422,"ms":12}',
        '{"event":"otp.sent","provider":"netgsm","providerRef":"17377215342605050417149344"}',
        '{"event":"member.react","ms":123456}',
        '{"event":"request","method":"POST","route":"/v1/auth/otp/verify","status":200,"durationMs":41,"requestId":"req_ab-123456-cd"}',
      ].join('\n'),
    );
    expect(findings.map((f) => [f.line, f.rule])).toEqual([[1, 'six-digit number on an authentication line (a one-time code?)']]);
    expect(JSON.stringify(findings)).not.toContain('731904');
  });

  it('the API logger’s own output passes: redaction happens before the line is written', () => {
    const { logger, lines } = memoryLogger('debug');
    logger.info('otp.sent', { phoneE164: '+905321234567', code: '482913', token: 'ses_x', providerRef: '17377215342605050417149344' });
    logger.warn('sms.send_failed', { provider: 'netgsm', failure: 'PROVIDER_UNAVAILABLE', detail: 'netgsm 30' });
    logger.error('db.unavailable', { message: 'failed for +90 532 123 45 67' });
    expect(scanLog(lines.join('\n'), { codes: ['482913'], phones: ['+905321234567'], tokens: ['ses_x'] })).toEqual([]);
  });
});
