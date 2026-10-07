/**
 * Velvet review desk — the membership team's tool on the owner's OWN computer
 * (DEC-087, DEC-088; docs/STAGING.md §7.1). One file, plain Node 22, no
 * packages: `node velvet-review.mjs`.
 *
 * It reads applications through the internal review API (signed requests with
 * the `reviewer` key), opens photos as short-lived signed links in the
 * browser, records decisions through the one reviewer path, and starts
 * invited (complimentary) memberships. Personal data is shown on this screen
 * only: nothing is written to disk except the settings file (API address,
 * key, reviewer name — mode 0600) and the ids of the last list (no personal
 * data). Every detail open and every photo open is logged on the server.
 *
 *   node velvet-review.mjs                 interactive: the queue → an application → a decision
 *   node velvet-review.mjs kur             first-time setup (API address, your name, the key — typed hidden)
 *   node velvet-review.mjs liste [--hepsi] [--qa]
 *   node velvet-review.mjs goster <no|id>
 *   node velvet-review.mjs foto <no|id> [--kimlik] [--baglanti]
 *   node velvet-review.mjs karar <no|id> <EYLEM> [--neden KOD] [--istek PRESET[:fotoNo]]… [--hedef UNDER_REVIEW|FINAL_REVIEW] --evet
 *   node velvet-review.mjs uyelik <no|id> --evet
 *
 * Environment overrides (for the local rehearsal; the owner uses `kur`):
 *   VELVET_REVIEW_API_URL, VELVET_REVIEW_KEY_ID, VELVET_REVIEW_KEY_SECRET,
 *   VELVET_REVIEW_ID, VELVET_REVIEW_CONFIG (settings file path)
 *
 * Safety rails: the API must be https with "staging" in its host name (or
 * plain http on a loopback address, for the rehearsal); requests are signed
 * for the staging environment, so a production API refuses them; a decision
 * is never taken without showing whose application it is and asking.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { INTERNAL_DECISION_REASONS, type InternalDecisionReason } from '@/domain/admission/audit';
import { INFORMATION_REQUEST_PRESETS, MAX_REQUESTS_PER_ROUND, type InformationRequestDraft, type InformationRequestPreset } from '@/domain/admission/informationRequests';
import type { ReviewerAction, ReviewerActionKind } from '@/domain/admission/review';
import type { ReviewDetail, ReviewQueueItem } from '../src/admission/reviewDesk';
import { signInternalRequest } from '../src/http/internalAuth';

// --- Settings --------------------------------------------------------------------------------------

export type ToolConfig = { api: string; keyId: string; secret: string; reviewerId: string; env: string };
const REVIEWER_ID = /^[A-Za-z0-9_.@-]{2,80}$/;
const configPath = (env: NodeJS.ProcessEnv = process.env) => env.VELVET_REVIEW_CONFIG ?? join(homedir(), '.velvet-review.json');
const listPath = (env: NodeJS.ProcessEnv = process.env) => `${configPath(env)}.list`;

export class ToolError extends Error {}

export function checkApi(api: string): string | null {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return 'API adresi geçerli bir adres değil (örnek: https://velvet-api-staging.onrender.com).';
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'API adresi https ile başlamalı.';
  if (!loopback && !/staging/i.test(url.hostname)) return 'Bu araç yalnızca staging API ile çalışır (adreste "staging" geçmeli).';
  if (url.pathname !== '/' || url.search) return 'Yalnızca sunucu adresini yaz (sonunda yol olmadan).';
  return null;
}

/** Only web links are ever opened: https, or http on a loopback address (the local rehearsal). */
export function safeLink(link: string): boolean {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): { config: ToolConfig | null; problems: string[] } {
  let file: Partial<ToolConfig> = {};
  if (existsSync(configPath(env))) {
    try {
      file = JSON.parse(readFileSync(configPath(env), 'utf8')) as Partial<ToolConfig>;
    } catch {
      return { config: null, problems: [`Ayar dosyası okunamadı: ${configPath(env)} — "kur" ile yeniden oluştur.`] };
    }
  }
  const c: ToolConfig = {
    api: (env.VELVET_REVIEW_API_URL ?? file.api ?? '').replace(/\/+$/, ''),
    keyId: env.VELVET_REVIEW_KEY_ID ?? file.keyId ?? 'reviewer',
    secret: env.VELVET_REVIEW_KEY_SECRET ?? file.secret ?? '',
    reviewerId: env.VELVET_REVIEW_ID ?? file.reviewerId ?? '',
    env: 'staging',
  };
  if (!c.api && !c.secret) return { config: null, problems: ['Henüz kurulum yapılmamış: önce "kur" komutunu çalıştır.'] };
  const problems: string[] = [];
  const apiProblem = checkApi(c.api);
  if (apiProblem) problems.push(apiProblem);
  if (c.secret.length < 32) problems.push('Anahtar eksik ya da çok kısa: "kur" ile yeniden gir.');
  if (!REVIEWER_ID.test(c.reviewerId)) problems.push('İnceleyen adı eksik (harf, rakam, . _ - @; 2–80 karakter): "kur" ile gir.');
  return { config: problems.length ? null : c, problems };
}

/** Writes a private file atomically: a fresh 0600 file renamed over the old one (never a moment with looser permissions). */
function writePrivate(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function saveToolConfig(c: Omit<ToolConfig, 'env'>, env: NodeJS.ProcessEnv = process.env) {
  const path = configPath(env);
  writePrivate(path, `${JSON.stringify(c, null, 2)}\n`);
  return path;
}

// --- The API ---------------------------------------------------------------------------------------

type Res<T> = { status: number; body: T; requestId: string | null };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function reviewClient(c: ToolConfig, fetchImpl: Fetch = fetch, now: () => Date = () => new Date()) {
  const base = '/internal/reviewer/applications';
  async function call<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<Res<T>> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...signInternalRequest({ env: c.env, keyId: c.keyId, secret: c.secret, method, pathAndQuery, body: raw, now: now() }),
    };
    if (raw) headers['content-type'] = 'application/json';
    let r: Response;
    try {
      r = await fetchImpl(`${c.api}${pathAndQuery}`, { method, headers, body: raw || undefined });
    } catch {
      throw new ToolError('Sunucuya ulaşılamadı. İnternet bağlantını ve API adresini kontrol et.');
    }
    const text = await r.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, body: parsed as T, requestId: r.headers.get('x-request-id') };
  }
  /** Answers the body, or throws a plain-language error (with the request id, for the logs). */
  async function ok<T>(p: Promise<Res<T>>): Promise<T> {
    const r = await p;
    if (r.status === 200) return r.body;
    const code = (r.body as { error?: { code?: string; fields?: string[] } } | null)?.error;
    const ref = r.requestId ? ` (istek: ${r.requestId})` : '';
    const msg =
      r.status === 401
        ? 'Anahtar kabul edilmedi: anahtar yanlış ya da bu işlem için yetkisi yok, veya bilgisayarının saati 5 dakikadan fazla kaymış. "kur" ile anahtarı yeniden gir.'
        : r.status === 403
          ? 'Bu başvuru şu anki durumunda bu işleme uygun değil (bu arada değişmiş olabilir — listeyi yenile).'
          : r.status === 404
            ? 'Başvuru bulunamadı (silinmiş ya da numara eski bir listeye ait olabilir — listeyi yenile).'
            : r.status === 422
              ? `Sunucu isteği geçersiz buldu${code?.fields?.length ? `: ${code.fields.join(', ')}` : ''}.`
              : 'Sunucu şu an yanıt veremedi; biraz sonra yeniden dene.';
    throw new ToolError(`${msg}${ref}`);
  }
  const app = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    queue: (o: { statuses?: readonly string[]; qa?: boolean; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (o.statuses?.length) q.set('status', o.statuses.join(','));
      if (o.qa) q.set('includeQa', 'true');
      q.set('limit', String(o.limit ?? 200));
      return ok(call<{ applications: ReviewQueueItem[] }>('GET', `${base}?${q}`)).then((b) => b.applications);
    },
    detail: (id: string) => ok(call<ReviewDetail>('GET', `${app(id)}?reviewerId=${encodeURIComponent(c.reviewerId)}`)),
    act: (id: string, action: ReviewerAction) => ok(call<{ status: string }>('POST', `${app(id)}/actions`, { reviewerId: c.reviewerId, action })),
    mediaUrl: (id: string, mediaId: string) =>
      ok(call<{ url: string; expiresInSeconds: number }>('POST', `${app(id)}/media/${encodeURIComponent(mediaId)}/access`, { reviewerId: c.reviewerId, purpose: 'REVIEW' })),
    invite: (id: string) => ok(call<{ status: string }>('POST', `${app(id)}/invited-membership`, { reviewerId: c.reviewerId })),
  };
}
export type ReviewClient = ReturnType<typeof reviewClient>;

// --- Words -----------------------------------------------------------------------------------------

export const STATUS_TR: Record<string, string> = {
  APPLICATION_RECEIVED: 'Başvuru alındı',
  UNDER_REVIEW: 'İnceleniyor',
  EXTENDED_APPLICATION_REQUIRED: 'Ek başvuru istendi',
  EXTENDED_APPLICATION_DRAFT: 'Ek başvuruyu dolduruyor',
  EXTENDED_APPLICATION_SUBMITTED: 'Ek başvuru gönderildi',
  FINAL_REVIEW: 'Son değerlendirme',
  MORE_INFORMATION_REQUIRED: 'Bilgi bekleniyor',
  WAITLISTED: 'Bekleme listesinde',
  APPROVED: 'Onaylandı',
  NOT_ADMITTED: 'Kabul edilmedi',
  MEMBERSHIP_PAYMENT_REQUIRED: 'Onaylandı · üyelik başlamadı',
  ACTIVE_MEMBER: 'Üye',
  SUSPENDED: 'Askıda',
  EXPIRED: 'Üyeliği sona erdi',
};
export const ACTION_TR: Record<ReviewerActionKind, string> = {
  START_REVIEW: 'İncelemeye al',
  REQUEST_EXTENDED: 'Ek başvuru iste (“Seni daha iyi tanımak istiyoruz”)',
  REQUEST_INFORMATION: 'Bilgi iste',
  APPROVE: 'Onayla',
  WAITLIST: 'Bekleme listesine al',
  NOT_ADMIT: 'Kabul etme',
  REOPEN: 'Yeniden değerlendirmeye al',
};
const REASON_TR: Record<InternalDecisionReason, string> = {
  COMMUNITY_FIT: 'Topluluğa uyum',
  TRUST_REVIEW: 'Güven değerlendirmesi',
  APPLICATION_QUALITY: 'Başvurunun niteliği',
  CAPACITY: 'Kapasite',
  SAFETY: 'Güvenlik',
  OTHER: 'Diğer',
};
const PRESET_TR: Record<InformationRequestPreset, string> = {
  PHOTO_NEEDS_UPDATE: 'Bir fotoğrafı yenilesin',
  PHOTO_FACE_NOT_CLEAR: 'Yüzünün net göründüğü bir fotoğraf',
  CONFIRM_IDENTITY: 'Kimlik doğrulama fotoğrafı',
  INSTAGRAM_NOT_FOUND: 'Instagram bulunamadı — düzeltsin',
  WORK_UNCLEAR: 'İşini daha açık anlatsın',
  KNOWN_FOR_MORE: '“Ne yapıyorsun” kısmını genişletsin',
  ABOUT_YOU_MORE: '“Hakkında” kısmını genişletsin',
};
const REFERRAL_TR: Record<string, string> = { requested: 'henüz eşleşmedi', confirmed: 'üye olarak doğrulandı', declined: 'reddetti', expired: 'süresi doldu' };
const REQUEST_STATUS_TR: Record<string, string> = { open: 'bekliyor', answered: 'yanıtlandı', resolved: 'tamam', withdrawn: 'geri çekildi' };

/** The queue groups, in the order the owner works through them. */
const DECIDE = ['APPLICATION_RECEIVED', 'UNDER_REVIEW', 'FINAL_REVIEW', 'WAITLISTED'];
const INVITE = ['APPROVED', 'MEMBERSHIP_PAYMENT_REQUIRED'];
const WAITING = ['EXTENDED_APPLICATION_REQUIRED', 'EXTENDED_APPLICATION_DRAFT', 'EXTENDED_APPLICATION_SUBMITTED', 'MORE_INFORMATION_REQUIRED'];
const DONE = ['ACTIVE_MEMBER', 'NOT_ADMITTED', 'SUSPENDED', 'EXPIRED'];
export const OPEN_STATUSES = [...DECIDE, ...INVITE, ...WAITING];

export function ago(iso: string | null, now: Date): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 2) return 'az önce';
  if (min < 60) return `${min} dk`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} saat`;
  return `${Math.round(h / 24)} gün`;
}
const when = (iso: string) => new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));

export function renderQueue(items: ReviewQueueItem[], now: Date, o: { all?: boolean } = {}): { text: string; order: ReviewQueueItem[] } {
  const groups: [string, string[]][] = [
    ['Karar bekleyenler', DECIDE],
    ['Üyeliği başlatılabilecekler', INVITE],
    ['Başvuranda bekleyenler', WAITING],
    ...(o.all ? ([['Sonuçlananlar', DONE]] as [string, string[]][]) : []),
  ];
  const order: ReviewQueueItem[] = [];
  const lines: string[] = [];
  for (const [title, statuses] of groups) {
    const rows = items.filter((x) => statuses.includes(x.status));
    if (!rows.length) continue;
    lines.push('', title);
    for (const x of rows) {
      order.push(x);
      const who = `${x.firstName}${x.age !== null ? `, ${x.age}` : ''} · ${x.city}${x.qa ? ' [QA]' : ''}`;
      const extra = [ago(x.updatedAt, now), x.photoCount ? `${x.photoCount} foto` : ''].filter(Boolean).join(' · ');
      lines.push(`  ${String(order.length).padStart(2)}  ${pad(who, 30)}${pad(STATUS_TR[x.status] ?? x.status, 30)}${extra}`);
    }
  }
  if (!order.length) lines.push('', o.all ? 'Henüz başvuru yok.' : 'Şu an bekleyen başvuru yok.');
  return { text: lines.join('\n'), order };
}

export function renderDetail(d: ReviewDetail, now: Date): string {
  const a = d.applicant;
  const L: string[] = [];
  const line = '─'.repeat(64);
  L.push(line, `${a.firstName} ${a.lastName}${a.age !== null ? ` · ${a.age}` : ''} (doğum: ${a.dateOfBirth}) · ${a.city}, ${a.countryCode}${d.qa ? '  [QA hesabı]' : ''}`);
  L.push(`Instagram: @${a.instagram}   https://instagram.com/${encodeURIComponent(a.instagram)}`);
  L.push(
    d.referral.referrers.length
      ? `Referans: ${d.referral.referrers.map((r) => `${r.name} (${REFERRAL_TR[r.status] ?? r.status})`).join(', ')}`
      : 'Referans: yok',
  );
  const since = ago(d.timeline.updatedAt, now);
  L.push(
    `Durum: ${STATUS_TR[d.status] ?? d.status} · ${since === 'az önce' ? since : `${since} önce`} değişti · başvuru ${d.timeline.submittedAt ? when(d.timeline.submittedAt) : '—'}`,
  );
  if (d.membership) L.push(`Üyelik: ${d.membership.activation === 'complimentary' ? 'davetli (ücretsiz)' : 'ödemeli'} · ${d.membership.status}`);
  const e = d.extended;
  if (e) {
    L.push('');
    const work = e.workContext?.kind === 'organisation' ? ` · ${e.workContext.name}` : e.workContext?.kind === 'independent' ? ' · bağımsız' : '';
    if (e.occupation) L.push(`Meslek: ${e.occupation}${work}`);
    if (e.whatYouDo) L.push(`Ne yapıyor: ${e.whatYouDo}`);
    if (e.aboutYou) L.push(`Hakkında: ${e.aboutYou}`);
    if (e.interests.length) L.push(`İlgi alanları: ${e.interests.join(', ')}`);
    if (e.intents.length) L.push(`Niyet: ${e.intents.join(', ')}${e.dating ? ` · tanışmak istediği: ${e.dating.meet.join(', ')}, ${e.dating.ageMin}–${e.dating.ageMax}` : ''}`);
    for (const [label, v] of [
      ['Eğitim', e.education],
      ['Web', e.websiteUrl],
      ['Portfolyo', e.portfolioUrl],
    ] as const) {
      if (v) L.push(`${label}: ${v}`);
    }
  } else {
    L.push('', 'Ek başvuru henüz yok.');
  }
  const photos = d.media.filter((m) => m.purpose === 'profile' && m.position !== null);
  const ids = d.media.filter((m) => m.purpose === 'verification');
  L.push('', `Fotoğraflar: ${photos.length}${ids.length ? ` · kimlik doğrulama: ${ids.length}` : ''}${d.media.some((m) => m.retired) ? ' · değiştirilmiş eski fotoğraflar var' : ''}`);
  if (d.informationRequests.length) {
    L.push('Bilgi istekleri:');
    for (const r of d.informationRequests) L.push(`  ${when(r.createdAt)}  ${r.explanation}  — ${REQUEST_STATUS_TR[r.status] ?? r.status}`);
  }
  if (d.reviews.length) {
    L.push('Geçmiş:');
    for (const r of d.reviews) {
      L.push(`  ${when(r.at)}  ${STATUS_TR[r.from] ?? r.from} → ${STATUS_TR[r.to] ?? r.to}  (${r.reviewerId}${r.reasonCode ? `, ${REASON_TR[r.reasonCode as InternalDecisionReason] ?? r.reasonCode}` : ''})`);
    }
  }
  L.push(line);
  return L.join('\n');
}

// --- Terminal --------------------------------------------------------------------------------------

export type IO = {
  print: (s: string) => void;
  ask: (q: string) => Promise<string>;
  askHidden: (q: string) => Promise<string>;
  open: (url: string) => Promise<boolean>;
  now: () => Date;
};

function terminalIO(): IO {
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', () => {
        rl.close();
        process.stdout.write('\n');
        process.exit(130);
      });
      rl.question(q, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
  const askHidden = (q: string) =>
    new Promise<string>((resolve) => {
      const input = process.stdin;
      if (!input.isTTY) {
        // e.g. Git Bash/mintty on Windows: the terminal may echo what is typed.
        process.stdout.write('(Bu terminal gizli girişi desteklemiyor; anahtar ekranda görünebilir. Mümkünse PowerShell, Windows Terminal ya da macOS Terminal kullan.)\n');
        return void ask(q).then(resolve);
      }
      process.stdout.write(q);
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      let value = '';
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            input.setRawMode(false);
            input.pause();
            input.off('data', onData);
            process.stdout.write('\n');
            return resolve(value.trim());
          }
          if (ch === '\u0003') {
            input.setRawMode(false);
            process.stdout.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else value += ch;
        }
      };
      input.on('data', onData);
    });
  const open = (url: string) =>
    new Promise<boolean>((resolve) => {
      const [cmd, args] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : ['xdg-open', [url]];
      try {
        const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
        child.on('error', () => resolve(false));
        child.on('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  return { print: (s) => console.log(s), ask, askHidden, open, now: () => new Date() };
}

const yes = (a: string) => /^(e|evet|y|yes)$/i.test(a.trim());

// --- Commands --------------------------------------------------------------------------------------

type Ctx = { io: IO; client: ReviewClient; env: NodeJS.ProcessEnv };

/** Numbers in commands refer to the last `liste` (written only by that command, never by the interactive mode). */
const LIST_MAX_AGE_MS = 2 * 60 * 60 * 1000;
function rememberList(order: ReviewQueueItem[], env: NodeJS.ProcessEnv, now: Date) {
  // Ids only — never names or anything personal.
  writePrivate(listPath(env), JSON.stringify({ at: now.toISOString(), ids: order.map((x) => x.id) }));
}
function resolveRef(ref: string | undefined, env: NodeJS.ProcessEnv, now: Date): string {
  if (!ref) throw new ToolError('Hangi başvuru? Listedeki numarayı ya da başvuru kimliğini yaz.');
  if (/^\d{1,4}$/.test(ref)) {
    let list: { at: string; ids: string[] };
    try {
      list = JSON.parse(readFileSync(listPath(env), 'utf8')) as { at: string; ids: string[] };
    } catch {
      throw new ToolError('Önce "liste" çalıştır; numaralar son listeye göredir.');
    }
    if (!Array.isArray(list.ids) || !(now.getTime() - new Date(list.at).getTime() < LIST_MAX_AGE_MS)) {
      throw new ToolError('Son liste eski (2 saatten fazla): numaralar değişmiş olabilir. "liste" ile yenile.');
    }
    const id = list.ids[Number(ref) - 1];
    if (!id) throw new ToolError(`Son listede ${ref} numaralı başvuru yok.`);
    return id;
  }
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(ref)) throw new ToolError('Geçersiz başvuru kimliği.');
  return ref;
}
const flag = (args: string[], name: string) => args.includes(name);
const flagValues = (args: string[], name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

async function openPhotos(ctx: Ctx, d: ReviewDetail, withIdentity: boolean, printOnly = false) {
  const photos = d.media.filter((m) => (m.purpose === 'profile' && m.position !== null) || (withIdentity && m.purpose === 'verification'));
  if (!photos.length) return ctx.io.print('Açılacak fotoğraf yok.');
  ctx.io.print(
    `${photos.length} görsel ${printOnly ? 'için bağlantı' : 'tarayıcıda açılıyor'}. Bağlantılar kısa süre geçerli (profil 10 dk, kimlik 2 dk), kimseyle paylaşma; her açılış kayda geçer.`,
  );
  for (const m of photos) {
    const { url } = await ctx.client.mediaUrl(d.id, m.id);
    if (!safeLink(url)) throw new ToolError('Sunucu beklenmeyen bir bağlantı döndürdü; açılmadı.');
    const label = m.purpose === 'verification' ? 'kimlik doğrulama' : `fotoğraf ${m.position}`;
    if (printOnly) ctx.io.print(`  ${label}:\n  ${url}`);
    else if (!(await ctx.io.open(url))) ctx.io.print(`  ${label}: tarayıcı açılamadı — bağlantıyı kopyala:\n  ${url}`);
  }
}

/** Builds the reviewer action for a kind, asking what it needs (or reading it from flags). */
async function buildAction(ctx: Ctx, d: ReviewDetail, kind: ReviewerActionKind, args: string[], interactive: boolean): Promise<ReviewerAction | null> {
  if (kind === 'START_REVIEW' || kind === 'REQUEST_EXTENDED') return { kind };
  if (kind === 'REOPEN') {
    let to = flagValues(args, '--hedef')[0];
    if (!to && interactive) {
      const canFinal = d.timeline.extendedSubmittedAt !== null;
      const a = await ctx.io.ask(`Nereye? 1 İnceleme${canFinal ? ', 2 Son değerlendirme' : ''} › `);
      to = a === '2' && canFinal ? 'FINAL_REVIEW' : a === '1' ? 'UNDER_REVIEW' : '';
    }
    if (to !== 'UNDER_REVIEW' && to !== 'FINAL_REVIEW') throw new ToolError('Yeniden değerlendirme için hedef gerekli: --hedef UNDER_REVIEW ya da FINAL_REVIEW.');
    return { kind, to };
  }
  if (kind === 'REQUEST_INFORMATION') {
    const photos = d.media.filter((m) => m.purpose === 'profile' && m.position !== null);
    let picks = flagValues(args, '--istek');
    if (!picks.length && interactive) {
      const keys = Object.keys(INFORMATION_REQUEST_PRESETS) as InformationRequestPreset[];
      ctx.io.print(`Ne isteyelim? (en çok ${MAX_REQUESTS_PER_ROUND}; virgülle ayır, fotoğraf için numarasını ekle: 1:2)`);
      keys.forEach((k, i) => ctx.io.print(`  ${i + 1}  ${PRESET_TR[k]} — “${INFORMATION_REQUEST_PRESETS[k].explanation}”`));
      const a = await ctx.io.ask('› ');
      picks = a
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [n, photo] = s.split(':');
          const k = keys[Number(n) - 1];
          return k ? (photo ? `${k}:${photo}` : k) : '';
        });
    }
    const requests: InformationRequestDraft[] = [];
    for (const p of picks) {
      const [preset, photoNo] = p.split(':') as [InformationRequestPreset, string | undefined];
      if (!(preset in INFORMATION_REQUEST_PRESETS)) throw new ToolError(`Bilinmeyen istek: ${p}`);
      if (INFORMATION_REQUEST_PRESETS[preset].type === 'REPLACE_PHOTO') {
        const photo = photos.find((m) => m.position === Number(photoNo));
        if (!photo) throw new ToolError(`“${PRESET_TR[preset]}” için fotoğraf numarası gerekli (1–${photos.length}), örn. ${preset}:1`);
        requests.push({ preset, mediaId: photo.id });
      } else {
        requests.push({ preset });
      }
    }
    if (!requests.length) return null;
    return { kind, requests };
  }
  // A decision: an optional internal reason (never shown to the applicant).
  let reason = flagValues(args, '--neden')[0] as InternalDecisionReason | undefined;
  if (!reason && interactive) {
    ctx.io.print('Neden? (iç kayıt; başvurana asla gösterilmez — boş bırakabilirsin)');
    INTERNAL_DECISION_REASONS.forEach((r, i) => ctx.io.print(`  ${i + 1}  ${REASON_TR[r]}`));
    const a = await ctx.io.ask('› ');
    reason = a ? INTERNAL_DECISION_REASONS[Number(a) - 1] : undefined;
  }
  if (reason !== undefined && !INTERNAL_DECISION_REASONS.includes(reason)) throw new ToolError(`Bilinmeyen neden: ${reason}`);
  return reason ? ({ kind, reason } as ReviewerAction) : ({ kind } as ReviewerAction);
}

const nameOf = (d: ReviewDetail) => `${d.applicant.firstName} ${d.applicant.lastName}, ${d.applicant.age ?? '?'} · ${d.applicant.city}`;

async function decide(ctx: Ctx, d: ReviewDetail, kind: ReviewerActionKind, args: string[], interactive: boolean): Promise<boolean> {
  if (!d.actions.includes(kind)) throw new ToolError(`“${ACTION_TR[kind] ?? kind}” bu durumda (${STATUS_TR[d.status]}) yapılamaz. Yapılabilenler: ${d.actions.join(', ') || 'yok'}.`);
  const action = await buildAction(ctx, d, kind, args, interactive);
  if (!action) {
    ctx.io.print('Vazgeçildi.');
    return false;
  }
  const sure = interactive ? yes(await ctx.io.ask(`${nameOf(d)} — ${ACTION_TR[kind]}. Emin misin? (e/h) › `)) : flag(args, '--evet');
  if (!sure) {
    ctx.io.print(interactive ? 'Vazgeçildi.' : 'Karar kaydedilmedi: onaylamak için komuta --evet ekle.');
    return false;
  }
  const r = await ctx.client.act(d.id, action);
  ctx.io.print(`✓ ${d.applicant.firstName}: ${STATUS_TR[d.status]} → ${STATUS_TR[r.status] ?? r.status}`);
  if (r.status === 'APPROVED' && interactive) {
    if (yes(await ctx.io.ask('Davetli (ücretsiz) üyeliğini şimdi başlatayım mı? Başlayınca uygulamada üye olarak devam eder. (e/h) › '))) {
      const m = await ctx.client.invite(d.id);
      ctx.io.print(`✓ Davetli üyelik başladı: ${STATUS_TR[m.status] ?? m.status}`);
    }
  }
  return true;
}

async function invite(ctx: Ctx, d: ReviewDetail, args: string[], interactive: boolean) {
  if (!d.canStartInvitedMembership) {
    throw new ToolError(`Davetli üyelik yalnızca onaylanmış başvurular için başlatılabilir (şu an: ${STATUS_TR[d.status]}).`);
  }
  const sure = interactive
    ? yes(await ctx.io.ask(`${nameOf(d)} — davetli (ücretsiz) üyelik başlasın mı? Ödeme kaydı oluşmaz, yenilenmez. (e/h) › `))
    : flag(args, '--evet');
  if (!sure) return ctx.io.print(interactive ? 'Vazgeçildi.' : 'Üyelik başlatılmadı: onaylamak için komuta --evet ekle.');
  const r = await ctx.client.invite(d.id);
  ctx.io.print(`✓ ${d.applicant.firstName}: davetli üyelik başladı (${STATUS_TR[r.status] ?? r.status}).`);
}

async function listCommand(ctx: Ctx, args: string[]) {
  const all = flag(args, '--hepsi');
  const items = await ctx.client.queue({ statuses: all ? undefined : OPEN_STATUSES, qa: flag(args, '--qa') });
  const { text, order } = renderQueue(items, ctx.io.now(), { all });
  rememberList(order, ctx.env, ctx.io.now());
  ctx.io.print(text);
  return order;
}

async function interactive(ctx: Ctx) {
  let all = false;
  let qa = false;
  for (;;) {
    const items = await ctx.client.queue({ statuses: all ? undefined : OPEN_STATUSES, qa });
    const { text, order } = renderQueue(items, ctx.io.now(), { all });
    ctx.io.print(text); // numbers here live in this session only; the list file belongs to `liste`
    const a = (await ctx.io.ask(`\nNumara seç · y yenile · h ${all ? 'yalnız açıklar' : 'hepsi'} · q çık › `)).toLowerCase();
    if (a === 'q' || a === 'çık') return;
    if (a === 'h') {
      all = !all;
      continue;
    }
    if (a === 'qa') {
      qa = !qa;
      continue;
    }
    const picked = order[Number(a) - 1];
    if (!picked) continue;
    try {
      await applicationLoop(ctx, picked.id);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      ctx.io.print(`! ${e.message}`);
    }
  }
}

async function applicationLoop(ctx: Ctx, id: string) {
  for (;;) {
    const d = await ctx.client.detail(id);
    ctx.io.print(renderDetail(d, ctx.io.now()));
    const choices: [string, string, () => Promise<unknown>][] = d.actions.map((k, i) => [String(i + 1), ACTION_TR[k], () => decide(ctx, d, k, [], true)]);
    if (d.canStartInvitedMembership) choices.push(['u', 'Davetli (ücretsiz) üyeliği başlat', () => invite(ctx, d, [], true)]);
    if (d.media.some((m) => m.purpose === 'profile' && m.position !== null)) choices.push(['f', 'Fotoğrafları aç', () => openPhotos(ctx, d, false)]);
    if (d.media.some((m) => m.purpose === 'verification')) choices.push(['k', 'Kimlik doğrulama fotoğrafını da aç', () => openPhotos(ctx, d, true)]);
    choices.push(['g', 'Listeye dön', async () => undefined]);
    ctx.io.print(choices.map(([k, label]) => `  ${k.padStart(2)}  ${label}`).join('\n'));
    const a = (await ctx.io.ask('› ')).toLowerCase();
    if (a === 'g' || a === '') return;
    const c = choices.find(([k]) => k === a);
    if (!c) continue;
    try {
      await c[2]();
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      ctx.io.print(`! ${e.message}`);
    }
  }
}

async function setup(io: IO, env: NodeJS.ProcessEnv, fetchImpl?: Fetch, signingEnv?: string) {
  const current = (() => {
    try {
      return JSON.parse(readFileSync(configPath(env), 'utf8')) as Partial<ToolConfig>;
    } catch {
      return {};
    }
  })();
  io.print('Velvet inceleme aracı — kurulum. Anahtar yalnızca bu bilgisayarda saklanır; kimseyle paylaşma, sohbete yapıştırma.');
  let api = (await io.ask(`Staging API adresi${current.api ? ` [${current.api}]` : ''} › `)) || current.api || '';
  api = api.replace(/\/+$/, '');
  const apiProblem = checkApi(api);
  if (apiProblem) throw new ToolError(apiProblem);
  const reviewerId = (await io.ask(`Kayıtlarda görünecek adın (harf/rakam, örn. mert)${current.reviewerId ? ` [${current.reviewerId}]` : ''} › `)) || current.reviewerId || '';
  if (!REVIEWER_ID.test(reviewerId)) throw new ToolError('Ad 2–80 karakter olmalı; yalnızca harf, rakam ve . _ - @ (Türkçe karakter ve boşluk olmadan).');
  const secret = (await io.askHidden('Anahtar (Render → velvet-api-staging → Environment → INTERNAL_KEY_REVIEWER_SECRET; yazarken görünmez) › ')) || current.secret || '';
  if (secret.length < 32) throw new ToolError('Anahtar çok kısa — Render’daki değerin tamamını kopyaladığından emin ol.');
  const config: ToolConfig = { api, keyId: env.VELVET_REVIEW_KEY_ID ?? current.keyId ?? 'reviewer', secret, reviewerId, env: signingEnv ?? 'staging' };
  await reviewClient(config, fetchImpl, io.now).queue({ statuses: ['APPLICATION_RECEIVED'], limit: 1 }); // throws with a plain message if refused
  const path = saveToolConfig({ api, keyId: config.keyId, secret, reviewerId }, env);
  io.print(`✓ Bağlantı tamam. Ayarlar kaydedildi: ${path} (yalnızca senin kullanıcın okuyabilir).`);
}

const HELP = `Velvet inceleme aracı

  node velvet-review.mjs                  etkileşimli: liste → başvuru → karar
  node velvet-review.mjs kur              ilk kurulum (API adresi, adın, anahtar)
  node velvet-review.mjs liste [--hepsi] [--qa]
  node velvet-review.mjs goster <no|id>
  node velvet-review.mjs foto <no|id> [--kimlik] [--baglanti]   (--baglanti: tarayıcıyı açmadan bağlantıları yazdır)
  node velvet-review.mjs karar <no|id> <EYLEM> [--neden KOD] [--istek PRESET[:fotoNo]] [--hedef DURUM] --evet
  node velvet-review.mjs uyelik <no|id> --evet      davetli (ücretsiz) üyeliği başlat

EYLEM: ${Object.keys(ACTION_TR).join(', ')}
KOD: ${INTERNAL_DECISION_REASONS.join(', ')}
PRESET: ${Object.keys(INFORMATION_REQUEST_PRESETS).join(', ')}`;

const ALIASES: Record<string, string> = {
  setup: 'kur',
  list: 'liste',
  show: 'goster',
  göster: 'goster',
  photos: 'foto',
  decide: 'karar',
  invite: 'uyelik',
  üyelik: 'uyelik',
  help: 'yardim',
  yardım: 'yardim',
  '--help': 'yardim',
  '-h': 'yardim',
};

/**
 * Runs one command. Exported for tests: an in-process fetch, scripted IO and the
 * test server's signing environment. The command line always signs for staging.
 */
export async function run(argv: string[], io: IO, env: NodeJS.ProcessEnv = process.env, opts: { fetch?: Fetch; signingEnv?: 'test' } = {}): Promise<number> {
  const fetchImpl = opts.fetch;
  const [rawCmd, ...args] = argv;
  const cmd = rawCmd ? (ALIASES[rawCmd] ?? rawCmd) : '';
  try {
    if (cmd === 'yardim') {
      io.print(HELP);
      return 0;
    }
    if (cmd === 'kur') {
      await setup(io, env, fetchImpl, opts.signingEnv);
      return 0;
    }
    const loaded = loadToolConfig(env);
    const config = loaded.config && opts.signingEnv ? { ...loaded.config, env: opts.signingEnv } : loaded.config;
    const problems = loaded.problems;
    if (!config) {
      if (cmd === '' && process.stdin.isTTY) {
        io.print(problems.join('\n'));
        await setup(io, env, fetchImpl, opts.signingEnv);
        return run(argv, io, env, opts);
      }
      throw new ToolError(problems.join('\n'));
    }
    const ctx: Ctx = { io, client: reviewClient(config, fetchImpl, io.now), env };
    switch (cmd) {
      case '':
        io.print(`Velvet · başvuru masası — ${new URL(config.api).host} · inceleyen: ${config.reviewerId}`);
        await interactive(ctx);
        return 0;
      case 'liste':
        await listCommand(ctx, args);
        return 0;
      case 'goster':
        io.print(renderDetail(await ctx.client.detail(resolveRef(args[0], env, io.now())), io.now()));
        return 0;
      case 'foto':
        await openPhotos(ctx, await ctx.client.detail(resolveRef(args[0], env, io.now())), flag(args, '--kimlik'), flag(args, '--baglanti'));
        return 0;
      case 'karar': {
        const kind = args[1] as ReviewerActionKind;
        if (!kind || !(kind in ACTION_TR)) throw new ToolError(`Eylem gerekli: ${Object.keys(ACTION_TR).join(', ')}`);
        const d = await ctx.client.detail(resolveRef(args[0], env, io.now()));
        io.print(`${nameOf(d)} — ${STATUS_TR[d.status]}`);
        return (await decide(ctx, d, kind, args.slice(2), false)) ? 0 : 2;
      }
      case 'uyelik': {
        const d = await ctx.client.detail(resolveRef(args[0], env, io.now()));
        io.print(`${nameOf(d)} — ${STATUS_TR[d.status]}`);
        await invite(ctx, d, args.slice(1), false);
        return 0;
      }
      default:
        io.print(HELP);
        return 1;
    }
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    io.print(`! ${e.message}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    // Real paths on both sides: run through a symlink (or macOS /tmp → /private/tmp), it is still the main module.
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  run(process.argv.slice(2), terminalIO())
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`Beklenmeyen hata: ${e.message}`);
      process.exit(1);
    });
}
