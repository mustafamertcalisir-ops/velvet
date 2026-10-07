/**
 * Stage 2 end-to-end: UNDER_REVIEW → EXTENDED_APPLICATION_REQUIRED → extended
 * draft → FINAL_REVIEW. Continues from the page left by the Stage 1 run.
 */
import { resolve } from 'node:path';

const FIXTURES = ['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg', 'photo-4.jpg'].map((f) => resolve('e2e/fixtures', f));

export async function stage2(base, run, p, check, SHOTS) {
  const t = `[${run.name}]`;
  const { page, tid, visible, fillInput, shot, keyboardShot, local, server } = p;
  const d = run.s2;

  const chooseFiles = async (files) => {
    const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
    await tid('photo-add').click();
    await (await chooser).setFiles(files);
  };

  // STATUS-03 — the team asks for more.
  await page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('velvet.admission.v1'));
    await globalThis.__velvetDev.advance(s.session.userId, 'EXTENDED_APPLICATION_REQUIRED');
  });
  await tid('status-refresh').click();
  await page.getByText('We’d like to know you better.').first().waitFor({ timeout: 8000 });
  await visible('status-primary');
  await shot('30-status-continue');
  const stages = await tid('status-stages').innerText();
  check(`${t} extended stage shows four-step sequence`, stages.includes('Final review') && stages.includes('Decision'));

  // Continue application → server opens the draft → guard routes to EXT-00.
  await tid('status-primary').click();
  await visible('screen-extended-intro', 10000);
  check(`${t} UNDER_REVIEW → EXTENDED_REQUIRED → EXTENDED_DRAFT`, (await local())?.status === 'EXTENDED_APPLICATION_DRAFT');
  await shot('31-extended-intro');
  check(`${t} intro reads as an application update`, (await tid('screen-extended-intro').innerText()).includes('Application update'));
  await page.goto(base + '/member');
  await visible('screen-extended-intro', 12000);
  check(`${t} extended applicant redirected from /member`, !page.url().includes('/member'));
  await page.goto(base + '/apply/first-name');
  await visible('screen-extended-intro', 12000);
  check(`${t} Stage 1 stays locked during Stage 2`, page.url().endsWith('/extended/intro'));
  await tid('extended-begin').click();

  // EXT-01 photos
  await visible('screen-photos');
  await shot('32-photos-empty');
  await tid('step-continue').click({ force: true });
  await page.waitForTimeout(300);
  check(`${t} cannot continue without photos`, await tid('screen-photos').isVisible());
  await chooseFiles(FIXTURES.slice(0, 3));
  await visible('photo-2', 15000);
  await page.waitForTimeout(400);
  check(`${t} three photos uploaded`, (await tid('photo-count').innerText()).startsWith('3 of 6'));
  await shot('33-photos-three');

  await page.evaluate(() => globalThis.__velvetDev.failNext('uploadApplicationPhoto'));
  await chooseFiles([FIXTURES[3]]);
  await page.getByText('didn’t upload').first().waitFor({ timeout: 10000 });
  check(`${t} upload failure reported, nothing added`, (await tid('photo-count').innerText()).startsWith('3 of 6'));
  await shot('34-photos-upload-failed');
  await chooseFiles([FIXTURES[3]]);
  await visible('photo-3', 15000);
  check(`${t} upload retry succeeds`, (await tid('photo-count').innerText()).startsWith('4 of 6'));

  const order = async () => (await local()).extendedDraft.photos.map((x) => x.id);
  const before = await order();
  await tid('photo-3').click();
  await visible('photo-options');
  await shot('35-photo-options');
  await tid('photo-move-first').click();
  await page.waitForTimeout(300);
  const after = await order();
  check(`${t} photo reordered to first`, after[0] === before[3]);
  await tid('photo-1').click();
  await visible('photo-options');
  await tid('photo-remove').click();
  await page.waitForTimeout(300);
  check(`${t} photo removed`, (await order()).length === 3);
  await shot('36-photos-ready');
  await tid('step-continue').click();

  // EXT-02 occupation
  await visible('screen-occupation');
  await fillInput('input-occupation', '🎨 Painter');
  await tid('step-continue').click();
  check(`${t} emoji occupation rejected`, (await page.getByText('no emoji').count()) > 0);
  await shot('37-occupation-error');
  await fillInput('input-occupation', d.occupation);
  await shot('37b-occupation');
  await keyboardShot('37b-occupation');
  const occBox = await tid('input-occupation').boundingBox();
  check(`${t} long occupation wraps inside the screen`, occBox && occBox.x + occBox.width <= run.viewport.width);
  await tid('step-continue').click();

  // EXT-03 work context
  await visible('screen-work-context');
  if (d.work.kind === 'organisation') {
    await tid('choice-organisation').click();
    await fillInput('input-organisation', d.work.name);
    check(`${t} organisation name kept intact`, (await tid('input-organisation').inputValue()) === d.work.name);
    await keyboardShot('38-work-context');
  } else {
    await tid('choice-independent').click();
  }
  await shot('38-work-context');
  await tid('step-continue').click();

  // EXT-04 / EXT-05
  await visible('screen-what-you-do');
  await fillInput('input-what-you-do', 'Too short.');
  await tid('step-continue').click();
  check(`${t} too-short answer rejected`, (await page.getByText('A little more, please').count()) > 0);
  await shot('39-what-you-do-error');
  await fillInput('input-what-you-do', d.knownFor);
  await shot('40-what-you-do');
  await keyboardShot('40-what-you-do');
  await tid('step-continue').click();
  await visible('screen-about-you');
  await fillInput('input-about-you', 'I swim in the Bosphorus every morning from May until the water turns, and I collect old İstanbul ferry timetables.');
  await shot('40b-about-you');
  await tid('step-continue').click();

  // EXT-06 interests — chosen across category tabs.
  await visible('screen-interests');
  await shot('41a-interests-empty');
  for (const [tab, label] of d.interests) {
    await tid(`interest-tab-${tab}`).click();
    await tid(`interest-${label}`).click();
  }
  const summaryText = await tid('interest-summary').innerText();
  check(`${t} chosen interests collected as one sentence`, d.interests.every(([, l]) => summaryText.includes(l)));
  check(`${t} interest count`, (await tid('interest-count').innerText()) === `${d.interests.length} / 8`);
  for (const room of ['culture', 'ideas', 'music', 'outdoors', 'living']) {
    const box = await tid(`interest-tab-${room}`).boundingBox();
    check(`${t} interest room "${room}" fully on screen`, box && box.x >= 0 && box.x + box.width <= run.viewport.width + 0.5);
  }
  if (d.ninth) {
    await tid(`interest-tab-${d.ninth[0]}`).click();
    await tid(`interest-${d.ninth[1]}`).click({ force: true });
    await page.waitForTimeout(200);
    check(`${t} a ninth interest is refused`, (await tid('interest-count').innerText()) === '8 / 8');
    check(`${t} limit explained`, await tid('interest-limit').isVisible());
    await tid(`interest-tab-${d.interests[0][0]}`).click();
  }
  await shot('41-interests');
  await tid('step-continue').click();
  check(`${t} interests committed`, (await local()).extendedDraft.interests.length === d.interests.length);

  // EXT-07 intent
  await visible('screen-intent');
  for (const i of d.intents) await tid(`choice-${i}`).click();
  await shot('42-intent');
  await tid('step-continue').click();

  // EXT-08 dating preferences — only when Dating is chosen (DEC-040).
  if (d.intents.includes('dating')) {
    await visible('screen-meet');
    check(`${t} dating adds two steps to the folio`, (await tid('progress-folio').innerText()) === '8 of 9');
    await shot('42b-meet-empty');
    for (const m of d.meet.taps) await tid(`choice-${m}`).click();
    const meetState = await local();
    await shot('42b-meet');
    await tid('step-continue').click();
    check(`${t} meet preference committed`, JSON.stringify((await local()).extendedDraft.datingPreferences.meet) === JSON.stringify(d.meet.expect));
    void meetState;

    await visible('screen-age-range');
    check(`${t} age range starts from a neutral suggestion`, /^Between \d{2} and \d{2}\.$/.test(await tid('age-readback').innerText()));
    await shot('42c-age-range-start');
    for (const [id, n] of d.age.steps) for (let k = 0; k < n; k++) await tid(id).click();
    const readback = await tid('age-readback').innerText();
    check(`${t} age range adjusts with clear numerals`, readback === `Between ${d.age.expect[0]} and ${d.age.expect[1]}.`);
    await shot('42c-age-range');
    await tid('step-continue').click();
    const prefs = (await local()).extendedDraft.datingPreferences;
    check(`${t} age range persisted`, prefs.ageRange?.min === d.age.expect[0] && prefs.ageRange?.max === d.age.expect[1]);
  } else {
    await visible('screen-preview');
    check(`${t} no dating questions without Dating`, page.url().endsWith('/extended/preview'));
    check(`${t} no dating data stored without Dating`, (await local()).extendedDraft.datingPreferences.meet.length === 0);
  }

  // EXT-12 preview — built from the whitelist only.
  await visible('screen-preview');
  await page.waitForTimeout(500);
  await shot('43-preview');
  const previewText = await tid('screen-preview').innerText();
  check(`${t} preview shows first name`, (await tid('preview-name').innerText()).startsWith(run.first));
  check(`${t} preview shows an age`, /^\d{2}$/.test((await tid('preview-age').innerText()).trim()));
  check(`${t} preview never shows last name`, !previewText.includes(run.last));
  check(`${t} preview never shows Instagram`, !previewText.includes('@') && !previewText.toLowerCase().includes('instagram'));
  check(`${t} preview never shows phone or referral`, !previewText.includes('532') && !(run.referral && previewText.includes(run.referral.shown)));
  check(`${t} preview never shows the about-you answer`, !previewText.includes('ferry timetables'));
  check(`${t} preview never shows dating preferences`, !/\b(Women|Men|Everyone)\b|Between \d/.test(previewText));
  check(`${t} preview shows occupation and known for`, previewText.includes(d.occupation) && previewText.includes(d.knownFor.slice(0, 40)));
  check(`${t} preview interests as a line`, d.interests.every(([, l]) => previewText.includes(l)));
  const plates = await page.locator('[data-testid="preview-plate"]').count();
  check(`${t} every other photo appears once, in the column`, plates === 2);
  // Scroll the editorial column into view.
  await page.mouse.move(run.viewport.width / 2, run.viewport.height / 2);
  await page.mouse.wheel(0, run.viewport.height * 0.6);
  await page.waitForTimeout(500);
  await shot('43b-preview-known-for');
  await page.mouse.wheel(0, run.viewport.height * 0.7);
  await page.waitForTimeout(500);
  await shot('43c-preview-column');
  await page.mouse.wheel(0, run.viewport.height * 2);
  await page.waitForTimeout(500);
  await shot('43d-preview-end');
  await tid('step-continue').click();

  // EXT-13 review — draft persists across reload.
  await visible('screen-extended-review');
  await page.reload();
  await visible('screen-extended-review', 12000);
  const persisted = (await local()).extendedDraft;
  check(`${t} extended draft restored after reload`, persisted.photos.length === 3 && persisted.occupation === d.occupation);
  const reviewText = await tid('screen-extended-review').innerText();
  check(`${t} review portrait shows first name, not surname`, reviewText.includes(run.first) && !reviewText.includes(run.last));
  if (d.work.kind === 'organisation') check(`${t} review shows workplace in full`, reviewText.includes(d.work.name));
  check(`${t} review portrait never shows dating preferences`, !/\b(Women|Men|Everyone)\b|Between \d/.test(reviewText));
  check(`${t} review names dating preferences only when asked`, (await page.locator('[data-testid="review-dating"]:visible').count()) === (d.intents.includes('dating') ? 1 : 0));
  await page.waitForTimeout(400);
  await shot('44-extended-review');
  await page.mouse.move(run.viewport.width / 2, run.viewport.height / 2);
  await page.mouse.wheel(0, run.viewport.height * 0.7);
  await page.waitForTimeout(400);
  await shot('44b-extended-review-answers');
  await page.mouse.wheel(0, run.viewport.height * 2);
  await page.waitForTimeout(400);
  await shot('44c-extended-review-end');

  await page.evaluate(() => globalThis.__velvetDev.failNext('submitStage2'));
  await tid('extended-submit').click();
  await visible('extended-confirm');
  await shot('45-extended-confirm');
  await tid('extended-confirm-submit').click();
  await visible('extended-retry', 10000);
  check(`${t} failed extended submit stays EXTENDED_SUBMITTED`, (await local())?.status === 'EXTENDED_APPLICATION_SUBMITTED');
  await tid('extended-retry').click();

  // EXT-14 → FINAL_REVIEW
  await visible('screen-extended-sent', 12000);
  await shot('46-extended-sent');
  check(`${t} Stage 2 → FINAL_REVIEW`, (await local())?.status === 'FINAL_REVIEW');
  await tid('sent-view-status').click();
  await visible('screen-status');
  await shot('47-status-final-review');
  check(`${t} final review headline`, (await tid('status-headline').innerText()) === 'Final review');
  const db = await server();
  const app = Object.values(db.applications)[0];
  check(`${t} no automatic approval after Stage 2`, app.status === 'FINAL_REVIEW' && app.decisionAt === null);
  check(`${t} still no membership`, Object.keys(db.memberships).length === 0);
  check(`${t} one extended submission recorded`, db.audit.filter((e) => e.eventType === 'EXTENDED_APPLICATION_SUBMITTED').length === 1);
  const after2 = await local();
  check(`${t} device cleared of extended answers`, after2.extendedDraft.photos.length === 0 && after2.extendedDraft.aboutYou === null);
  check(`${t} device cleared of dating preferences`, after2.extendedDraft.datingPreferences.meet.length === 0 && after2.extendedDraft.datingPreferences.ageRange === null);
  const prefsRecord = Object.values(db.datingPreferences ?? {})[0];
  check(`${t} dating preferences stored privately only when Dating chosen`, d.intents.includes('dating') ? prefsRecord?.ageRange?.min === d.age.expect[0] : !prefsRecord);
  check(`${t} dating preferences never in application data`, !JSON.stringify(db.privateData).includes('ageRange'));
  await page.goto(base + '/member');
  await visible('screen-status', 12000);
  check(`${t} FINAL_REVIEW cannot enter member area`, page.url().endsWith('/application/status'));
  await page.goto(base + '/extended/photos');
  await visible('screen-status', 12000);
  check(`${t} extended application locked after submission`, page.url().endsWith('/application/status'));
}
