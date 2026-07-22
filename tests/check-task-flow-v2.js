/* Acceptance suite for TSK-011/012/013 — the Task-flow (pipeline) redesign
 * on top of TSK-014's 4-stage model: chip-rail progress underline, the new
 * card badges (note/attempt/deadline chip/pending banner/package progress),
 * the 3-button action row (Cancel/Redo/Advance), and the 9-variant inline
 * stage-gate card (see app.js's STAGE-GATE INLINE CARD section).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-task-flow-v2.js
 * Expects http://localhost:9003 serving ../app (harness pattern copied from
 * tests/check-scheduling.js / tests/check-ux-flow.js).
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:9003';
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // ── Register a fresh account ─────────────────────────────────────────
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'tflow2' + Date.now());
  await page.fill('#auth-name', 'Flow Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // EN so string assertions can compare against the EN dict.
  await page.evaluate(async () => { await onLangChange('en'); renderPipeline(); });
  await page.waitForTimeout(200);

  // In-page factories — window props die on page.reload(), re-installed
  // after the one reload this suite does (§5).
  const installHelpers = () => page.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'Flow Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'Flow Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Flow Client', clientId: window.__cid,
        serviceId: null, serviceName: 'Flow svc', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, outcome: null, invoiceId: null, quoteDocId: null,
        packageId: null, due: null, note: null, attempt: 1, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkJob = (stage, extra) => page.evaluate(args => window.__mkJob(args[0], args[1]), [stage || null, extra || null]);
  const job = (id, expr) => page.evaluate(args => {
    const j = jobs.find(x => x.id === args[0]);
    return eval(args[1]);
  }, [id, expr]);
  const goto = (stage) => page.evaluate(s => { switchScreen('pipeline'); setPipelineView('board'); selectPipelineStage(s); }, stage);

  // ═══ 1. Chip rail: counts + progress-underline colors per stage ═════════
  await mkJob('inquiry');
  await mkJob('inquiry');
  await mkJob('quote');
  await mkJob('booked');
  await goto('booked');
  await page.waitForTimeout(300);
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll('#pipeline-body .pl-chip')).map(c => ({
    active: c.classList.contains('active'),
    count: c.querySelector('.pl-chip-count').textContent,
    underline: c.querySelector('.pl-chip-underline').className.replace('pl-chip-underline', '').trim(),
  })));
  assert(chips.length === 4, '1: 4 stage chips render, got ' + chips.length);
  assert(chips[0].count === '2', '1: Inquiry chip count is 2, got ' + chips[0].count);
  assert(chips[1].count === '1', '1: Quote chip count is 1, got ' + chips[1].count);
  assert(chips[2].count === '1', '1: Booked chip count is 1, got ' + chips[2].count);
  assert(chips[3].count === '0', '1: Deliver chip count is 0, got ' + chips[3].count);
  assert(chips[0].underline === 'past' && chips[1].underline === 'past',
    '1: stages before the selected one (Inquiry/Quote) show the "past" underline, got ' + JSON.stringify(chips));
  assert(chips[2].underline === 'active' && chips[2].active === true,
    '1: the selected stage (Booked) shows the "active" underline + active chip class, got ' + JSON.stringify(chips[2]));
  assert(chips[3].underline === '', '1: the stage after the selected one (Deliver) shows the plain (gray) underline, got "' + chips[3].underline + '"');

  // ═══ 2. Redo increments attempt and shows the badge ═════════════════════
  const redoJob = await mkJob('inquiry');
  await goto('inquiry');
  await page.waitForTimeout(300);
  const badgeBefore = await page.locator('.kb-card', { hasText: 'Flow svc' }).first().locator('.pl-attempt-badge').count();
  await page.evaluate(id => openGateCard(id, 'redo'), redoJob);
  await page.waitForTimeout(300);
  await page.fill(`#gate-note-${redoJob}`, 'Client went quiet');
  await page.click('.gate-btn-primary');   // "Save date"
  await page.waitForTimeout(400);
  const afterRedo = await job(redoJob, 'JSON.stringify({attempt:j.attempt, note:j.note, due:j.due})').then(JSON.parse);
  assert(afterRedo.attempt === 2, '2: Redo incremented job.attempt to 2, got ' + afterRedo.attempt);
  assert(afterRedo.note === 'Client went quiet', '2: Redo saved the note, got ' + afterRedo.note);
  assert(!!afterRedo.due, '2: Redo with a date set job.due');
  await page.waitForTimeout(300);
  const badgeCard = page.locator('.kb-card', { hasText: 'Client went quiet' });
  assert(await badgeCard.locator('.pl-attempt-badge').count() === 1, '2: card now shows the "Attempt 2" badge');
  const badgeTxt = await badgeCard.locator('.pl-attempt-badge').textContent();
  assert(badgeTxt.includes('2'), '2: badge text includes the attempt number, got ' + badgeTxt);

  // ═══ 3. Cancel sets lost and shows the note ══════════════════════════════
  const cancelJob = await mkJob('quote');
  await goto('quote');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'cancel'), cancelJob);
  await page.waitForTimeout(300);
  await page.fill(`#gate-note-${cancelJob}`, 'Price too high, walked away');
  await page.click('.gate-btn-danger');   // "Cancel job"
  await page.waitForTimeout(400);
  const afterCancel = await job(cancelJob, 'JSON.stringify({complete:j.complete, outcome:j.outcome, note:j.note})').then(JSON.parse);
  assert(afterCancel.complete === true && afterCancel.outcome === 'lost', '3: Cancel sets complete+lost, got ' + JSON.stringify(afterCancel));
  assert(afterCancel.note === 'Price too high, walked away', '3: Cancel saved the free-text note, got ' + afterCancel.note);
  const cancelledCard = await page.locator('.kb-card', { hasText: 'Flow svc' }).allTextContents();
  assert(cancelledCard.some(t => t.includes('Price too high, walked away')), '3: the note is visible on the (now-completed) card list somewhere');

  // ═══ 4. Postpone updates due date + clears overdue styling ═══════════════
  const postponeJob = await mkJob('booked', { due: '2020-01-01' });   // deliberately overdue
  await goto('booked');
  await page.waitForTimeout(300);
  const chipBefore = page.locator('.kb-card', { hasText: 'Flow svc' }).locator('.pl-deadline-chip.overdue');
  assert(await chipBefore.count() >= 1, '4: an overdue due date shows the red "Overdue" deadline chip');
  await page.evaluate(id => openGateCard(id, 'postpone'), postponeJob);
  await page.waitForTimeout(300);
  const newDate = await page.evaluate(() => addDaysISO(todayISO(), 14));
  await page.fill(`#gate-date-${postponeJob}`, newDate);
  await page.click('.gate-btn-primary');   // "Rebook"
  await page.waitForTimeout(400);
  assert(await job(postponeJob, 'j.due') === newDate, '4: Postpone updated job.due to the new date');
  const chipAfter = await page.evaluate(id => {
    const card = Array.from(document.querySelectorAll('.kb-card')).find(c => c.getAttribute('onclick') === `openEditJob(${id})`);
    const chip = card && card.querySelector('.pl-deadline-chip');
    return chip ? { overdue: chip.classList.contains('overdue'), text: chip.textContent } : null;
  }, postponeJob);
  assert(chipAfter && !chipAfter.overdue, '4: after postponing to a future date, the chip is no longer in the overdue state, got ' + JSON.stringify(chipAfter));

  // ═══ 5. No due date → pending banner → tapping opens the book gate ══════
  const pendingJob = await mkJob('inquiry');
  await goto('inquiry');
  await page.waitForTimeout(300);
  const pendingCard = page.locator('.kb-card', { hasText: 'Flow svc' }).filter({ has: page.locator('.pl-pending') }).first();
  assert(await pendingCard.count() === 1, '5: a job with no due date shows the pending banner');
  await pendingCard.locator('.pl-pending').click();
  await page.waitForTimeout(300);
  const gateOpenState = await page.evaluate(() => window.__gateOpen);
  assert(gateOpenState && gateOpenState.jobId === pendingJob, '5: tapping the pending banner opens that job\'s inline gate, got ' + JSON.stringify(gateOpenState));
  assert(await page.locator('.gate-card').count() === 1, '5: the inline gate card is now visible');
  await page.evaluate(() => closeGateCard());

  // ═══ 6. Package session-log advances pkg.used + shows the progress bar ══
  const pkgSetup = await page.evaluate(async () => {
    const pkgId = await dbAdd('packages', { uid: currentUser.id, cuid: cuid(), clientId: window.__cid,
      totalSessions: 3, price: 3000, purchasedDate: todayISO(), expiresAt: null, notes: '', createdAt: nowISO() });
    await reload();
    const jobId = await window.__mkJob('deliver', { packageId: pkgId, count: 1 });
    return { pkgId, jobId };
  });
  await goto('deliver');
  await page.waitForTimeout(300);
  const pkgCard = page.locator(`.kb-card[onclick="openEditJob(${pkgSetup.jobId})"]`);
  assert(await pkgCard.locator('.pl-pkg-progress').count() === 1, '6: package-linked card shows the progress bar');
  const progressLabelBefore = await pkgCard.locator('.pl-pkg-label').textContent();
  assert(progressLabelBefore.includes('1') && progressLabelBefore.includes('3'), '6: progress label shows "1 / 3", got ' + progressLabelBefore);
  const advanceLabel = await pkgCard.locator('.pl-action').textContent();
  assert(advanceLabel.includes('2') && advanceLabel.includes('3'), '6: primary button reads "Log session 2 of 3", got ' + advanceLabel);
  await pkgCard.locator('.pl-action').click();
  await page.waitForTimeout(400);
  const usedAfter = await page.evaluate(id => {
    const pkg = packages.find(p => p.id === id);
    return packageUsed(pkg);
  }, pkgSetup.pkgId);
  assert(usedAfter === 2, '6: logging a session bumped packageUsed() to 2, got ' + usedAfter);
  const sessionGateTitle = await page.evaluate(() => document.querySelector('.gate-title')?.textContent);
  assert(sessionGateTitle === 'Session delivered ✓', '6: mid-package log opens the "Session delivered" gate, got ' + sessionGateTitle);
  await page.click('.gate-btn-primary');   // book next session
  await page.waitForTimeout(400);
  const progressLabelAfter = await pkgCard.locator('.pl-pkg-label').textContent();
  assert(progressLabelAfter.includes('2') && progressLabelAfter.includes('3'), '6: progress label updated to "2 / 3", got ' + progressLabelAfter);

  // ═══ 7. Final session's "Send renewal quote" spawns a Quote-stage card ═══
  await pkgCard.locator('.pl-action').click();   // logs the 3rd (final) session
  await page.waitForTimeout(400);
  const finalGateTitle = await page.evaluate(() => document.querySelector('.gate-title')?.textContent);
  assert(finalGateTitle === 'Final session — package complete 🎉', '7: final session opens the pkg-final gate, got ' + finalGateTitle);
  const jobCountBefore = await page.evaluate(() => jobs.length);
  const renewalClientId = await page.evaluate(id => packages.find(p => p.id === id).clientId, pkgSetup.pkgId);
  await page.click('.gate-btn-primary');   // "Send renewal quote"
  await page.waitForTimeout(600);
  const renewalCheck = await page.evaluate(({ jobId, cid, before }) => {
    const orig = jobs.find(j => j.id === jobId);
    const renewal = jobs.find(j => j.clientId === cid && j.id !== jobId && jobStage(j) === 'quote' && !jobComplete(j));
    return { grew: jobs.length > before, origComplete: orig && orig.complete,
      renewalFound: !!renewal, renewalDue: renewal ? renewal.due : null };
  }, { jobId: pkgSetup.jobId, cid: renewalClientId, before: jobCountBefore });
  assert(renewalCheck.grew, '7: a new job record was created (verified via the jobs store), got ' + JSON.stringify(renewalCheck));
  assert(renewalCheck.origComplete, '7: the original package card completed');
  assert(renewalCheck.renewalFound, '7: the renewal card exists at the Quote stage, not complete, got ' + JSON.stringify(renewalCheck));
  assert(!!renewalCheck.renewalDue, '7: the renewal card carries the chosen date as its due date');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
