/* Acceptance suite for the "Pass UX" work: stage-gate zero-typing defaults,
 * lost-with-reason modal, revise-quote/revise-invoice without re-advancing.
 *
 * TSK-012: sections 1-2 were rewritten for the inline stage-gate card that
 * replaced the old #modal-appt gate mode (see openGateCard()/gateCardHtml()
 * in app.js) — the modal itself still exists for its other 3 modes
 * (add/repeat/edit), exercised by check-scheduling.js/check-blockers-p1.js,
 * unaffected by this task.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-ux-flow.js
 * Expects http://localhost:8943 serving ../app (harness pattern copied from
 * tests/check-scheduling.js).
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8943';
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // ── Register a fresh account ─────────────────────────────────────────
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'uxflow' + Date.now());
  await page.fill('#auth-name', 'UX Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // Default language is Thai (see check-scheduling.js §19) — switch to EN so
  // string assertions can compare against the EN dict values in the spec.
  await page.evaluate(async () => { await onLangChange('en'); renderPipeline(); });
  await page.waitForTimeout(200);

  // Client + job factory (same in-page pattern as check-scheduling.js).
  // window props die on page.reload(); this suite never reloads, but the
  // installer is still a re-runnable function per the harness convention.
  const installHelpers = () => page.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'UX Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'UX Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (serviceName, stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'UX Client', clientId: window.__cid,
        serviceId: null, serviceName, jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkJob = (name, stage, extra) =>
    page.evaluate(args => window.__mkJob(args[0], args[1], args[2]), [name, stage || null, extra || null]);
  const job = (id, expr) => page.evaluate(args => {
    const j = jobs.find(x => x.id === args[0]);
    return eval(args[1]);
  }, [id, expr]);
  // Modal-based gate mode is retired — this replaces the old #ap-none click.
  const closeGate = async () => { await page.evaluate(() => closeGateCard()); await page.waitForTimeout(300); };

  // ═══ 1. Gate defaults: the inline gate needs zero typing ════════════════
  // advanceJobStage(inquiry->quote) opens the "Book the follow-up" gate
  // (kind derives from the arrival stage, 'quote') with a single date input
  // prefilled to today+7 — no step-name field, no exact/by type anymore
  // (the new gate writes job.due directly; it never creates a dated
  // sub-task or calendar booking — see the STAGE-GATE INLINE CARD comment
  // block in app.js for why).
  const job1 = await mkJob('Photo shoot', 'inquiry');
  await page.evaluate(() => switchScreen('pipeline'));
  await page.waitForTimeout(300);
  await page.evaluate(id => advanceJobStage(id), job1);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  const gate1 = await page.evaluate(id => ({
    title: document.querySelector('.gate-title').textContent,
    date: document.getElementById('gate-date-' + id).value,
    open: window.__gateOpen && window.__gateOpen.jobId === id ? window.__gateOpen.kind : null,
  }), job1);
  const expectedDate7 = await page.evaluate(() => addDaysISO(todayISO(), 7));
  assert(gate1.title === 'Book the follow-up', '1: inline gate shows the Inquiry→Quote EN title, got ' + gate1.title);
  assert(gate1.open === 'quote', '1: gate kind derives from the arrival stage (quote), got ' + gate1.open);
  assert(gate1.date === expectedDate7, '1: date prefilled to today+7, got ' + gate1.date + ' expected ' + expectedDate7);
  await page.click('.gate-btn-primary');   // "Book & move"
  await page.waitForTimeout(400);
  assert(await job(job1, "jobStage(j)") === 'quote', '1: one tap on the primary button closes the gate — stage already moved on advance');
  assert(await job(job1, "j.due") === expectedDate7, '1: the zero-typing save wrote job.due = today+7');
  assert(await job(job1, "j.pendingGateStage") === null, '1: saving a real date clears pendingGateStage');

  // ═══ 2. Reopening via the pending banner reopens the SAME gate ══════════
  // Skip on a move-gate still moves the card but leaves it date-less — the
  // pending banner then reopens the same transition's gate (kind is derived
  // from job.pendingGateStage, still 'quote' — the generic "Book the next
  // step" pending copy is reserved for the rarer case where the pending
  // flag doesn't map to one of the 3 basic stage transitions at all).
  const job2 = await mkJob('Inquiry job', 'inquiry');
  await page.evaluate(id => advanceJobStage(id), job2);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  await page.click('.gate-btn-secondary');   // "Skip" — moves forward, no date
  await page.waitForTimeout(400);
  assert(await job(job2, "jobStage(j)") === 'quote', '2: Skip still advances the stage');
  assert(await job(job2, "j.due") == null, '2: Skip leaves the job date-less');
  const bannerCard = page.locator('.kb-card', { hasText: 'Inquiry job' });
  const bannerCount = await bannerCard.locator('.pl-pending').count();
  assert(bannerCount === 1, '2: no-due-date card shows the pending banner');
  await bannerCard.locator('.pl-pending').click();
  await page.waitForTimeout(300);
  const gate2 = await page.evaluate(() => document.querySelector('.gate-title')?.textContent);
  assert(gate2 === 'Book the follow-up', '2: reopening via the banner shows the same Inquiry→Quote title, got ' + gate2);
  // A pending flag that ISN'T one of the 3 basic transitions falls back to
  // the generic "Book the next step" pending copy.
  const genericGate = await page.evaluate(id => {
    openGateCard(id, 'not-a-real-stage');
    return document.querySelector('.gate-title')?.textContent;
  }, job2);
  assert(genericGate === 'Book the next step', '2: an unrecognized gate kind falls back to the generic pending title, got ' + genericGate);
  await closeGate();

  // ═══ 3. Non-gate "add" mode is unchanged ════════════════════════════════
  const job3 = await mkJob('Add mode job', 'inquiry');
  await page.evaluate(id => openApptModal({ mode: 'add', jobId: id }), job3);
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  const add3 = await page.evaluate(() => ({
    step: document.getElementById('ap-step').value,
    exactActive: document.getElementById('ap-type-exact').classList.contains('seg-active'),
    date: document.getElementById('ap-date').value,
  }));
  assert(add3.step === '', '3: "add" mode still starts with an empty step name, got ' + JSON.stringify(add3.step));
  assert(add3.exactActive, '3: "add" mode still defaults to "exact"');
  assert(add3.date === '', '3: "add" mode date stays empty (no gate default leaks in)');
  await page.evaluate(() => closeApptModal());

  // ═══ 4. Lost-with-reason modal ═══════════════════════════════════════════
  const job4 = await mkJob('Lost candidate', 'quote');
  await page.evaluate(() => { switchScreen('pipeline'); selectPipelineStage('quote'); });
  await page.waitForTimeout(200);
  await page.evaluate(id => markJobLost(id), job4);
  await page.waitForSelector('#modal-lost.open', { timeout: 5000 });
  await page.click('#lost-cancel');
  await page.waitForTimeout(300);
  assert(await job(job4, '!j.complete && j.outcome == null') === true, '4: Cancel keeps the job active, no change');

  await page.evaluate(id => markJobLost(id), job4);
  await page.waitForSelector('#modal-lost.open', { timeout: 5000 });
  await page.click('#lost-reasons [data-reason="price"]');
  await page.waitForTimeout(100);
  const priceActive = await page.evaluate(() =>
    document.querySelector('#lost-reasons [data-reason="price"]').classList.contains('seg-active'));
  assert(priceActive, '4: tapping a reason chip selects it');
  await page.click('#lost-confirm');
  await page.waitForTimeout(400);
  assert(await job(job4, "j.outcome === 'lost'") === true, '4: Confirm sets outcome = lost');
  assert(await job(job4, "j.lostReason") === 'price', '4: Confirm records the selected reason');
  const badgeText = await page.locator('.kb-card', { hasText: 'Lost candidate' }).textContent();
  assert(badgeText.includes('Price too high'), '4: card badge appends the reason text, got: ' + badgeText.slice(0, 150));

  // Chip deselect on a second job: select then re-tap → optional reason stays null.
  const job4b = await mkJob('Lost candidate no reason', 'quote');
  await page.evaluate(() => { switchScreen('pipeline'); selectPipelineStage('quote'); });
  await page.waitForTimeout(200);
  await page.evaluate(id => markJobLost(id), job4b);
  await page.waitForSelector('#modal-lost.open', { timeout: 5000 });
  await page.click('#lost-reasons [data-reason="cancelled"]');
  await page.click('#lost-reasons [data-reason="cancelled"]');   // deselect
  await page.waitForTimeout(100);
  const deselected = await page.evaluate(() =>
    !document.querySelector('#lost-reasons [data-reason="cancelled"]').classList.contains('seg-active'));
  assert(deselected, '4: re-tapping a selected chip deselects it');
  await page.click('#lost-confirm');
  await page.waitForTimeout(400);
  assert(await job(job4b, 'j.lostReason') === null, '4: no chip selected → lostReason stays null (reason is optional)');

  // ═══ 5. saveJob preserve: lostReason survives a detail edit ═════════════
  await page.evaluate(id => openEditJob(id), job4);
  await page.waitForTimeout(300);
  await page.evaluate(() => saveJob());
  await page.waitForTimeout(300);
  assert(await job(job4, 'j.lostReason') === 'price', '5: lostReason survives an unrelated detail-edit save');

  // ═══ 6. Revise quote WITHOUT re-advancing ════════════════════════════════
  const job6 = await mkJob('Revise quote job', 'booked', { quoteDocId: 111 });
  await page.evaluate(() => { switchScreen('pipeline'); selectPipelineStage('booked'); });
  await page.waitForTimeout(200);
  const reviseQuoteBtnCount = await page.locator('.kb-card', { hasText: 'Revise quote job' })
    .locator('button', { hasText: 'Revise quote' }).count();
  assert(reviseQuoteBtnCount === 1, '6: card shows a "Revise quote" button when quoteDocId is set');
  await page.evaluate(id => {
    window.__quoteReviseJobId = id;
    return window.onEngagementQuoteCreated(222, id);
  }, job6);
  await page.waitForTimeout(400);
  assert(await job(job6, "jobStage(j)") === 'booked', '6: stage stays put after a quote revise');
  assert(await job(job6, "j.quoteDocId") === 222, '6: quoteDocId relinked to the new document');
  assert(!(await page.evaluate(() => !!document.getElementById('modal-appt'))), '6: no gate modal opens for a revise');

  // ═══ 7. Attaching/revising an invoice on a booked job never re-advances ═
  // TSK-014: this is no longer a "revise-only" special case — a booked job
  // can carry zero/one/many invoices and attaching any of them is purely a
  // link, never a stage move (see onEngagementInvoiceCreated).
  const job7 = await mkJob('Revise invoice job', 'booked', { invoiceId: 55 });
  await page.evaluate(() => { switchScreen('pipeline'); selectPipelineStage('booked'); });
  await page.waitForTimeout(200);
  const reviseInvBtnCount = await page.locator('.kb-card', { hasText: 'Revise invoice job' })
    .locator('button', { hasText: 'Revise invoice' }).count();
  assert(reviseInvBtnCount === 1, '7: card shows a "Revise invoice" button when invoiceId is set');
  await page.evaluate(id => {
    window.__invoiceReviseJobId = id;
    return window.onEngagementInvoiceCreated(66, id);
  }, job7);
  await page.waitForTimeout(400);
  assert(await job(job7, "jobStage(j)") === 'booked', '7: stage stays put after an invoice revise');
  assert(await job(job7, "j.invoiceId") === 66, '7: invoiceId relinked to the new invoice');
  assert(!(await page.evaluate(() => !!document.getElementById('modal-appt'))), '7: no gate modal opens for an invoice revise');

  // ═══ 8. Normal quote path still advances + gates ═════════════════════════
  const job8 = await mkJob('Normal quote job', 'quote');
  await page.evaluate(() => { switchScreen('pipeline'); selectPipelineStage('quote'); });
  await page.waitForTimeout(200);
  await page.evaluate(id => window.onEngagementQuoteCreated(777, id), job8);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await job(job8, "jobStage(j)") === 'booked', '8: a normal (non-revise) quote save advances quote → booked');
  assert(await job(job8, "j.pendingGateStage") === 'booked', '8: a normal quote save still sets the stage gate');
  const gate8Title = await page.evaluate(() => document.querySelector('.gate-title')?.textContent);
  assert(gate8Title === 'Client accepted 🎉', '8: the quote→booked gate shows its own "Client accepted" title, got ' + gate8Title);
  await closeGate();

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
