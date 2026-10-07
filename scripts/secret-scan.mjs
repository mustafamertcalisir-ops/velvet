// Secret scan (docs/STAGING.md §10): the working tree AND the whole git history.
// No secret may live in the repository, Expo source, .env files, E2E fixtures,
// screenshots' text, logs or documentation (DEC-079).
//
//   node scripts/secret-scan.mjs            scan tracked files + every commit's patch
//   node scripts/secret-scan.mjs --tree     tracked files only
//
// Exit 1 on any finding; findings are printed masked.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const RULES = [
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['AWS secret access key assignment', /aws_?secret_?access_?key\s*[:=]\s*["']?[A-Za-z0-9/+]{40}\b/i],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Render deploy hook', /api\.render\.com\/deploy\/srv-[a-z0-9]+\?key=[A-Za-z0-9_-]{8,}/],
  ['Render API key', /\brnd_[A-Za-z0-9]{20,}\b/],
  ['connection string with a password', /\b(postgres|postgresql|mysql|redis|amqp):\/\/[^\s:@/"'`]+:(?!(\$\{|<|\*{3}|x+@|password@|pw@|probe@|secret@|\$))[^\s@/"'`]{6,}@(?!127\.0\.0\.1|localhost|db[:/]|host[:/])/i],
  ['secret-looking assignment', /\b(OTP_SECRET|MEDIA_SIGNING_SECRET|NETGSM_PASSWORD|S3_SECRET_ACCESS_KEY|RENDER_API_KEY|STAGING_KEY_SECRET)\s*=\s*["']?(?!\$|<|\.\.\.|…|"\s*$)[A-Za-z0-9/+_=-]{16,}/],
  ['Slack/Twilio-style token', /\b(xox[baprs]-[A-Za-z0-9-]{10,}|SK[0-9a-f]{32})\b/],
];
const SKIP = /(^|\/)(node_modules|dist|dist-prod|dist-native|\.expo)\/|package-lock\.json$|\.(png|jpg|jpeg|webp|gif|ico|ttf|otf|woff2?)$|^scripts\/secret-scan\.mjs$|^server\/test\/logscan\.test\.ts$/;
const mask = (s) => `${s.slice(0, 4)}…(${s.length})`;
const findings = [];

function scan(text, where) {
  text.split('\n').forEach((line, i) => {
    for (const [rule, re] of RULES) {
      const m = re.exec(line);
      if (m) findings.push(`${where}:${i + 1} ${rule} [${mask(m[0])}]`);
    }
  });
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const files = git('ls-files').split('\n').filter((f) => f && !SKIP.test(f));
for (const f of files) {
  try {
    scan(execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), f);
  } catch {
    /* not in HEAD yet (staged/new) — scanned from the working tree below */
  }
}
// Untracked-but-not-ignored and modified files: the working tree as it will be committed.
const working = git('ls-files', '--modified', '--others', '--exclude-standard')
  .split('\n')
  .filter((x) => x && !SKIP.test(x) && existsSync(x) && statSync(x).isFile());
for (const f of working) scan(readFileSync(f, 'utf8'), `${f} (working tree)`);
let commits = 0;
if (!process.argv.includes('--tree')) {
  const revs = git('rev-list', '--all').split('\n').filter(Boolean);
  commits = revs.length;
  for (const rev of revs) {
    const patch = git('show', '--format=', '--no-color', '--unified=0', rev, '--', '.', ':(exclude)package-lock.json', ':(exclude)**/package-lock.json', ':(exclude)*.png', ':(exclude)*.jpg');
    scan(patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n'), `commit ${rev.slice(0, 8)}`);
  }
}
if (findings.length) {
  console.error(`Secret scan: ${findings.length} finding(s):\n- ${[...new Set(findings)].slice(0, 100).join('\n- ')}`);
  process.exit(1);
}
console.log(`Secret scan: ${files.length} committed + ${working.length} working-tree files${commits ? `, ${commits} commit(s) of history` : ''} — no secrets found.`);
