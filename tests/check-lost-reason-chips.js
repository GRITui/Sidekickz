/* Acceptance suite for TSK-017 — optional single-select lost-reason chips
 * layered onto the Cancel gate's existing free-text note (see gateCardHtml
 * 'cancel' branch + resolveGateCancel in app.js). Additive only: the note
 * field and the standalone markJobLost() modal both keep working exactly
 * as before (see check-task-flow-v2.js §3 and check-options-lost.js §8).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-lost-reason-chips.js
 * Harness pattern copied from tests/check-task-flow-v2.js.
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

  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'lostchip' + Date.now());
  await page.fill('#auth-name', 'Lost Chip Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.evaluate(async () => { await onLangChange('en'); renderPipeline(); });
  await page.waitForTimeout(200);

  const installHelpers = () => page.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'Chip Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'Chip Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Chip Client', clientId: window.__cid,
        serviceId: null, serviceName: 'Chip svc', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, outcome: null, invoiceId: null, quoteDocId: null,
        packageId: null, due: null, note: null, attempt: 1, dueBookingCuid: null, lostReason: null, updatedAt: nowISO() }, extra || {});
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

  // ═══ 1. Cancel gate renders 4 reason chips above the note field ═════════
  const j1 = await mkJob('inquiry');
  await goto('inquiry');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'cancel'), j1);
  await page.waitForTimeout(300);
  const chips = await page.locator(`#gate-reasons-${j1} .gate-reason-chip`).allTextContents();
  assert(chips.length === 4, '1: 4 reason chips render, got ' + chips.length);
  assert(chips.includes('Price too high'), '1: chip labels reuse the existing LOST_REASONS i18n, got ' + JSON.stringify(chips));
  assert(await page.locator(`#gate-reasons-${j1} .gate-reason-chip.selected`).count() === 0, '1: no chip is pre-selected');
  await page.evaluate(() => closeGateCard());

  // ═══ 2. Selecting a chip + cancelling writes job.lostReason ═════════════
  const j2 = await mkJob('quote');
  await goto('quote');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'cancel'), j2);
  await page.waitForTimeout(300);
  await page.click(`#gate-reasons-${j2} .gate-reason-chip[data-reason="price"]`);
  await page.waitForTimeout(150);
  assert(await page.locator(`#gate-reasons-${j2} .gate-reason-chip[data-reason="price"].selected`).count() === 1,
    '2: clicking a chip marks it selected');
  await page.fill(`#gate-note-${j2}`, 'Wanted 20% off package rate');
  await page.click('.gate-btn-danger');   // "Cancel job"
  await page.waitForTimeout(400);
  const after2 = await job(j2, 'JSON.stringify({lostReason:j.lostReason, note:j.note, outcome:j.outcome})').then(JSON.parse);
  assert(after2.lostReason === 'price', '2: the selected chip is saved as job.lostReason, got ' + JSON.stringify(after2));
  assert(after2.note === 'Wanted 20% off package rate', '2: the free-text note is ALSO saved (additive, not either/or), got ' + JSON.stringify(after2));
  assert(after2.outcome === 'lost', '2: outcome is still set to lost as before');

  // ═══ 3. Tapping the already-selected chip clears it (single-select toggle) ═
  const j3 = await mkJob('booked');
  await goto('booked');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'cancel'), j3);
  await page.waitForTimeout(300);
  const chipSel = `#gate-reasons-${j3} .gate-reason-chip[data-reason="no_response"]`;
  await page.click(chipSel);
  await page.waitForTimeout(120);
  assert(await page.locator(chipSel + '.selected').count() === 1, '3: chip selected after first tap');
  await page.click(chipSel);   // tap again — should clear
  await page.waitForTimeout(120);
  assert(await page.locator(chipSel + '.selected').count() === 0, '3: tapping the same chip again clears the selection');
  assert(await page.locator(`#gate-reasons-${j3} .gate-reason-chip.selected`).count() === 0, '3: no chip left selected anywhere in the row');
  await page.evaluate(() => closeGateCard());

  // ═══ 4. Cancelling with NO chip selected leaves job.lostReason null ═════
  const j4 = await mkJob('deliver');
  await goto('deliver');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'cancel'), j4);
  await page.waitForTimeout(300);
  await page.fill(`#gate-note-${j4}`, 'Just went quiet, no chip picked');
  await page.click('.gate-btn-danger');
  await page.waitForTimeout(400);
  const after4 = await job(j4, 'JSON.stringify({lostReason:j.lostReason, note:j.note})').then(JSON.parse);
  assert(after4.lostReason === null, '4: no chip selected -> job.lostReason stays null (reason is optional), got ' + JSON.stringify(after4));
  assert(after4.note === 'Just went quiet, no chip picked', '4: the note is still saved on its own, got ' + JSON.stringify(after4));

  // ═══ 5. Selecting a DIFFERENT chip swaps the selection (still single-select) ═
  const j5 = await mkJob('inquiry');
  await goto('inquiry');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'cancel'), j5);
  await page.waitForTimeout(300);
  await page.click(`#gate-reasons-${j5} .gate-reason-chip[data-reason="cancelled"]`);
  await page.waitForTimeout(120);
  await page.click(`#gate-reasons-${j5} .gate-reason-chip[data-reason="competitor"]`);
  await page.waitForTimeout(120);
  assert(await page.locator(`#gate-reasons-${j5} .gate-reason-chip[data-reason="cancelled"].selected`).count() === 0,
    '5: switching chips deselects the first one');
  assert(await page.locator(`#gate-reasons-${j5} .gate-reason-chip[data-reason="competitor"].selected`).count() === 1,
    '5: the newly clicked chip is now selected');
  await page.click('.gate-btn-danger');
  await page.waitForTimeout(400);
  assert(await job(j5, 'j.lostReason') === 'competitor', '5: the final (swapped-to) chip is what gets saved');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
