/**
 * Log review (docs/STAGING.md §9): scans an exported API log for anything the
 * logs must never contain — the OTP codes, session tokens, full phone numbers
 * and birth dates the staging tools actually used (their canary file), plus
 * generic shapes: signed storage URLs, credentials in connection strings,
 * unredacted secret-like fields, bearer tokens and full E.164 numbers.
 *
 *   node dist/log-scan.mjs <api.log> [--canaries <file>]…   (repeatable: one canary file per tool run)
 *
 * Exit 1 on any finding. Findings are printed with the matched value masked:
 * the scan never re-publishes what it found.
 */
import { existsSync, readFileSync } from 'node:fs';

type Canaries = Partial<Record<'phones' | 'codes' | 'tokens' | 'dobs' | 'texts' | 'signatures', string[]>>;

export type Finding = { rule: string; line: number; excerpt: string };

const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'full E.164 phone number', re: /\+\d{11,15}\b/ },
  { rule: 'bearer token', re: /Bearer\s+[A-Za-z0-9._~-]{16,}/i },
  { rule: 'signed S3 URL', re: /X-Amz-(Signature|Credential|Security-Token)=/i },
  { rule: 'signed local URL', re: /[?&]sig=[A-Za-z0-9_-]{16,}/ },
  { rule: 'credentials in a connection string', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"]+:[^\s@/"]+@/i },
  { rule: 'unredacted secret-like field', re: /"(password|secret|token|code|otp|authorization|signature|apiKey|api_key)"\s*:\s*"(?!\[redacted\])[^"]{4,}"/i },
  { rule: 'private key material', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
];

/**
 * Without canaries (e.g. the operator's real-SMS check, whose codes are never written anywhere): a
 * one-time code would appear as a standalone six-digit number on an authentication line. Long provider
 * references (16+ digits) and dotted numbers are not codes.
 */
const AUTH_LINE = /"event":"(otp|auth)\.|\/v1\/auth\/otp/;
const SIX_DIGITS = /(?<![\w.-])\d{6}(?![\w.-])/g;
/** Opaque ids (request ids, account ids, provider references) may contain digit runs: not codes. */
const ID_FIELDS = /"(\w*Id|id|providerRef)":"[^"]*"/g;

const mask = (s: string) => (s.length <= 4 ? '••••' : `${s.slice(0, 2)}…${s.slice(-2)} (${s.length} chars)`);

export function scanLog(text: string, canaries: Canaries = {}): Finding[] {
  const findings: Finding[] = [];
  const values: { rule: string; value: string }[] = [];
  for (const [kind, list] of Object.entries(canaries)) {
    for (const v of list ?? []) {
      if (typeof v !== 'string' || v.length < 4) continue;
      values.push({ rule: `canary: ${kind}`, value: v });
      // A phone number written without its +.
      if (kind === 'phones') values.push({ rule: 'canary: phones', value: v.replace(/^\+/, '') });
    }
  }
  text.split('\n').forEach((line, i) => {
    const hits: string[] = [];
    let masked = line;
    for (const { rule, re } of RULES) {
      const all = [...line.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))].map((m) => m[0]);
      if (all.length) hits.push(rule);
      for (const m of all) masked = masked.split(m).join(`[${mask(m)}]`);
    }
    if (AUTH_LINE.test(line)) {
      const codes = [...line.replace(ID_FIELDS, '').matchAll(SIX_DIGITS)].map((m) => m[0]);
      if (codes.length) hits.push('six-digit number on an authentication line (a one-time code?)');
      for (const m of codes) masked = masked.split(m).join(`[${mask(m)}]`);
    }
    for (const { rule, value } of values) {
      if (!line.includes(value)) continue;
      hits.push(rule);
      masked = masked.split(value).join(`[${mask(value)}]`);
    }
    // Every finding on a line shares one excerpt in which EVERY match is masked: nothing is re-published.
    for (const rule of new Set(hits)) findings.push({ rule, line: i + 1, excerpt: masked.slice(0, 160) });
  });
  return findings;
}

function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) throw new Error('Usage: log-scan <api.log> [--canaries <file>]');
  const canaries: Canaries = {};
  process.argv.forEach((a, i) => {
    const f = a === '--canaries' ? process.argv[i + 1] : undefined;
    if (!f || !existsSync(f)) return;
    for (const [kind, list] of Object.entries(JSON.parse(readFileSync(f, 'utf8')) as Canaries)) {
      const k = kind as keyof Canaries;
      canaries[k] = [...(canaries[k] ?? []), ...(list ?? [])];
    }
  });
  const findings = scanLog(readFileSync(file, 'utf8'), canaries);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  const canaryCount = Object.values(canaries).reduce((n, l) => n + (l?.length ?? 0), 0);
  if (!findings.length) {
    console.log(`log-scan: ${lines} lines, ${canaryCount} canary values — no findings.`);
    return;
  }
  for (const f of findings.slice(0, 50)) console.log(`✗ line ${f.line}: ${f.rule} — ${f.excerpt}`);
  console.log(`log-scan: ${findings.length} findings in ${lines} lines.`);
  process.exitCode = 1;
}

if (process.argv[1] && /log-scan\.(mjs|ts)$/.test(process.argv[1])) main();
