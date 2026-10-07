/**
 * End-to-end admission flow against static web exports.
 *
 *   npm run build:web:qa     # dist/      dev HOOKS on, dev PANEL off (clean screenshots)
 *   npm run build:web:prod   # dist-prod/ EXPO_PUBLIC_APP_ENV=production (no dev anything)
 *   node e2e/run.mjs [screenshotDir]
 *
 * Runs the Stage 1 vertical slice at three phone widths with a different
 * applicant each (Turkish diacritics, long double surnames, long city names),
 * plus a fourth Stage 1-only run (very long Latin names, typed city abroad);
 * the three main runs continue through Stage 2 (e2e/stage2.mjs);
 * captures every screen plus validation and simulated-keyboard states, then
 * verifies a production-mode bundle exposes no development UI or hooks.
 *
 * The web build is a proxy for the native app: same lifecycle, store, guards
 * and screens, but not native keyboard, gesture, blur or screen-reader behaviour.
 * "Keyboard" screenshots shorten the viewport by a typical iOS keyboard height.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { member } from './member.mjs';
import { productionFlow, startApi } from './production.mjs';
import { outcomes } from './outcomes.mjs';
import { stage2 } from './stage2.mjs';

const SHOTS = resolve(process.argv[2] ?? 'e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.json': 'application/json' };
function serve(dir) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // QA photography for the fixture community — served by this harness only, never bundled (DEC-037).
    if (path.startsWith('/__qa/') && !path.includes('..')) {
      const qa = join(resolve('e2e/fixtures'), path.slice('/__qa/'.length));
      if (existsSync(qa)) {
        res.writeHead(200, { 'content-type': MIME[extname(qa)] ?? 'application/octet-stream' });
        res.end(readFileSync(qa));
        return;
      }
    }
    let file = join(root, path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const KEYBOARD_HEIGHT = 291; // typical iPhone number/alpha keyboard incl. suggestion bar

/**
 * Stage 2 data per run: a long-value run (3 interests), a full-collection run
 * (8 interests + the limit), and a short-value run. `interests` are
 * [tab, label] pairs because interests live in category tabs.
 */
const LONG_KNOWN_FOR =
  'I lead a small studio restoring nineteenth-century wooden yalı houses along the Asian shore of the Bosphorus. ' +
  'We work with carpenters from Rize and Kastamonu, record every joint before we touch it, and teach two graduate ' +
  'studios a year on conservation. The work I am proudest of is the Kandilli boathouse, rebuilt timber by timber.';

const RUNS = [
  {
    name: 'small', viewport: { width: 375, height: 667 }, reducedMotion: 'reduce',
    first: 'Şebnem', last: 'Karaosmanoğlu-Büyükçekmeceli', instagram: '@sebnem.k',
    country: { search: 'turkiye', code: 'TR' }, city: { search: 'kahraman', id: 'TR-kahramanmaras', label: 'Kahramanmaraş' },
    referral: { name: 'Gökçe Işıklar', phone: '5551112233', shown: 'Gökçe I.' },
    s2: {
      occupation: 'Restoration architect and conservation lecturer',
      work: { kind: 'organisation', name: 'Karaosmanoğlu Mimarlık ve Restorasyon Atölyesi' },
      knownFor: LONG_KNOWN_FOR,
      interests: [['culture', 'Architecture'], ['outdoors', 'Swimming'], ['music', 'Jazz']],
      intents: ['dating', 'friendship'],
      meet: { taps: ['women', 'everyone'], expect: ['everyone'] },
      age: { steps: [['age-max-increase', 3]], expect: [26, 41] },
      // Dating setup after activation (DEC-058): self-described, included when people look to meet women.
      dating: { self: 'Genderfluid, mostly', appears: ['WOMAN'], seeking: ['WOMAN', 'MAN', 'NON_BINARY'], ages: [26, 41],
        introductions: ['Kerem', 'Selin', 'Deniz', 'Zeynep', 'Mert', 'Can'] },
    },
  },
  {
    name: 'standard', viewport: { width: 393, height: 852 }, reducedMotion: 'no-preference',
    first: 'Çağla', last: 'Öztürk-Işıl', instagram: 'https://www.instagram.com/Cagla.Ozturk/?hl=tr',
    country: { search: 'Türkiye', code: 'TR' }, city: { search: 'mugla', id: 'TR-mugla', label: 'Muğla' },
    referral: null,
    s2: {
      occupation: 'Mimar & iç mimar',
      work: { kind: 'organisation', name: 'Atölye Kuzguncuk' },
      knownFor: 'I restore wooden yalı houses on the Asian shore of the Bosphorus with a small team of craftspeople.',
      interests: [
        ['culture', 'Architecture'], ['culture', 'Photography'], ['culture', 'Cinema'],
        ['ideas', 'Books'], ['ideas', 'Poetry'], ['music', 'Jazz'],
        ['outdoors', 'Swimming'], ['outdoors', 'Sailing'],
      ],
      ninth: ['living', 'Wine'],
      intents: ['dating', 'community'],
      meet: { taps: ['women', 'men'], expect: ['women', 'men'] },
      age: { steps: [['age-min-increase', 2], ['age-max-decrease', 4]], expect: [28, 34] },
      dating: { gender: 'WOMAN', seeking: ['WOMAN', 'MAN'], ages: [28, 34], introductions: ['Kerem', 'Selin', 'Deniz', 'Zeynep'] },
    },
  },
  {
    name: 'large', viewport: { width: 430, height: 932 }, reducedMotion: 'no-preference',
    first: 'Gökçe', last: 'Işıklar-Ünal', instagram: 'gokce.iu',
    country: { search: 'Türkiye', code: 'TR' }, city: { search: 'istanbul', id: 'TR-istanbul', label: 'İstanbul' },
    referral: { name: 'Kerem Aksoy', phone: '5321112233', shown: 'Kerem A.' },
    s2: {
      occupation: 'Chef',
      work: { kind: 'independent' },
      knownFor: 'Slow Aegean cooking from a twelve-seat counter in Kadıköy, and a winter supper club for strangers.',
      interests: [['living', 'Cooking'], ['living', 'Wine'], ['ideas', 'Languages']],
      intents: ['friendship', 'community'],
    },
  },
  // Stage 1 only: very long Latin names and a typed (non-catalogue) city abroad.
  {
    name: 'xl-abroad', stage1Only: true, viewport: { width: 430, height: 932 }, reducedMotion: 'no-preference',
    first: 'Alexandra-Charlotte', last: 'Montgomery-Fitzwilliam Ainsworth', instagram: 'alexandra.cmf',
    country: { search: 'Fransa', code: 'FR' }, city: { search: 'Saint-Rémy-de-Provence', typed: true, label: 'Saint-Rémy-de-Provence' },
    referral: { name: 'Kerem Aksoy', phone: '5321112233', shown: 'Kerem A.' },
  },
];

async function newPage(base, run) {
  const context = await browser.newContext({
    viewport: run.viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: run.reducedMotion,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.E2E_CONSOLE) page.on('console', (m) => console.log(`  console: ${m.text()}`));
  const tid = (id) => page.locator(`[data-testid="${id}"]:visible`).first();
  const visible = (id, timeout = 8000) => tid(id).waitFor({ state: 'visible', timeout });
  const fillInput = async (id, value) => {
    const el = page
      .locator(`input[data-testid="${id}"]:visible, textarea[data-testid="${id}"]:visible, [data-testid="${id}"]:visible input`)
      .first();
    await el.click();
    await el.fill('');
    if (value) await el.pressSequentially(value, { delay: 10 });
  };
  const shot = async (label) => {
    await page.waitForTimeout(run.reducedMotion === 'reduce' ? 150 : 500);
    await page.screenshot({ path: join(SHOTS, `${run.name}-${label}.png`) });
  };
  const keyboardShot = async (label) => {
    await page.setViewportSize({ width: run.viewport.width, height: run.viewport.height - KEYBOARD_HEIGHT });
    await page.waitForTimeout(700); // let the shell bring the focused field into view
    await shot(`${label}-keyboard`);
    await page.setViewportSize(run.viewport);
  };
  const local = () => page.evaluate(() => JSON.parse(localStorage.getItem('velvet.admission.v1') ?? 'null'));
  const server = () => page.evaluate(() => JSON.parse(localStorage.getItem('velvet.mockServer.v1') ?? 'null'));
  await page.goto(base + '/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(base + '/');
  return { context, page, errors, tid, visible, fillInput, shot, keyboardShot, local, server };
}

/** A fresh browser context restored to a saved device + mock-server state. */
async function openWithStorage(base, run, saved) {
  const p = await newPage(base, run);
  await p.page.evaluate((s) => {
    localStorage.setItem('velvet.admission.v1', s.admission);
    localStorage.setItem('velvet.mockServer.v1', s.server);
  }, saved);
  await p.page.goto(base + '/application/status');
  return p;
}

async function stage1(base, run) {
  const t = `[${run.name}]`;
  const p = await newPage(base, run);
  const { page, tid, visible, fillInput, shot, keyboardShot, local, server } = p;

  // AUTH-01 Launch
  await visible('screen-launch', 20000);
  await page.evaluate(() => document.fonts.ready);
  await shot('01-launch');

  // AUTH-02 Phone
  await tid('launch-apply').click();
  await visible('screen-phone');
  await shot('02-phone-empty');
  await fillInput('phone-input', '12345');
  await tid('phone-continue').click();
  await page.waitForTimeout(150);
  check(`${t} invalid phone rejected`, (await page.getByText('Check your phone number').count()) > 0);
  await shot('03-phone-error');
  await fillInput('phone-input', '5321234567');
  await shot('04-phone');
  await keyboardShot('04-phone');
  await tid('phone-continue').click();

  // AUTH-03 OTP
  await visible('screen-code');
  check(`${t} OTP dev hint hidden without panel flag`, (await page.locator('[data-testid="otp-dev-hint"]').count()) === 0);
  await shot('05-code-empty');
  await page.locator('input[data-testid="otp-input"]:visible').fill('246');
  await shot('06-code-partial');
  await page.locator('input[data-testid="otp-input"]:visible').fill('111111');
  await page.getByText('doesn’t look right').first().waitFor({ timeout: 5000 });
  check(`${t} wrong OTP rejected`, true);
  await shot('07-code-error');
  await page.locator('input[data-testid="otp-input"]:visible').fill('246 810'); // pasted with a space
  await visible('screen-intro', 10000);
  check(`${t} OTP verified → APPLICATION_DRAFT`, (await local())?.status === 'APPLICATION_DRAFT');
  await shot('08-intro');

  // Guards while drafting
  await page.goto(base + '/member');
  await visible('screen-intro');
  check(`${t} draft applicant redirected away from /member`, !page.url().includes('/member'));
  await page.goto(base + '/apply/review');
  await visible('screen-intro');
  check(`${t} cannot deep-link past unanswered steps`, page.url().endsWith('/apply/intro'));
  await tid('intro-begin').click();

  // APP-01 / APP-02 names
  await visible('screen-first-name');
  await fillInput('input-first-name', 'Ali2');
  await tid('step-continue').click();
  check(`${t} invalid name rejected`, (await page.getByText('Use letters only').count()) > 0);
  await shot('09-first-name-error');
  await fillInput('input-first-name', run.first);
  await shot('10-first-name');
  await keyboardShot('10-first-name');
  await tid('step-continue').click();
  await visible('screen-last-name');
  await fillInput('input-last-name', run.last);
  await shot('11-last-name');
  await tid('step-continue').click();

  // APP-03 DOB
  await visible('screen-date-of-birth');
  const now = new Date();
  const tomorrow18 = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate() + 1);
  await fillInput('dob-day', String(tomorrow18.getDate()).padStart(2, '0'));
  await fillInput('dob-month', String(tomorrow18.getMonth() + 1).padStart(2, '0'));
  await fillInput('dob-year', String(tomorrow18.getFullYear()));
  await tid('step-continue').click();
  await page.getByText('18 or older to apply for membership').waitFor({ timeout: 3000 });
  check(`${t} under-18 DOB rejected and not stored`, (await local())?.draft.dateOfBirth === null);
  await shot('12-dob-under-18');
  await fillInput('dob-day', '31');
  await fillInput('dob-month', '02');
  await fillInput('dob-year', '1994');
  await tid('step-continue').click();
  check(`${t} impossible date rejected`, (await page.getByText('That date doesn’t exist').count()) > 0);
  await fillInput('dob-day', '14');
  await fillInput('dob-month', '03');
  await fillInput('dob-year', '1994');
  await shot('13-dob');
  await tid('step-continue').click();

  // APP-04 Instagram (required, DEC-023)
  await visible('screen-instagram');
  check(`${t} no Instagram opt-out offered`, (await page.getByText('I don’t use Instagram').count()) === 0);
  await fillInput('input-instagram', 'selin kaya');
  await tid('step-continue').click();
  check(`${t} invalid Instagram rejected`, (await page.getByText('Usernames use letters').count()) > 0);
  await shot('14-instagram-error');
  await fillInput('input-instagram', run.instagram);
  await shot('15-instagram');
  await tid('step-continue').click();
  check(`${t} Instagram normalised to a handle`, (await local())?.draft.instagram?.kind === 'handle');

  // APP-05 Country
  await visible('screen-country');
  await fillInput('country-list-search', 'almanya');
  await visible('option-DE');
  check(`${t} country search matches Turkish name`, true);
  await fillInput('country-list-search', run.country.search);
  await tid(`option-${run.country.code}`).click();
  await shot('16-country');
  await tid('step-continue').click();

  // APP-06 City
  await visible('screen-city');
  if (run.city.typed) {
    await fillInput('city-list-search', run.city.search);
    await shot('17-city-not-listed');
    await tid('city-use-typed').click();
  } else {
    await fillInput('city-list-search', run.city.search);
    await tid(`option-${run.city.id}`).click();
  }
  await shot('18-city');
  await tid('step-continue').click();
  check(`${t} city committed`, (await local())?.draft.city?.label === run.city.label);

  // APP-07 Referral
  await visible('screen-referral');
  await shot('19-referral');
  if (run.referral) {
    await tid('referral-add').click();
    await fillInput('referral-name', run.referral.name);
    await fillInput('referral-phone', '5321234567'); // own number
    await tid('referral-save').click();
    check(`${t} self-referral rejected`, (await page.getByText('someone other than yourself').count()) > 0);
    await shot('20-referral-error');
    await fillInput('referral-phone', run.referral.phone);
    await tid('referral-save').click();
    await visible('referral-list');
    const listText = await tid('referral-list').innerText();
    check(`${t} referral shown as short name + generic state`, listText.includes(run.referral.shown) && listText.includes('Referral requested'));
    check(`${t} referral phone never shown`, !/\d{3}/.test(listText));
    await shot('21-referral-added');
    await tid('step-continue').click();
  } else {
    await tid('referral-none').click();
  }

  // APP-08 Review
  await visible('screen-review');
  await page.waitForTimeout(300);
  await shot('22-review');
  await page.screenshot({ path: join(SHOTS, `${run.name}-22-review-full.png`), fullPage: true });
  const review = await tid('screen-review').innerText();
  check(`${t} review shows names and place intact`, review.includes(run.first) && review.includes(run.last) && review.includes(run.city.label));
  check(`${t} review marks private details`, review.includes('Your last name stays private.'));
  if (run.referral) {
    check(`${t} review shows referral short name only`, review.includes(run.referral.shown) && !review.includes(run.referral.name));
    check(`${t} referral phone absent from review`, !review.includes(run.referral.phone.slice(-4)));
  }

  // Back navigation must not corrupt data.
  await tid('edit-first-name').click();
  await visible('screen-first-name');
  await fillInput('input-first-name', 'Zzz123');
  await tid('back-button').click();
  await visible('screen-review');
  check(`${t} back without continuing leaves draft intact`, (await local())?.draft.firstName === run.first);

  if (run.name === 'standard') {
    // Edit country from Review → city cleared and requested again → back to Review.
    await tid('edit-country').click();
    await visible('screen-country');
    await fillInput('country-list-search', 'Germany');
    await tid('option-DE').click();
    await tid('step-continue').click();
    await visible('screen-city');
    check(`${t} country change clears city`, (await local())?.draft.city === null);
    await fillInput('city-list-search', 'Berlin');
    await tid('option-DE-berlin').click();
    await tid('step-continue').click();
    await visible('screen-review');
    check(`${t} returns to review after edit`, (await tid('screen-review').innerText()).includes('Berlin, Germany'));
    run.city.label = 'Berlin';
  }

  // Draft persists across reload.
  await page.reload();
  await visible('screen-review', 12000);
  const persisted = await local();
  check(`${t} draft persists across reload`, persisted?.draft.firstName === run.first && persisted?.draft.city?.label === run.city.label);

  // APP-09 Submit — first attempt fails, then retry.
  await page.evaluate(() => globalThis.__velvetDev.failNext('submitStage1'));
  await tid('review-submit').click();
  await visible('confirm-sheet');
  await shot('23-confirm');
  await tid('confirm-submit').click();
  await visible('review-retry', 10000);
  check(`${t} failed submit stays APPLICATION_SUBMITTED`, (await local())?.status === 'APPLICATION_SUBMITTED');
  await shot('24-submit-failed');
  await tid('review-retry').click();

  // APP-10 Received
  await visible('screen-received', 12000);
  check(`${t} submit → APPLICATION_RECEIVED`, (await local())?.status === 'APPLICATION_RECEIVED');
  await shot('25-received');
  const receivedText = (await page.locator('body').innerText()).toLowerCase();
  check(`${t} no fake result / urgency copy`, !/congratulat|approved|welcome\.|queue|position|%|days left|countdown/.test(receivedText));

  // STATUS-01
  await tid('received-view-status').click();
  await visible('screen-status');
  await shot('26-status-received');
  await page.screenshot({ path: join(SHOTS, `${run.name}-26-status-received-full.png`), fullPage: true });
  check(`${t} status headline`, (await tid('status-headline').innerText()) === 'Application received');
  check(`${t} status shows submission date and next step`, (await tid('status-submitted-on').innerText()).includes('2026') && (await tid('status-next-step').innerText()).includes('Nothing for now'));
  check(`${t} dev panel not rendered without flag`, (await page.locator('[data-testid="dev-review-panel"]').count()) === 0);

  // Device keeps only the summary after submission (privacy).
  const after = await local();
  check(`${t} device no longer holds DOB / Instagram / referral`, after.draft.dateOfBirth === null && after.draft.instagram === null && after.draft.referral === null);

  // Guards after submission
  await page.goto(base + '/member');
  await visible('screen-status', 12000);
  check(`${t} submitted applicant redirected from /member`, page.url().endsWith('/application/status'));
  await page.goto(base + '/apply/first-name');
  await visible('screen-status', 12000);
  check(`${t} submitted applicant cannot reopen draft`, page.url().endsWith('/application/status'));
  await page.reload();
  await visible('screen-status', 12000);
  check(`${t} status survives reload`, (await tid('status-headline').innerText()) === 'Application received');

  const db = await server();
  const apps = Object.values(db.applications);
  check(`${t} exactly one application after retry`, apps.length === 1);
  check(`${t} no admission decision generated`, apps.every((a) => a.status === 'APPLICATION_RECEIVED' && a.decisionAt === null));
  check(`${t} no membership created`, Object.keys(db.memberships).length === 0);

  // Reviewer moves it on (dev hook, no UI) — status follows the server.
  await page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('velvet.admission.v1'));
    await globalThis.__velvetDev.advance(s.session.userId, 'UNDER_REVIEW');
  });
  await tid('status-refresh').click();
  await page.getByText('Under review').first().waitFor({ timeout: 8000 });
  check(`${t} UNDER_REVIEW rendered from server status`, (await local())?.status === 'UNDER_REVIEW');
  await shot('27-status-under-review');
  await page.goto(base + '/member');
  await visible('screen-status', 12000);
  check(`${t} under-review applicant redirected from /member`, page.url().endsWith('/application/status'));

  check(`${t} no page errors`, p.errors.length === 0, p.errors.join(' | '));
  return p;
}

// --- QA build: all three widths ---------------------------------------------
{
  const { server, base } = await serve('dist');
  // E2E_ONLY=small runs a single width (debugging); the default runs all.
  // E2E_MEMBER_FROM=<dir> resumes the member slice from states saved with E2E_SAVE_MEMBER=1 (debugging).
  for (const run of RUNS.filter((r) => !process.env.E2E_ONLY || r.name === process.env.E2E_ONLY)) {
    if (process.env.E2E_MEMBER_FROM) {
      if (run.stage1Only) continue;
      const saved = JSON.parse(readFileSync(join(process.env.E2E_MEMBER_FROM, `${run.name}-member-state.json`), 'utf8'));
      const p = await newPage(base, run);
      await p.page.evaluate((s) => {
        localStorage.setItem('velvet.admission.v1', s.admission);
        localStorage.setItem('velvet.mockServer.v1', s.server);
      }, saved);
      if (run.name === 'standard') run.city.label = 'Berlin';
      await member(base, run, p, check);
      await p.context.close();
      continue;
    }
    const p = await stage1(base, run);
    if (!run.stage1Only) {
      await stage2(base, run, p, check, SHOTS);
      check(`[${run.name}] no page errors (Stage 2)`, p.errors.length === 0, p.errors.join(' | '));
      await outcomes(base, run, p, check, (saved) => openWithStorage(base, run, saved));
      check(`[${run.name}] no page errors (outcomes)`, p.errors.length === 0, p.errors.join(' | '));
      if (process.env.E2E_SAVE_MEMBER) {
        const state = await p.page.evaluate(() => ({ admission: localStorage.getItem('velvet.admission.v1'), server: localStorage.getItem('velvet.mockServer.v1') }));
        writeFileSync(join(SHOTS, `${run.name}-member-state.json`), JSON.stringify(state));
      }
      await member(base, run, p, check);
    }
    await p.context.close();
  }
  server.close();
}

// --- Production-mode bundle against the real API (DEC-059) --------------------
// The release bundle has no mock: it talks to the production API, here a test
// deployment on PostgreSQL (e2e/production.mjs).
if (existsSync('dist-prod/index.html') && !process.env.E2E_SKIP_PROD) {
  const api = await startApi();
  const { server, base } = await serve('dist-prod');
  const run = RUNS[1];
  const p = await newPage(base, run);
  const shot = async (label) => {
    await p.page.waitForTimeout(300);
    await p.page.screenshot({ path: join(SHOTS, `${label}.png`) });
  };
  try {
    await productionFlow(p, api, check, shot);
  } catch (e) {
    check('[prod] flow completed', false, `${e.message}\n${api.log.join('').slice(-2000)}`);
  }
  await p.context.close();
  server.close();
  api.stop();
} else if (!process.env.E2E_SKIP_PROD) {
  check('[prod] production bundle present (run npm run build:web:prod)', false);
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
