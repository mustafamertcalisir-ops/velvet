/**
 * The member vertical slice, end to end — continues from the member entrance
 * left by e2e/outcomes.mjs (membership just activated):
 *
 *   Welcome → Dating setup (Dating members only) → Profile confirmation
 *   → Home (today's introductions — Dating only) → Profile → Pass → Like (no
 *   match) → Like → Match → Conversation → Messages → You → Dating preferences
 *   → Edit profile → Privacy & safety → Membership → Report + Block
 *   → (small) block a match from the conversation
 *
 * Members not using Dating (the large run) skip Dating setup and see a quiet
 * Home: introductions are for Dating (DEC-058).
 *
 * The community is seeded through the development fixture (`seedCommunity`),
 * which uses the server's own provisioning, eligibility and reaction paths —
 * after Dating setup, because the admirer's like needs the member's stated
 * identity. Its photographs are QA fixtures served by this harness from
 * e2e/fixtures/members/ under /__qa/ — never bundled into the app (DEC-037, DEC-057).
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function fixtureMedia(base) {
  const files = readdirSync(resolve('e2e/fixtures/members')).filter((f) => f.endsWith('.jpg')).sort();
  const media = {};
  for (const f of files) {
    const key = f.replace(/-\d+\.jpg$/, '');
    (media[key] ??= []).push(`${base}/__qa/members/${f}`);
  }
  return media;
}

/** Words and marks the member product must never use. */
const NO_HYPE = /congrat|elite|vip|top match|hot pick|singles|compatib|%|super ?like|boost|streak|it.?s a match|!/i;
/** Dating setup language that must never appear on any profile, card or match screen. */
const DATING_PRIVATE = /How do you describe yourself|Who would you like to meet|Self-describe|Include me when|Looking to meet|Genderfluid/i;

export async function member(base, run, p, check) {
  const t = `[${run.name}]`;
  const { page, tid, visible, shot, local, server } = p;
  const dating = run.s2.dating ?? null;
  const settle = () => page.waitForTimeout(run.reducedMotion === 'reduce' ? 150 : 450);
  const text = async (id) => (await tid(id).innerText()).replace(/\s+/g, ' ');
  const checked = async (id) => (await page.locator(`[data-testid="${id}"][aria-checked="true"]:visible`).count()) > 0;
  const scrollBy = async (screens) => {
    await page.mouse.move(run.viewport.width / 2, run.viewport.height / 2);
    await page.mouse.wheel(0, run.viewport.height * screens);
    await settle();
  };
  const scrollTop = async () => {
    await page.mouse.move(run.viewport.width / 2, run.viewport.height / 2);
    await page.mouse.wheel(0, -run.viewport.height * 20);
    await settle();
  };
  const userId = (await local()).session.userId;

  // --- Member welcome -----------------------------------------------------------------------
  await page.goto(base + '/member');
  await visible('screen-member-welcome', 15000);
  await page.waitForTimeout(run.reducedMotion === 'reduce' ? 300 : 900);
  await shot('60-member-welcome');
  const welcome = await text('screen-member-welcome');
  check(`${t} welcome: restrained line`, welcome.includes('You’re in.') && !NO_HYPE.test(welcome));
  check(`${t} welcome: lives at the member entrance`, new URL(page.url()).pathname === '/member');
  let db = await server();
  const myMemberId = db.memberIdByUser[userId];
  check(`${t} activation provisioned one member profile`, Boolean(myMemberId) && Object.values(db.memberProfiles).filter((m) => m.userId === userId).length === 1);
  const priv = Object.values(db.privateData).find((d) => db.applications[userId]?.id === d.applicationId);
  check(
    `${t} Dating record only for Dating members, identity not inferred`,
    dating ? db.datingSettings[myMemberId]?.gender === null && db.datingSettings[myMemberId]?.setupCompletedAt === null : db.datingSettings[myMemberId] === undefined,
  );
  // Tabs are not open before the profile is confirmed.
  await page.goto(base + '/member/home');
  await visible('screen-member-welcome', 12000);
  check(`${t} home waits for profile confirmation`, new URL(page.url()).pathname === '/member');
  await tid('welcome-continue').click();

  // --- Dating setup (Dating members only) ---------------------------------------------------------
  if (dating) {
    await visible('screen-dating-setup', 10000);
    await visible('choice-WOMAN');
    await settle();
    await shot('60b-dating-identity');
    const setup = await text('screen-dating-setup');
    check(`${t} dating setup: asked after activation, four answers`, setup.includes('How do you describe yourself?') && ['Woman', 'Man', 'Non-binary', 'Self-describe'].every((s) => setup.includes(s)));
    // Continue is disabled until the member answers (nothing is preselected or inferred) — a real
    // disabled state on web: a native <button disabled aria-disabled="true">, skipped by Tab, inert to Enter.
    const cont = page.locator('[data-testid="dating-continue"]:visible').first();
    const state = () => cont.evaluate((el) => ({ tag: el.tagName, disabled: el.disabled === true, aria: el.getAttribute('aria-disabled') }));
    check(`${t} dating setup: Continue is a disabled button for assistive tech`, JSON.stringify(await state()) === JSON.stringify({ tag: 'BUTTON', disabled: true, aria: 'true' }), JSON.stringify(await state()));
    await cont.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check(`${t} dating setup: the disabled Continue takes no focus and Enter does nothing`, !(await cont.evaluate((el) => el === document.activeElement)));
    check(
      `${t} dating setup: nothing preselected (never inferred)`,
      !(await checked('choice-WOMAN')) && !(await checked('choice-MAN')) && !(await checked('choice-NON_BINARY')) && !(await checked('choice-SELF_DESCRIBED')) &&
        (await page.locator('[data-testid="screen-dating-seeking"]:visible').count()) === 0,
    );
    if (dating.self) {
      await tid('choice-SELF_DESCRIBED').click();
      await visible('dating-self-description', 5000);
      await p.fillInput('dating-self-description', dating.self);
      check(`${t} self-describe: categories required to continue (Continue disabled)`, (await state()).disabled);
      await page.waitForTimeout(100);
      check(`${t} self-describe: nothing moves on without categories`, (await page.locator('[data-testid="screen-dating-seeking"]:visible').count()) === 0);
      for (const c of dating.appears) await tid(`choice-appears_${c}`).click();
      await settle();
      await shot('60c-dating-self-describe');
      const selfText = await text('screen-dating-setup');
      check(`${t} self-describe: private words, chosen categories`, selfText.includes('Include me when people are looking to meet') && /private/i.test(selfText));
    } else {
      await tid(`choice-${dating.gender}`).click();
      await settle();
    }
    // Answered: enabled, reachable by keyboard, and Enter activates it.
    check(`${t} dating setup: Continue enabled once answered`, JSON.stringify(await state()) === JSON.stringify({ tag: 'BUTTON', disabled: false, aria: null }), JSON.stringify(await state()));
    await cont.focus();
    check(`${t} dating setup: keyboard focus reaches the enabled Continue`, await cont.evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Enter');
    await visible('screen-dating-seeking', 8000);
    await settle();
    await shot('60d-dating-seeking');
    const all = dating.seeking.length === 3;
    check(
      `${t} who to meet: pre-filled from the application`,
      (all ? await checked('choice-seek_EVERYONE') : !(await checked('choice-seek_EVERYONE'))) &&
        (await Promise.all(dating.seeking.map((c) => checked(`choice-seek_${c}`)))).every(Boolean),
    );
    check(`${t} age range: pre-filled from the application`, (await text('dating-age-range')).includes(String(dating.ages[0])) && (await text('dating-age-range')).includes(String(dating.ages[1])));
    await tid('dating-save').click();
  }

  // --- Profile confirmation -------------------------------------------------------------------
  await visible('screen-confirm', 10000);
  await visible('preview-name');
  db = await server();
  if (dating) {
    const s = db.datingSettings[myMemberId];
    check(
      `${t} dating settings stored privately on the server`,
      s?.setupCompletedAt !== null &&
        (dating.self ? s.gender === 'SELF_DESCRIBED' && s.selfDescription === dating.self && JSON.stringify(s.appearsAs) === JSON.stringify(dating.appears) : s.gender === dating.gender) &&
        JSON.stringify(s.seeking) === JSON.stringify(dating.seeking) && s.ageRange.min === dating.ages[0] && s.ageRange.max === dating.ages[1],
    );
  }
  // Seed the fixture community now (dev only; real server paths, including eligibility).
  const seeded = await page.evaluate(
    async ({ media, uid }) => globalThis.__velvetDev.seedCommunity({ media, admirerOf: uid }),
    { media: fixtureMedia(base), uid: userId },
  );
  check(`${t} admirer liked only an eligible Dating member`, seeded.admirerLiked === Boolean(dating));
  await settle();
  await shot('61-profile-confirmation');
  const confirmText = await text('screen-confirm');
  check(`${t} confirmation: first name and age`, (await tid('preview-name').innerText()) === run.first && (await tid('preview-age').innerText()) === '32');
  check(`${t} confirmation: known for and interests`, confirmText.includes('Known for') && confirmText.includes(run.s2.interests[0][1]));
  check(`${t} confirmation: no surname, DOB, Instagram, phone or referral`,
    !confirmText.includes(run.last) && !confirmText.includes('1994') && !confirmText.includes(run.instagram.replace(/^@/, '').split('/')[0]) &&
    !/532 ?123|5321234567/.test(confirmText) && (!run.referral || !confirmText.includes(run.referral.name)));
  check(`${t} confirmation: Dating identity and preferences never on the profile`, !DATING_PRIVATE.test(confirmText) && !(dating?.self && confirmText.includes(dating.self)));
  await scrollBy(0.75);
  await shot('61b-profile-confirmation-scrolled');
  check(`${t} confirmation: privacy line`, (await text('confirm-privacy')).includes('never your last name'));
  await tid('confirm-enter').click();

  // --- Home ------------------------------------------------------------------------------------------
  await visible('screen-home', 12000);
  const tabs = await tid('member-tabs').innerText();
  check(`${t} navigation: Home, Messages, You only`, /Home/.test(tabs) && /Messages/.test(tabs) && /You/.test(tabs) && !/Places|Travel|Directory/.test(tabs));
  db = await server();
  check(`${t} profile confirmed on the server`, db.memberProfiles[myMemberId]?.confirmedAt !== null);
  const deviceKeys = await page.evaluate(() => Object.keys(localStorage).sort());
  check(`${t} member data not written to the device`, JSON.stringify(deviceKeys) === JSON.stringify(['velvet.admission.v1', 'velvet.mockServer.v1']) && !JSON.stringify(await local()).includes('Kerem'));

  if (!dating) {
    // Introductions are for Dating (DEC-058): a quiet Home, nobody introduced either way.
    await visible('home-not-dating', 12000);
    await settle();
    await shot('62-home-not-dating');
    const home = await text('screen-home');
    check(
      `${t} home: Dating introductions aren't part of the experience; more community later, no date promised`,
      home.includes('Dating introductions aren’t part of your experience right now.') &&
        home.includes('More community experiences will come later.') &&
        !/nothing for you|soon|launch|coming in|\b20\d\d\b/i.test(home) &&
        !NO_HYPE.test(home),
    );
    check(
      `${t} not introduced to anyone, and introduced to no one`,
      !Object.values(db.introductionBatches).some((b) => b.memberId === myMemberId) && !Object.values(db.introductionEntries).some((e) => e.candidateId === myMemberId),
    );
    await page.goto(base + '/member/messages');
    await visible('screen-messages', 12000);
    await visible('messages-empty', 10000);
    check(`${t} messages: empty without matches`, (await text('screen-messages')).includes('No conversations yet.'));
  } else {
    await visible('home-introduction', 12000);
    await settle();
    await shot('62-home');
    db = await server(); // the batch exists once Home has asked for it
    const home = await text('screen-home');
    check(`${t} home: first introduction is a person`, (await tid('home-name').innerText()) === dating.introductions[0]);
    check(`${t} home: today's introductions, no count or hype`, home.includes('Today’s introductions') && home.includes('More to come today') && !/\b\d+\s+(more|left|remaining|introductions)\b/i.test(home) && !NO_HYPE.test(home));
    const batch = Object.values(db.introductionBatches).find((b) => b.memberId === myMemberId);
    const names = (batch?.profileIds ?? []).map((id) => db.memberProfiles[id]?.displayName);
    check(`${t} introductions: exactly the compatible members, in curated order`, JSON.stringify(names) === JSON.stringify(dating.introductions), names.join(', '));
    check(`${t} introductions: finite batch, unique, never self`, batch && batch.profileIds.length <= 6 && new Set(batch.profileIds).size === batch.profileIds.length && !batch.profileIds.includes(myMemberId));

    // --- Profile (Kerem) → Pass ---------------------------------------------------------------------
    await tid('home-open').click();
    await visible('screen-profile', 10000);
    await visible('decision-like');
    await settle();
    await shot('63-profile');
    const profileText = await text('screen-profile');
    check(`${t} profile: identity, known for and interests`, profileText.includes('Kerem') && profileText.includes('Rowing coach') && profileText.includes('İstanbul') && profileText.includes('Running, Swimming and Live music'));
    check(`${t} profile: no private member data`, !/Yalçınkaya|1994-11|\+90500|fixture|usr_/.test(profileText) && !DATING_PRIVATE.test(profileText));
    check(`${t} profile: only pass and like`, (await page.locator('[data-testid^="decision-"]:visible').count()) === 2 && !NO_HYPE.test(profileText));
    await scrollBy(0.75);
    await shot('64-profile-scrolled');
    await scrollBy(1.2);
    await shot('64b-profile-column');
    await scrollTop();
    await tid('decision-pass').click();
    await visible('outcome-passed', 8000);
    await settle();
    await shot('65-pass');
    db = await server();
    check(`${t} pass recorded against the introduction, no match`, Object.values(db.reactions).some((r) => r.fromMemberId === myMemberId && r.type === 'PASS' && r.introductionId) && Object.keys(db.matches).length === 0);
    await tid('outcome-next').click();

    // --- Profile (Selin) → Like, no match -----------------------------------------------------------
    await visible('home-introduction', 10000);
    await settle();
    check(`${t} passed introduction left today's set`, (await tid('home-name').innerText()) === 'Selin');
    await tid('home-open').click();
    await visible('decision-like', 10000);
    await tid('decision-like').click();
    await visible('outcome-liked', 8000);
    await settle();
    await shot('66-like');
    check(`${t} like: honest outcome`, (await text('outcome-liked')).includes('If Selin likes you too'));
    db = await server();
    check(`${t} like alone creates no match`, Object.keys(db.matches).length === 0 && Object.values(db.reactions).some((r) => r.fromMemberId === myMemberId && r.type === 'LIKE'));
    await tid('outcome-next').click();

    // --- Profile (Deniz) → Like → mutual match --------------------------------------------------
    await visible('home-introduction', 10000);
    await settle();
    check(`${t} third introduction is the admirer fixture`, (await tid('home-name').innerText()) === 'Deniz');
    await shot('67-home-next');
    await tid('home-open').click();
    await visible('decision-like', 10000);
    await tid('decision-like').click();
    await visible('screen-match', 10000);
    await visible('match-headline', 10000);
    await page.waitForTimeout(run.reducedMotion === 'reduce' ? 300 : 900);
    await shot('68-match');
    const matchText = await text('screen-match');
    check(`${t} match: restrained moment, both photographs`, matchText.includes('You should meet.') && matchText.includes('You and Deniz both said yes.') && !NO_HYPE.test(matchText) && (await tid('match-their-photo').isVisible()) && (await tid('match-your-photo').isVisible()));
    check(`${t} match: no Dating identity or preferences`, !DATING_PRIVATE.test(matchText));
    db = await server();
    check(`${t} exactly one match, created by the server`, Object.keys(db.matches).length === 1 && Object.values(db.matches)[0].memberIds.includes(myMemberId));

    // --- Conversation ----------------------------------------------------------------------------
    if (run.name === 'small') {
      // "Keep exploring" returns to today's introductions; the match waits in Messages.
      await tid('match-keep').click();
      await visible('home-introduction', 10000);
      check(`${t} keep exploring returns to introductions`, (await tid('home-name').innerText()) !== 'Deniz');
      await tid('tab-messages').click();
      await visible('conversation-row-Deniz', 10000);
      check(`${t} new match is marked new in Messages`, await tid('conversation-unread').isVisible());
      await tid('conversation-row-Deniz').click();
    } else {
      await tid('match-send').click();
    }
    await visible('screen-conversation', 10000);
    await visible('conversation-empty', 10000);
    await settle();
    await shot('69-conversation-empty');
    check(`${t} empty conversation: one quiet line, no prompts`, (await text('conversation-empty')).includes('You met through the community.') && !/icebreaker|ask (her|him|them)|try saying/i.test(await text('screen-conversation')));
    await tid('composer-input').fill('Merhaba Deniz. I walk past the Tophane warehouse every week — is the reading room open yet?');
    await tid('composer-send').click();
    await visible('message-self', 8000);
    await page.waitForFunction(() => !document.querySelector('[data-testid="message-sending"]'), null, { timeout: 8000 });
    db = await server();
    const conversation = Object.values(db.conversations)[0];
    check(`${t} message stored once, in the match's conversation`, Object.values(db.messages).length === 1 && conversation?.matchId === Object.values(db.matches)[0].id);
    await page.evaluate(async (uid) => {
      await new Promise((r) => setTimeout(r, 1100));
      await globalThis.__velvetDev.memberSays('deniz', uid, 'Not yet — the roof goes on in November. Come and see the light before then?');
    }, userId);
    await tid('composer-input').fill('Gladly. Thursday after six?');
    await tid('composer-send').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="message-sending"]'), null, { timeout: 8000 });

    // --- Messages ---------------------------------------------------------------------------------
    await tid('conversation-back').click();
    await page.goto(base + '/member/messages');
    await visible('screen-messages', 12000);
    await visible('conversation-row-Deniz', 10000);
    await settle();
    await shot('70-messages');
    check(`${t} messages: the match is listed with its last message`, (await text('conversation-row-Deniz')).includes('Gladly. Thursday after six?'));
    await tid('conversation-row-Deniz').click();
    await visible('screen-conversation', 10000);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="message-other"]').length >= 1, null, { timeout: 8000 });
    await settle();
    await shot('71-conversation');
    const convText = await text('screen-conversation');
    check(`${t} conversation: both sides, grouped by day with times`, convText.includes('Today') && convText.includes('the roof goes on in November') && /\d{2}:\d{2}/.test(convText));
    check(`${t} conversation: no read receipts or typing indicators`, !/seen|read \d|typing/i.test(convText));
    await tid('conversation-profile').click();
    await visible('screen-profile', 10000);
    check(`${t} matched profile opens without pass/like`, (await page.locator('[data-testid^="decision-"]:visible').count()) === 0);
    await page.goBack();
    await visible('screen-conversation', 10000);
  }

  // --- You → Dating preferences → Edit profile → Privacy → Membership ----------------------------
  await page.goto(base + '/member/you');
  await visible('screen-you', 12000);
  await visible('you-name', 12000);
  await settle();
  await shot('72-you');
  const you = await text('screen-you');
  check(`${t} you: profile, edit, membership, privacy`, ['View your profile', 'Edit profile', 'Membership', 'Privacy & safety'].every((s) => you.includes(s)));
  check(`${t} you: Dating preferences only for Dating members`, (await page.locator('[data-testid="you-dating"]:visible').count()) === (dating ? 1 : 0));

  if (dating) {
    await tid('you-dating').click();
    await visible('screen-dating-preferences', 10000);
    await visible('dating-row-seeking', 10000);
    await settle();
    await shot('72b-dating-preferences');
    const prefs = await text('screen-dating-preferences');
    check(`${t} dating preferences: own settings, marked private`, prefs.includes(dating.self ?? 'Woman') && prefs.includes(`${dating.ages[0]} to ${dating.ages[1]}`) && /only you|private|never shown/i.test(prefs));
    if (run.name === 'standard') {
      // Change who to meet: affects introductions from now on; the match and conversation stay.
      await tid('dating-change').click();
      await visible('screen-dating-setup', 10000);
      check(`${t} edit: no onboarding progress`, (await page.locator('[data-testid="progress-folio"]:visible').count()) === 0);
      await tid('dating-continue').click();
      await visible('screen-dating-seeking', 8000);
      await tid('choice-seek_MAN').click();
      await settle();
      await shot('72c-dating-preferences-edit');
      await tid('dating-save').click();
      await visible('screen-dating-preferences', 10000);
      await page.waitForFunction(() => !/and men/.test(document.querySelector('[data-testid="dating-row-seeking"]')?.textContent ?? 'and men'), null, { timeout: 8000 });
      db = await server();
      check(`${t} edit: saved on the server`, JSON.stringify(db.datingSettings[myMemberId].seeking) === JSON.stringify(['WOMAN']));
      check(`${t} edit: the match and its conversation remain`, Object.values(db.matches).filter((m) => m.endedAt === null).length === 1 && Object.values(db.messages).length >= 2);
      await page.goto(base + '/member/messages');
      await visible('conversation-row-Deniz', 12000);
      check(`${t} edit: conversation still listed`, true);
    }
    await page.goto(base + '/member/you');
    await visible('screen-you', 12000);
    await visible('you-name', 12000);
  }

  db = await server();
  const applicationMediaBefore = JSON.stringify(db.media);
  const leadBefore = Object.values(db.memberMedia).filter((m) => m.memberProfileId === myMemberId && m.order >= 0).sort((a, b) => a.order - b.order);
  await tid('you-edit').click();
  await visible('screen-edit-profile', 10000);
  await visible('edit-photo-0', 10000);
  await settle();
  await shot('73-edit-profile');
  await tid('edit-photo-1').click();
  await visible('photo-make-first', 5000);
  await tid('photo-make-first').click();
  await page.waitForTimeout(400);
  const newOccupation = 'Architect';
  await p.fillInput('edit-occupation', newOccupation);
  await settle();
  await shot('74-edit-profile-changed');
  await tid('edit-save').click();
  await visible('screen-you', 10000);
  await page.getByText(newOccupation).first().waitFor({ timeout: 8000 });
  await settle();
  db = await server();
  const after = db.memberProfiles[myMemberId];
  const privAfter = Object.values(db.privateData).find((d) => d.applicationId === priv.applicationId);
  check(`${t} edit: public profile updated`, after.occupation === newOccupation && (await text('screen-you')).includes(newOccupation));
  check(`${t} edit: application record untouched`, privAfter.occupation === run.s2.occupation && privAfter.lastName === run.last);
  const leadAfter = Object.values(db.memberMedia).filter((m) => m.memberProfileId === myMemberId && m.order >= 0).sort((a, b) => a.order - b.order);
  check(`${t} edit: photo order changed on the member profile only`, leadAfter[0]?.id === leadBefore[1]?.id && JSON.stringify(db.media) === applicationMediaBefore);
  await tid('you-privacy').click();
  await visible('screen-privacy', 10000);
  await settle();
  await shot('75-privacy');
  check(`${t} privacy: what members never see`, (await text('screen-privacy')).includes('What members never see'));
  await page.goBack();
  await visible('screen-you', 10000);
  await tid('you-membership').click();
  await visible('screen-member-membership', 10000);
  await settle();
  await shot('76-membership');
  const ms = await text('screen-member-membership');
  check(`${t} membership: one plan, active, no tiers`, ms.includes('Membership') && ms.includes('Active') && !/gold|platinum|diamond|vip|premium/i.test(ms));
  await page.goBack();
  await visible('screen-you', 10000);

  // --- Safety: report and block from a profile (Dating members have introductions) -------------
  if (dating) {
    await page.goto(base + '/member/home');
    await visible('home-introduction', 12000);
    const reportedName = await tid('home-name').innerText();
    await tid('home-open').click();
    await visible('profile-more', 10000);
    await tid('profile-more').click();
    await visible('safety-report', 5000);
    await settle();
    await shot('77-safety');
    await tid('safety-report').click();
    await visible('report-reason-NOT_GENUINE', 5000);
    await settle();
    await shot('78-report-reasons');
    await tid('report-reason-NOT_GENUINE').click();
    await visible('report-done', 8000);
    await tid('report-also-block').click();
    await visible('block-confirm', 5000);
    await settle();
    await shot('79-block-confirm');
    await tid('block-confirm').click();
    await visible('screen-home', 10000);
    await page.waitForTimeout(600);
    db = await server();
    const reportedId = Object.values(db.memberProfiles).find((m) => m.displayName === reportedName)?.id;
    check(`${t} report recorded with a structured reason`, Object.values(db.reports).some((r) => r.reporterId === myMemberId && r.reportedId === reportedId && r.reason === 'NOT_GENUINE'));
    check(`${t} blocked member left today's introductions`, Object.values(db.blocks).some((b) => b.blockerId === myMemberId && b.blockedId === reportedId) && (await page.locator('[data-testid="home-name"]:visible').count() === 0 || (await tid('home-name').innerText()) !== reportedName));
    await page.goto(base + `/member/profile/${reportedId}`);
    await visible('screen-profile-unavailable', 10000);
    check(`${t} blocked profile is simply unavailable`, (await text('screen-profile-unavailable')).includes('no longer available'));
  }

  // --- Block a match from the conversation (small run) ------------------------------------------
  if (run.name === 'small') {
    const matchId = Object.values(db.matches)[0].id;
    await page.goto(base + `/member/conversation/${matchId}`);
    await visible('conversation-more', 12000);
    await tid('conversation-more').click();
    await tid('safety-block').click();
    await tid('block-confirm').click();
    await visible('screen-messages', 10000);
    await visible('messages-empty', 10000);
    check(`${t} block ends the conversation and removes it`, (await text('screen-messages')).includes('No conversations yet.'));
    const refused = await page.evaluate(async (uid) => {
      try {
        await globalThis.__velvetDev.memberSays('deniz', uid, 'Are you there?');
        return false;
      } catch {
        return true;
      }
    }, userId);
    check(`${t} blocked match cannot send new messages`, refused);
    db = await server();
    check(`${t} block keeps the records (match ended, messages kept)`, Object.values(db.matches)[0].endedAt !== null && Object.values(db.messages).length >= 2);
    await page.goto(base + `/member/conversation/${matchId}`);
    await visible('conversation-closed', 10000);
    check(`${t} closed conversation says so plainly`, (await text('conversation-closed')).includes('no longer available'));
  }

  // --- The standard run deletes its account; the others sign out -----------------------------------
  await page.goto(base + '/member/you');
  await visible('screen-you', 12000);
  if (run.name === 'standard') {
    // You → Privacy & safety → Delete account (DEC-077)
    await tid('you-privacy').click();
    await visible('screen-privacy', 10000);
    await tid('privacy-delete-account').scrollIntoViewIfNeeded();
    await tid('privacy-delete-account').click();
    await visible('screen-delete-account', 10000);
    await settle();
    await shot('80-delete-account');
    const explain = await text('screen-delete-account');
    check(`${t} delete: consequences stated plainly`, explain.includes('removed from the community') && explain.includes('signed out on every device') && explain.includes('can’t be undone'));
    check(`${t} delete: retained records stated, no legal promises beyond the policy`, explain.includes('Some records may be retained where needed for safety, security or legal obligations.') && !/permanently erased|all your data|immediately deleted|GDPR|KVKK|guarantee/i.test(explain));
    check(`${t} delete: nothing deleted before the confirmation`, (await server()).accounts[userId].accountStatus === 'active');
    await tid('delete-account-start').click();
    await visible('delete-account-confirm', 5000);
    await settle();
    await shot('81-delete-account-confirm');
    check(`${t} delete: confirmation offers a clear way back`, (await text('delete-account-cancel')).includes('Keep my account'));
    await tid('delete-account-cancel').click();
    check(`${t} delete: "Keep my account" changes nothing`, (await page.locator('[data-testid="delete-account-confirm"]:visible').count()) === 0 && (await server()).accounts[userId].accountStatus === 'active');
    const token = (await local()).session.token;
    await tid('delete-account-start').click();
    await visible('delete-account-confirm-button', 5000);
    await tid('delete-account-confirm-button').click();
    await visible('screen-launch', 12000);
    await visible('launch-account-deleted', 5000);
    await shot('82-account-deleted');
    db = await server();
    check(`${t} delete: account deactivated on the server`, db.accounts[userId].accountStatus === 'deleted');
    check(`${t} delete: every session revoked`, !Object.values(db.sessions).includes(userId) && db.sessions[token] === undefined);
    check(`${t} delete: device cleared`, (await local())?.session == null);
    await page.goto(base + '/member/home');
    await visible('screen-launch', 12000);
    check(`${t} delete: member routes closed`, !new URL(page.url()).pathname.startsWith('/member'));
  } else {
    const token = (await local()).session.token;
    await tid('you-sign-out').click();
    await visible('screen-launch', 12000);
    check(`${t} sign out: the server session is revoked too`, (await server()).sessions[token] === undefined);
    await page.goto(base + '/member/home');
    await visible('screen-launch', 12000);
    check(`${t} signed out: member routes closed`, !new URL(page.url()).pathname.startsWith('/member'));
  }
  check(`${t} no page errors (member)`, p.errors.length === 0, p.errors.join(' | '));
}
