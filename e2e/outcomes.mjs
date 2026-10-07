/**
 * Review outcomes end to end — continues from the FINAL_REVIEW page left by
 * e2e/stage2.mjs. Every reviewer change goes through the development reviewer
 * fixture (`__velvetDev.review`), i.e. the mock server's validated, audited
 * reviewer endpoint. The app only ever refreshes and renders the result.
 *
 *   FINAL_REVIEW → MORE_INFORMATION_REQUIRED (replace a photo) → answered → FINAL_REVIEW
 *   → WAITLISTED (restart, member area blocked) → reopened → FINAL_REVIEW
 *   ├─ (this page)   → APPROVED → Continue → Membership → Activate (fixture billing) → member area
 *   └─ (saved state) → NOT_ADMITTED
 */
import { resolve } from 'node:path';

// photo-1 was removed during Stage 2 in every run, so it is a genuinely new photo here.
const REPLACEMENT = resolve('e2e/fixtures/photo-1.jpg');

export async function outcomes(base, run, p, check, openWithStorage) {
  const t = `[${run.name}]`;
  const { page, tid, visible, shot, local, server } = p;

  const review = (action) =>
    page.evaluate(async (a) => {
      const s = JSON.parse(localStorage.getItem('velvet.admission.v1'));
      await globalThis.__velvetDev.review(s.session.userId, a);
    }, action);
  const refreshed = async (headline) => {
    await tid('status-refresh').click();
    await page.getByText(headline).first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
  };
  const memberBlocked = async (label, expectScreen = 'screen-status') => {
    await page.goto(base + '/member');
    await visible(expectScreen, 12000);
    check(`${t} ${label}: member area blocked`, !/\/member$/.test(new URL(page.url()).pathname));
  };
  const snapshotStorage = () =>
    page.evaluate(() => ({
      admission: localStorage.getItem('velvet.admission.v1'),
      server: localStorage.getItem('velvet.mockServer.v1'),
    }));

  // --- MORE_INFORMATION_REQUIRED ------------------------------------------------
  const first = await page.evaluate(async () => {
    const db = await globalThis.__velvetDev.snapshot();
    return Object.values(db.media)
      .filter((m) => m.purpose !== 'verification' && !m.retiredAt && m.order >= 0)
      .sort((a, b) => a.order - b.order)[0].id;
  });
  await review({ kind: 'REQUEST_INFORMATION', requests: [{ preset: 'PHOTO_NEEDS_UPDATE', mediaId: first }] });
  await refreshed('We need a little more information.');
  await shot('50-more-info');
  const moreInfo = await tid('screen-status').innerText();
  check(`${t} more-info: kicker is an application update`, (await tid('status-kicker').innerText()) === 'Application update');
  check(`${t} more-info: structured request shown`, moreInfo.includes('Replace a photo') && moreInfo.includes('One of your photos needs to be updated'));
  check(`${t} more-info: no reviewer identity or reason`, !/dev-fixture|reviewer|reason/i.test(moreInfo));
  check(`${t} more-info: primary action is the task`, (await tid('request-primary').innerText()) === 'Update photo');

  await tid('request-primary').click();
  await visible('screen-request');
  await shot('51-request-photo');
  const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
  await tid('request-choose-photo').click();
  await (await chooser).setFiles([REPLACEMENT]);
  await visible('request-new-photo', 15000);
  await shot('52-request-photo-chosen');
  await tid('request-done').click();
  await visible('screen-status');
  await visible('request-submit');
  await shot('53-more-info-ready');
  check(`${t} more-info: request ready to send`, await tid('request-ready-REPLACE_PHOTO').isVisible());
  // Nothing else in the application can be opened while answering.
  await page.goto(base + '/apply/first-name');
  await visible('screen-status', 12000);
  check(`${t} more-info: Stage 1 stays locked`, page.url().endsWith('/application/status'));
  await page.goto(base + '/extended/occupation');
  await visible('screen-status', 12000);
  check(`${t} more-info: Stage 2 stays locked`, page.url().endsWith('/application/status'));
  await visible('request-submit');
  await tid('request-submit').click();
  await page.getByText('Final review').first().waitFor({ timeout: 10000 });
  await visible('update-sent');
  await shot('54-more-info-resolved');
  check(`${t} more-info: returned to final review`, (await local()).status === 'FINAL_REVIEW');
  let db = await server();
  const req = Object.values(db.informationRequests)[0];
  check(`${t} more-info: request resolved server-side`, req.status === 'resolved' && req.resolvedAt !== null);
  check(`${t} more-info: audited`, db.audit.some((e) => e.eventType === 'MORE_INFORMATION_REQUESTED') && db.audit.at(-1).eventType === 'MORE_INFORMATION_PROVIDED');
  check(`${t} more-info: update fact shown`, await tid('status-update-received').isVisible());

  // --- WAITLISTED -----------------------------------------------------------------
  await review({ kind: 'WAITLIST', reason: 'CAPACITY' });
  await refreshed('You’re on the waitlist');
  await shot('55-waitlisted');
  const wl = await tid('screen-status').innerText();
  check(`${t} waitlist: calm, no queue or odds`, !/queue|position|ahead of you|%|probab|estimated|countdown|skip/i.test(wl));
  check(`${t} waitlist: no stage line, no big action`, (await page.locator('[data-testid="status-stages"]:visible').count()) === 0 && (await page.locator('[data-testid="status-primary"]:visible').count()) === 0);
  check(`${t} waitlist: identity and submitted date shown`, wl.includes(run.first) && (await tid('status-submitted-on').isVisible()));
  check(`${t} waitlist: reason code never shown`, !wl.includes('CAPACITY'));
  await page.reload();
  await visible('screen-status', 12000);
  check(`${t} waitlist: survives restart`, (await tid('status-headline').innerText()) === 'You’re on the waitlist');
  await memberBlocked('waitlist');
  await page.goto(base + '/member/home');
  await visible('screen-status', 12000);
  check(`${t} waitlist: member home closed`, page.url().endsWith('/application/status'));
  await review({ kind: 'REOPEN', to: 'FINAL_REVIEW' });
  await refreshed('Final review');
  check(`${t} waitlist: reopened into final review`, (await local()).status === 'FINAL_REVIEW');
  await shot('56-final-review-before-decision');

  // Save this FINAL_REVIEW state for the other decision.
  const saved = await snapshotStorage();

  // --- APPROVED → membership --------------------------------------------------------
  await review({ kind: 'APPROVE', reason: 'COMMUNITY_FIT' });
  await tid('status-refresh').click();
  await visible('screen-approved', 10000);
  await page.waitForTimeout(run.reducedMotion === 'reduce' ? 200 : 700);
  await shot('57-approved');
  const welcome = await tid('screen-approved').innerText();
  check(`${t} approved: "Welcome." and approval sentence`, welcome.includes('Welcome.') && welcome.includes('Your membership application has been approved.'));
  check(`${t} approved: no celebration language`, !/congrat|elite|vip|made it|!/i.test(welcome));
  await memberBlocked('approved', 'screen-approved');
  await tid('status-primary').click();
  await visible('screen-membership', 10000);
  await visible('membership-price', 10000);
  await shot('58-membership');
  const ms = await tid('screen-membership').innerText();
  check(`${t} membership: one plan named Membership`, ms.includes('Membership') && !/gold|platinum|diamond|vip|premium/i.test(ms));
  check(`${t} membership: fixture pricing labelled`, await tid('membership-fixture-note').isVisible());
  check(`${t} membership: state is payment required`, (await local()).status === 'MEMBERSHIP_PAYMENT_REQUIRED');
  await memberBlocked('membership before activation', 'screen-membership');
  // Every member route stays closed until activation, not only the entrance.
  for (const path of ['/member/home', '/member/messages', '/member/profile/me']) {
    await page.goto(base + path);
    await visible('screen-membership', 12000);
    check(`${t} membership: ${path} closed before activation`, new URL(page.url()).pathname === '/membership');
  }
  await visible('membership-price', 10000); // plan reloaded after the navigation
  await tid('membership-activate').click();
  await visible('screen-member', 12000);
  check(`${t} membership: activation opens the member area`, page.url().endsWith('/member') && (await local()).status === 'ACTIVE_MEMBER');
  db = await server();
  check(`${t} membership: activation audited`, db.audit.at(-1).eventType === 'MEMBERSHIP_ACTIVATED');
  check(`${t} audit: every reviewer change recorded with statuses`, db.audit
    .filter((e) => e.actorType === 'reviewer')
    .every((e) => e.applicationId && e.previousStatus && e.newStatus && e.createdAt));

  // --- NOT_ADMITTED (from the saved FINAL_REVIEW) -------------------------------------
  const q = await openWithStorage(saved);
  const qt = (id) => q.page.locator(`[data-testid="${id}"]:visible`).first();
  await qt('screen-status').waitFor({ timeout: 15000 });
  await q.page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('velvet.admission.v1'));
    await globalThis.__velvetDev.review(s.session.userId, { kind: 'NOT_ADMIT', reason: 'APPLICATION_QUALITY' });
  });
  await qt('status-refresh').click();
  await q.page.getByText('We’re unable to offer membership at this time.').first().waitFor({ timeout: 8000 });
  await q.page.waitForTimeout(400);
  await q.shot('59-not-admitted');
  const na = await qt('screen-status').innerText();
  check(`${t} not admitted: respectful wording`, !/reject|denied|fail|score|vote/i.test(na));
  check(`${t} not admitted: no reapplication promise`, !/reapply|months/i.test(na));
  check(`${t} not admitted: no reason shown`, !na.includes('APPLICATION_QUALITY'));
  await q.page.goto(base + '/member');
  await qt('screen-status').waitFor({ timeout: 12000 });
  check(`${t} not admitted: member area blocked`, q.page.url().endsWith('/application/status'));
  await q.page.goto(base + '/membership');
  await qt('screen-status').waitFor({ timeout: 12000 });
  check(`${t} not admitted: membership shell blocked`, q.page.url().endsWith('/application/status'));
  await q.page.goto(base + '/member/home');
  await qt('screen-status').waitFor({ timeout: 12000 });
  check(`${t} not admitted: member home closed`, q.page.url().endsWith('/application/status'));
  check(`${t} not admitted: no page errors`, q.errors.length === 0, q.errors.join(' | '));

  // Larger text (approximated on web by zooming the page) on the small screen.
  if (run.name === 'small') {
    await q.page.evaluate(() => {
      document.documentElement.style.zoom = '1.3';
    });
    await q.page.waitForTimeout(300);
    await q.shot('59b-not-admitted-zoom130');
  }
  await q.context.close();
}
