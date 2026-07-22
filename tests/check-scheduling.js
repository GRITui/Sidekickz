/* Consolidated acceptance suite — dated sub-tasks, stage-gate booking modal,
 * repeat steps, pipeline timeline/Gantt, booking links.
 * Covers all 20 points of scheduling-spec.md §9.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node check-scheduling.js
 * Expects http://localhost:8933 serving ../app.
 * Runs at a 320px viewport throughout so the no-horizontal-body-scroll
 * checks exercise the tightest supported screen.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:8933';
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
  await page.fill('#auth-user', 'sched' + Date.now());
  await page.fill('#auth-name', 'Sched Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // One shared client; a job factory used throughout. window props die on
  // page.reload(), so installation is a reusable function re-run after every
  // reload (the client row itself persists in IDB — looked up, not re-added).
  const installHelpers = () => page.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'Gate Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'Gate Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (serviceName, stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Gate Client', clientId: window.__cid,
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

  const jobA = await mkJob('Chip svc');
  assert(typeof jobA === 'number', 'setup: job A created');
  const today = await page.evaluate(() => todayISO());
  const plus = d => page.evaluate(n => tlAddDays(todayISO(), n), d);
  const dPlus6 = await plus(6);
  const dPlus10 = await plus(10);

  // ═══ 1. Undated sub-task via #job-subtask-new + Enter ═══════════════════
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  // TSK-008: Plan & payments now lives behind Full details + a collapsed
  // drill row — switch mode and pop the row open before interacting with it.
  // It stays open across re-renders (renderSubTasks/renderMilestones only
  // replace their own inner containers, never the <details> itself).
  await page.evaluate(() => { setJobModalMode('full'); document.getElementById('job-plan-details').open = true; });
  await page.fill('#job-subtask-new', 'Undated task');
  await page.press('#job-subtask-new', 'Enter');
  await page.waitForTimeout(300);
  const undatedRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'));
    const r = rows.find(x => x.textContent.includes('Undated task'));
    if (!r) return null;
    return { buttons: r.querySelectorAll('button').length, chip: !!r.querySelector('.st-chip'),
      repeat: Array.from(r.querySelectorAll('button')).some(b => b.textContent.trim() === '↻'),
      checkbox: !!r.querySelector('input[type=checkbox]') };
  });
  assert(undatedRow && undatedRow.checkbox && undatedRow.buttons === 1 && !undatedRow.chip && !undatedRow.repeat,
    '1: undated row = checkbox + one ✕ button only (no chip, no ↻), got ' + JSON.stringify(undatedRow));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#job-subtasks-body .list-row'))
      .find(x => x.textContent.includes('Undated task')).click();
  });
  await page.waitForTimeout(200);
  assert(await job(jobA, `j.subTasks.find(s => s.text === 'Undated task').done === true`), '1: toggle marks undated sub-task done');
  await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'))
      .find(x => x.textContent.includes('Undated task'));
    r.querySelector('button[aria-label="Delete sub-task"]').click();
  });
  await page.waitForTimeout(200);
  assert(await job(jobA, `!j.subTasks.some(s => s.text === 'Undated task')`), '1: delete removes undated sub-task');

  // ═══ 2. "+ Step with date" → exact step + linked booking ════════════════
  await page.click('#job-tracking-section button[data-i18n="appt_add_dated"]');
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  await page.fill('#ap-step', 'Health check-up');
  await page.fill('#ap-date', today);
  await page.fill('#ap-time', '10:30');
  await page.click('#ap-save');
  await page.waitForTimeout(500);
  const exact = await page.evaluate(async id => {
    const j = jobs.find(x => x.id === id);
    const st = (j.subTasks || []).find(s => s.text === 'Health check-up');
    const bk = st ? (await dbAll('bookings')).find(b => b.cuid === st.bookingCuid) : null;
    const rows = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'));
    const row = rows.find(r => r.textContent.includes('Health check-up'));
    return { st, chip: row ? (row.querySelector('.st-chip')?.textContent || '') : '',
      bk: bk ? { jobCuid: bk.jobCuid, date: bk.date, startTime: bk.startTime, status: bk.status, id: bk.id, title: bk.title } : null,
      jobCuid: j.cuid };
  }, jobA);
  assert(exact.st && exact.st.dateType === 'exact' && exact.st.date === today && exact.st.startTime === '10:30',
    '2: sub-task saved as exact with date+time');
  assert(exact.chip.includes('📅') && exact.chip.includes('10:30'), '2: row shows 📅 date+time chip, got: ' + exact.chip);
  assert(exact.bk && exact.bk.jobCuid === exact.jobCuid && exact.bk.status === 'scheduled'
    && exact.bk.date === today && exact.bk.startTime === '10:30',
    '2: booking row created with jobCuid + scheduled + matching date/time, got ' + JSON.stringify(exact.bk));
  assert(exact.st && exact.st.bookingCuid, '2: subTask.bookingCuid links to the booking');
  await page.evaluate(() => closeJobModal());

  // ═══ 3. Booking appears on the month calendar and week timeline ═════════
  await page.evaluate(() => switchScreen('book'));
  await page.waitForTimeout(500);
  assert(await page.locator(`.cal-cell[data-cal="${today}"] .cal-dot-book`).count() > 0,
    '3: month calendar shows booking dot on ' + today);
  await page.click('[data-cal-mode="week"]');
  await page.waitForTimeout(500);
  const weekBlock = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('.cal-tl-block'));
    return blocks.map(b => b.textContent).join('|');
  });
  assert(weekBlock.includes('Health check-up'), '3: week timeline shows the booking block, got: ' + weekBlock);

  // ═══ 17. Form edit preserves jobCuid; form-created booking has null ═════
  await page.evaluate(id => {
    document.querySelector(`.cal-tl-block[data-bk="${id}"]`).click();
  }, exact.bk.id);
  await page.waitForSelector('#bk-form-modal', { timeout: 5000 });
  await page.fill('#bk-title', 'Health check-up (edited)');
  await page.click('#bk-save');
  await page.waitForTimeout(500);
  const editedBk = await page.evaluate(async id => await dbGet('bookings', id), exact.bk.id);
  assert(editedBk && editedBk.title === 'Health check-up (edited)' && editedBk.jobCuid === exact.jobCuid,
    '17: form edit preserves jobCuid, got ' + JSON.stringify({ title: editedBk?.title, jobCuid: editedBk?.jobCuid }));
  await page.evaluate(d => openBookingForm(d), today);
  await page.waitForSelector('#bk-form-modal', { timeout: 5000 });
  await page.fill('#bk-title', 'Manual booking');
  await page.click('#bk-save');
  await page.waitForTimeout(500);
  const manualBk = await page.evaluate(async () => (await dbAll('bookings')).find(b => b.title === 'Manual booking'));
  assert(manualBk && manualBk.jobCuid === null, '17: form-created booking has jobCuid null, got ' + JSON.stringify(manualBk?.jobCuid));

  // ═══ 4. Advance → INLINE gate card (TSK-012, replaces #modal-appt) ══════
  // The gate is now embedded in the pipeline card itself (see openGateCard()/
  // gateCardHtml() in app.js) — there's no overlay to click through or Esc
  // to press; the card simply stays on the page until Book&move/Skip is
  // tapped. Coverage below: an accidental outside click / Esc genuinely does
  // nothing (nothing is listening for either), which is the inline
  // equivalent of the old modal's "locked door" invariant.
  const jobB = await mkJob('Gate svc');
  await page.evaluate(() => switchScreen('pipeline'));
  await page.waitForTimeout(300);
  const stageB0 = await job(jobB, 'jobStage(j)');
  await page.evaluate(id => advanceJobStage(id), jobB);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  const gateState = await page.evaluate(id => ({
    pending: jobs.find(j => j.id === id).pendingGateStage,
    stage: jobStage(jobs.find(j => j.id === id)),
  }), jobB);
  assert(gateState.stage !== stageB0, '4: card moved one stage on advance');
  assert(gateState.pending === gateState.stage, '4: pendingGateStage === new stage while unresolved, got ' + JSON.stringify(gateState));
  await page.mouse.click(5, 5);
  await page.waitForTimeout(250);
  assert(await page.isVisible('.gate-card'), '4: an outside click does NOT dismiss the inline gate card');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert(await page.isVisible('.gate-card'), '4: Esc does NOT dismiss the inline gate card either');

  // ═══ 5. The gate always has a valid default — nothing to validate ═══════
  // There's no free-text step-name field anymore and the date input always
  // starts prefilled to today+7, so there's no invalid/empty state to guard
  // against — Book&move/Skip are always immediately actionable.
  const gate5Date = await page.evaluate(id => document.getElementById('gate-date-' + id).value, jobB);
  const expectedDate7_B = await page.evaluate(() => addDaysISO(todayISO(), 7));
  assert(gate5Date === expectedDate7_B, '5: gate date input defaults to today+7 with zero typing, got ' + gate5Date);

  // ═══ 6. Gate "Book & move" → job.due set, NOT a sub-task/booking ════════
  // Documented engineering decision (see app.js's STAGE-GATE INLINE CARD
  // comment): the inline gate writes job.due directly and never touches
  // subTasks/bookings — that mechanism stays reserved for job-detail's own
  // "+ Step with date" flow (exercised in §1-3/§11 above, untouched by this
  // rewrite).
  const bkCountBefore = await page.evaluate(() => dbAll('bookings').then(r => r.length));
  await page.fill('#gate-date-' + jobB, dPlus6);
  await page.click('.gate-btn-primary');
  await page.waitForTimeout(500);
  const dateRes = await page.evaluate(async id => {
    const j = jobs.find(x => x.id === id);
    return { due: j.due, pending: j.pendingGateStage, gateOpen: !!(window.__gateOpen && window.__gateOpen.jobId === id),
      bkCount: (await dbAll('bookings')).length };
  }, jobB);
  assert(dateRes.due === dPlus6, '6: "Book & move" wrote job.due to the chosen date, got ' + dateRes.due);
  assert(dateRes.bkCount === bkCountBefore, '6: NO booking row created by the inline gate');
  assert(dateRes.pending == null && !dateRes.gateOpen, '6: gate resolved (flag cleared, gate card closed)');

  // ═══ 6b. Restore a "by" dated sub-task on jobB via the (unchanged) modal
  // add-mode — §13-15 below need a second dated-step job to exercise the
  // timeline's bar/dot mix; the inline gate no longer creates one itself
  // (see §6's comment), so this recreates that fixture explicitly through
  // job-detail's own "+ Step with date" flow instead.
  await page.evaluate(id => openApptModal({ mode: 'add', jobId: id }), jobB);
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  await page.click('#ap-type-by');
  await page.fill('#ap-step', 'Send report');
  await page.fill('#ap-date', dPlus6);
  await page.click('#ap-save');
  await page.waitForTimeout(500);
  const byStepRes = await page.evaluate(id => {
    const j = jobs.find(x => x.id === id);
    const st = (j.subTasks || []).find(s => s.text === 'Send report');
    return st ? { dateType: st.dateType, date: st.date, startTime: st.startTime, stage: st.stage } : null;
  }, jobB);
  assert(byStepRes && byStepRes.dateType === 'by' && byStepRes.startTime === null && byStepRes.date === dPlus6,
    '6b: "by" dated step created via the add-mode modal, got ' + JSON.stringify(byStepRes));

  // ═══ 7. Gate "Skip" — moves already happened; Skip just leaves it date-less
  const subCountB = await job(jobB, '(j.subTasks || []).length');
  await page.evaluate(id => advanceJobStage(id), jobB);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await page.locator('.gate-btn-secondary').count() === 1, '7: the gate shows a "Skip" secondary button');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);
  const afterNone = await page.evaluate(id => ({
    gateOpen: !!(window.__gateOpen && window.__gateOpen.jobId === id),
    pending: jobs.find(j => j.id === id).pendingGateStage,
    due: jobs.find(j => j.id === id).due,
    subCount: (jobs.find(j => j.id === id).subTasks || []).length,
  }), jobB);
  assert(!afterNone.gateOpen && afterNone.pending && afterNone.due == null && afterNone.subCount === subCountB,
    '7: skip → gate closed, no sub-task added, due stays null, pendingGateStage stays set, got ' + JSON.stringify(afterNone));

  // ═══ 8. Reload mid-gate → banner persists, advance blocked ══════════════
  await page.reload();
  await page.waitForFunction(() => { try { return jobs.length > 0; } catch (e) { return false; } }, null, { timeout: 20000 });
  await installHelpers();   // reload wiped window.__mkJob/__cid
  await page.evaluate(id => {
    document.getElementById('cloud-backup-modal')?.remove();
    switchScreen('pipeline');
    selectPipelineStage(jobStage(jobs.find(j => j.id === id)));
  }, jobB);
  await page.waitForTimeout(400);
  assert(await job(jobB, '!!j.pendingGateStage'), '8: pendingGateStage persisted across reload');
  assert(await page.locator('.pl-pending').count() > 0, '8: amber "book next step" banner on the card after reload');
  await page.click('.pl-pending');
  await page.waitForTimeout(300);
  assert(await page.isVisible('.gate-card'), '8: banner reopens the inline gate card');
  await page.evaluate(() => closeGateCard());
  const stageBefore8 = await job(jobB, 'jobStage(j)');
  await page.evaluate(id => pipelineAction(id), jobB);
  await page.waitForTimeout(300);
  assert(await job(jobB, 'jobStage(j)') === stageBefore8 && await page.isVisible('.gate-card'),
    '8: advance while pending reopens the gate instead of advancing again');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);

  // ═══ 9. Every forward path gates — EXCEPT paid/invoice-link, which are ═══
  // no longer stage moves at all under TSK-014 (paid is a job-level flag;
  // an invoice can attach to a booked job without moving it).
  // skip (quote stage is skippable)
  const jobC = await mkJob('Skip svc', 'quote');
  await page.evaluate(id => skipJobStage(id), jobC);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await job(jobC, '!!j.pendingGateStage'), '9: skipJobStage gates');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);
  // cash path — lands on Booked, already marked paid, and gates on Booked
  const jobD = await mkJob('Cash svc', 'inquiry');
  await page.evaluate(id => cashJobPath(id), jobD);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await job(jobD, `jobStage(j) === 'booked' && j.paid === true && j.pendingGateStage === 'booked'`),
    '9: cashJobPath lands on booked, marks paid, and gates');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);
  // mark paid — TSK-014: no longer a stage move, so it never gates
  const jobE = await mkJob('Paid svc', 'booked');
  await page.evaluate(id => markJobPaid(id), jobE);
  await page.waitForTimeout(400);
  assert(await job(jobE, `jobStage(j) === 'booked' && j.paid === true && j.pendingGateStage == null`)
    && !(await page.evaluate(() => !!document.querySelector('.gate-card'))),
    '9: markJobPaid never gates (paid is a job-level flag, not a stage)');
  // quote doc save — still a real stage move (quote -> booked), still gates
  const jobF = await mkJob('Quote svc', 'quote');
  await page.evaluate(id => window.onEngagementQuoteCreated(999, id), jobF);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await job(jobF, '!!j.pendingGateStage'), '9: onEngagementQuoteCreated gates');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);
  // invoice save — TSK-014: attaching an invoice to a booked job never moves
  // the stage anymore, so it never gates either
  const jobG = await mkJob('Invoice svc', 'booked');
  await page.evaluate(id => window.onEngagementInvoiceCreated(999, id), jobG);
  await page.waitForTimeout(400);
  assert(await job(jobG, `j.invoiceId === 999 && jobStage(j) === 'booked' && j.pendingGateStage == null`)
    && !(await page.evaluate(() => !!document.querySelector('.gate-card'))),
    '9: onEngagementInvoiceCreated links the invoice but never gates');
  // package confirm-and-advance — now triggered by the booked->deliver
  // advance itself (pipelineAction), independent of payment
  const pkgJob = await page.evaluate(async () => {
    const pkgId = await dbAdd('packages', { uid: currentUser.id, cuid: cuid(), clientId: window.__cid,
      totalSessions: 5, price: 1000, purchasedDate: todayISO(), expiresAt: null, notes: '', createdAt: nowISO() });
    await reload();
    return window.__mkJob('Pkg svc', 'booked', { packageId: pkgId });
  });
  await page.evaluate(id => { switchScreen('pipeline'); selectPipelineStage('booked'); }, pkgJob);
  await page.waitForTimeout(300);
  await page.evaluate(id => pipelineAction(id), pkgJob);
  await page.waitForTimeout(400);
  assert(await page.locator(`#pkg-confirm-qty-${pkgJob}`).count() === 1, '9: package path shows confirm card before advancing');
  await page.fill(`#pkg-confirm-qty-${pkgJob}`, '1');
  await page.click(`#pkg-confirm-save-${pkgJob}`);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await job(pkgJob, `jobStage(j) === 'deliver' && j.pendingGateStage === 'deliver'`),
    '9: package confirm-and-advance gates on deliver');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);

  // ═══ 10. Back / finish / terminal advance never gate ════════════════════
  await page.evaluate(id => advanceJobStage(id), jobC);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  await page.evaluate(() => closeGateCard());
  await page.evaluate(id => moveJobStageBack(id), jobC);
  await page.waitForTimeout(400);
  assert(await job(jobC, 'j.pendingGateStage == null') && !(await page.evaluate(() => !!document.querySelector('.gate-card'))),
    '10: moveJobStageBack clears the flag and opens no gate');
  await page.evaluate(async id => {
    const j = jobs.find(x => x.id === id);
    j.pendingGateStage = 'deliver';
    await dbPut('jobs', j);
  }, jobD);
  await page.evaluate(id => finishJobStage(id), jobD);
  await page.waitForTimeout(400);
  assert(await job(jobD, 'j.complete === true && j.pendingGateStage == null')
    && !(await page.evaluate(() => !!document.querySelector('.gate-card'))),
    '10: finishJobStage clears the flag and opens no gate');
  const jobI = await mkJob('Terminal svc', 'deliver');
  await page.evaluate(id => advanceJobStage(id), jobI);
  await page.waitForTimeout(400);
  assert(await job(jobI, 'j.complete === true && j.pendingGateStage == null')
    && !(await page.evaluate(() => !!document.querySelector('.gate-card'))),
    '10: terminal advance (last stage) completes without gating');

  // ═══ 11. Repeat (↻) a dated step ════════════════════════════════════════
  await page.evaluate(id => openEditJob(id), jobA);
  await page.waitForTimeout(300);
  const srcBefore = await job(jobA, `JSON.stringify(j.subTasks.find(s => s.text === 'Health check-up'))`);
  const repeatBtn = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'));
    const r = rows.find(x => x.textContent.includes('Health check-up'));
    const b = r && Array.from(r.querySelectorAll('button')).find(x => x.textContent.trim() === '↻');
    if (b) { b.click(); return { found: true, aria: b.getAttribute('aria-label') }; }
    return { found: false };
  });
  assert(repeatBtn.found && !!repeatBtn.aria, '11: dated row has ↻ with aria-label');
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  const prefill = await page.evaluate(() => ({
    step: document.getElementById('ap-step').value,
    date: document.getElementById('ap-date').value,
    exactActive: document.getElementById('ap-type-exact').classList.contains('seg-active'),
  }));
  assert(prefill.step === 'Health check-up' && prefill.date === '' && prefill.exactActive,
    '11: repeat modal prefills text + type with date empty, got ' + JSON.stringify(prefill));
  await page.fill('#ap-date', dPlus10);
  await page.click('#ap-save');
  await page.waitForTimeout(500);
  const rep = await page.evaluate(id => {
    const j = jobs.find(x => x.id === id);
    const src = j.subTasks.find(s => s.text === 'Health check-up' && !s.repeatOfId);
    const clone = j.subTasks.find(s => s.repeatOfId);
    return { srcNow: JSON.stringify(src),
      clone: clone ? { text: clone.text, sameId: clone.id === src.id, repeatOfId: clone.repeatOfId, srcId: src.id, date: clone.date } : null };
  }, jobA);
  assert(rep.clone && rep.clone.text === 'Health check-up' && !rep.clone.sameId
    && rep.clone.repeatOfId === rep.clone.srcId && rep.clone.date === dPlus10,
    '11: clone has same text, new id, new date, repeatOfId = source id, got ' + JSON.stringify(rep.clone));
  assert(rep.srcNow === srcBefore, '11: source step unchanged by repeat');
  await page.evaluate(() => closeJobModal());

  // ═══ 12. Board/Timeline toggle + persistence ════════════════════════════
  await page.evaluate(() => switchScreen('pipeline'));
  await page.waitForTimeout(300);
  assert(await page.locator('#pipeline-body .pl-view-seg').count() === 1, '12: view toggle renders on the board');
  await page.click('.pl-view-seg button:nth-child(2)');
  await page.waitForTimeout(400);
  const tlOn = await page.evaluate(() => ({
    mode: window.__plView, setting: settings.plViewMode,
    scroller: !!document.querySelector('#pipeline-body .tl-scroll'),
  }));
  assert(tlOn.mode === 'timeline' && tlOn.setting === 'timeline' && tlOn.scroller,
    '12: timeline selected + plViewMode persisted + .tl-scroll rendered, got ' + JSON.stringify(tlOn));
  await page.reload();
  await page.waitForFunction(() => { try { return jobs.length > 0; } catch (e) { return false; } }, null, { timeout: 20000 });
  await installHelpers();   // reload wiped window.__mkJob/__cid
  await page.evaluate(() => { document.getElementById('cloud-backup-modal')?.remove(); switchScreen('pipeline'); });
  await page.waitForTimeout(400);
  const tlReload = await page.evaluate(() => ({
    mode: window.__plView, scroller: !!document.querySelector('#pipeline-body .tl-scroll'),
  }));
  assert(tlReload.mode === 'timeline' && tlReload.scroller, '12: timeline view persists across reload');

  // ═══ 13. Timeline marks, today rule, scroll confinement ═════════════════
  const tl = await page.evaluate(() => ({
    rows: document.querySelectorAll('.tl-row').length,
    dots: document.querySelectorAll('.tl-pt').length,
    bars: document.querySelectorAll('.tl-bar').length,
    today: document.querySelectorAll('.tl-today').length,
    bodyScrollW: document.body.scrollWidth, bodyClientW: document.body.clientWidth,
    docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
  }));
  assert(tl.rows === 2, '13: two jobs with dated steps → two timeline rows, got ' + tl.rows);
  assert(tl.dots === 2, '13: two exact steps render as dots, got ' + tl.dots);
  assert(tl.bars === 1, '13: one by-step renders as a bar, got ' + tl.bars);
  assert(tl.today === 1, '13: full-height today rule present');
  assert(tl.bodyScrollW === tl.bodyClientW && tl.docScrollW === tl.docClientW,
    '13: horizontal scroll confined to .tl-scroll (body scrollWidth === clientWidth) at 320px');
  // Bar geometry: right edge = deadline column end. min = earliest date − 3d;
  // earliest dated step is today, so min = today − 3.
  const barGeom = await page.evaluate(byDate => {
    const bar = document.querySelector('.tl-bar');
    const left = parseFloat(bar.style.left), width = parseFloat(bar.style.width);
    const expected = (tlDaysBetween(todayISO(), byDate) + 3) * 28 + 28;
    return { rightPx: left + width, expected, title: bar.title };
  }, dPlus6);
  assert(Math.abs(barGeom.rightPx - barGeom.expected) < 0.5,
    '13: by-bar right edge lands on the deadline column end, got ' + JSON.stringify(barGeom));

  // ═══ 14. Overdue by-step → danger on chip + timeline ════════════════════
  await page.evaluate(async id => {
    const j = jobs.find(x => x.id === id);
    j.subTasks.push({ id: cuid(), text: 'Missed deadline', done: false, dateType: 'by',
      date: tlAddDays(todayISO(), -4), startTime: null, bookingCuid: null, stage: null, repeatOfId: null });
    await dbPut('jobs', j);
    renderPipeline();
  }, jobA);
  await page.waitForTimeout(300);
  const overdueTl = await page.evaluate(() => ({
    lateMarks: document.querySelectorAll('.tl-flag.late, .tl-bar.late').length,
  }));
  assert(overdueTl.lateMarks === 1, '14: overdue by-step renders in danger state on the timeline, got ' + JSON.stringify(overdueTl));
  const chipOverdue = await page.evaluate(id => {
    openEditJob(id);
    const rows = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'));
    const r = rows.find(x => x.textContent.includes('Missed deadline'));
    const chip = r && r.querySelector('.st-chip.chip-overdue');
    return chip ? chip.textContent : null;
  }, jobA);
  assert(!!chipOverdue && chipOverdue.includes('เลยกำหนด'),
    '14: overdue chip has chip-overdue class + Thai Overdue prefix, got ' + JSON.stringify(chipOverdue));
  await page.evaluate(() => closeJobModal());

  // ═══ 15. Completed jobs + undated steps excluded; empty → tl_empty ══════
  const exclusion = await page.evaluate(async () => {
    // Undated steps never appear: total marks must equal dated-step count.
    const datedCount = jobs.filter(j => !jobComplete(j))
      .reduce((n, j) => n + (j.subTasks || []).filter(st => st.dateType && st.date).length, 0);
    renderPipeline();
    const marks = document.querySelectorAll('.tl-pt, .tl-bar, .tl-flag').length;
    // Complete every job that has dated steps → tl_empty card.
    const touched = jobs.filter(j => !jobComplete(j) && (j.subTasks || []).some(st => st.dateType && st.date));
    for (const j of touched) { j.complete = true; await dbPut('jobs', j); }
    renderPipeline();
    const rows = document.querySelectorAll('.tl-row').length;
    const empty = document.querySelector('#pipeline-body .kb-empty')?.textContent || '';
    for (const j of touched) { j.complete = false; await dbPut('jobs', j); }
    renderPipeline();
    return { datedCount, marks, rows, empty };
  });
  assert(exclusion.marks === exclusion.datedCount,
    '15: timeline marks = dated steps only (undated excluded), got ' + JSON.stringify(exclusion));
  assert(exclusion.rows === 0 && exclusion.empty.includes('ยังไม่มีขั้นตอนที่ระบุวันที่'),
    '15: completed jobs excluded → Thai tl_empty card, got ' + JSON.stringify({ rows: exclusion.rows, empty: exclusion.empty }));

  // ═══ 16. Timeline row label opens the job editor ════════════════════════
  await page.evaluate(() => document.querySelector('.tl-label').click());
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.getElementById('modal-job').classList.contains('open')),
    '16: tapping a timeline row label opens the job edit modal');
  await page.evaluate(() => closeJobModal());

  // ═══ 19. Thai default strings; EN after switching ═══════════════════════
  // TSK-012: the gate itself moved off #modal-appt onto the inline gate card
  // (openGateCard()/gateCardHtml()) — 'add'/'repeat'/'edit' modal modes are
  // untouched and still exercised elsewhere in this suite (§2/§11/§18).
  const thai = await page.evaluate(id => {
    setPipelineView('board');   // §12-16 left the pipeline on the timeline view — the gate card only renders on the board
    selectPipelineStage(jobStage(jobs.find(j => j.id === id)));   // the gate card only renders for the active stage group
    openGateCard(id, 'booked');   // Quote → Booked gate copy
    const g = () => document.querySelector('.gate-title')?.textContent.trim();
    const gc = () => document.querySelector('.gate-context')?.textContent.trim();
    const out = { lang: curLang(), title: g(), context: gc() };
    closeGateCard();
    return out;
  }, jobA);
  assert(thai.lang === 'th' && thai.title === 'ลูกค้ายอมรับแล้ว 🎉' && thai.context === 'เลือกวันนัดครั้งถัดไป',
    '19: inline gate renders Thai strings by default, got ' + JSON.stringify(thai));
  const thaiToggle = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pl-view-seg button')).map(b => b.textContent.trim()));
  assert(thaiToggle[0] === 'บอร์ด' && thaiToggle[1] === 'ไทม์ไลน์', '19: view toggle Thai, got ' + JSON.stringify(thaiToggle));
  await page.evaluate(async () => { await onLangChange('en'); renderPipeline(); });
  await page.waitForTimeout(300);
  const en = await page.evaluate(id => {
    selectPipelineStage(jobStage(jobs.find(j => j.id === id)));
    openGateCard(id, 'booked');
    const g = () => document.querySelector('.gate-title')?.textContent.trim();
    const gc = () => document.querySelector('.gate-context')?.textContent.trim();
    const out = { title: g(), context: gc(),
      toggle: Array.from(document.querySelectorAll('.pl-view-seg button')).map(b => b.textContent.trim()) };
    closeGateCard();
    return out;
  }, jobA);
  assert(en.title === 'Client accepted 🎉' && en.context === 'Pick the session date.'
    && en.toggle[0] === 'Board' && en.toggle[1] === 'Timeline',
    '19: switching to EN renders the EN gate copy, got ' + JSON.stringify(en));
  await page.evaluate(async () => { await onLangChange('th'); renderPipeline(); });
  await page.waitForTimeout(300);

  // ═══ 20. Legacy job records load, render, toggle, advance cleanly ═══════
  const legacyId = await page.evaluate(async () => {
    const j = { uid: currentUser.id, date: todayISO(), client: 'Gate Client', clientId: window.__cid,
      serviceId: null, serviceName: 'Legacy svc', jobType: '', amount: 100, tip: 0, expense: 0,
      count: 1, notes: '', netAmount: 100, cuid: cuid(), stageOrder: getStageOrder().slice(),
      stage: getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
      packageId: null, updatedAt: nowISO(),
      subTasks: [{ id: cuid(), text: 'Legacy sub', done: false }] };   // no dateType, no pendingGateStage
    const id = await dbPut('jobs', j);
    await reload();
    return id;
  });
  await page.evaluate(id => openEditJob(id), legacyId);
  await page.waitForTimeout(300);
  const legacyRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'));
    const r = rows.find(x => x.textContent.includes('Legacy sub'));
    return r ? { chip: !!r.querySelector('.st-chip'), repeat: Array.from(r.querySelectorAll('button')).some(b => b.textContent.trim() === '↻') } : null;
  });
  assert(legacyRow && !legacyRow.chip && !legacyRow.repeat, '20: legacy undated row renders with no chip / no ↻');
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('#job-subtasks-body .list-row'))
      .find(x => x.textContent.includes('Legacy sub')).click();
  });
  await page.waitForTimeout(200);
  assert(await job(legacyId, `j.subTasks[0].done === true`), '20: legacy sub-task toggles');
  await page.evaluate(() => closeJobModal());
  await page.evaluate(id => advanceJobStage(id), legacyId);
  await page.waitForSelector('.gate-card', { timeout: 5000 });
  assert(await job(legacyId, '!!j.pendingGateStage'), '20: legacy job advances and gates without errors');
  await page.click('.gate-btn-secondary');
  await page.waitForTimeout(400);

  // ═══ 18. Backend mirror payload includes job_cuid ═══════════════════════
  // Enable the real dataClient mirror with a fake token and capture the
  // outgoing request instead of stubbing SidekickBackend away — this
  // exercises the actual client-side payload construction (bookingsMirror).
  await page.evaluate(() => {
    localStorage.setItem('sidekick_backend_token', 'test-token');
    window.__capturedRequests = [];
    window.__realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      window.__capturedRequests.push({ url: String(url), body: opts && opts.body ? opts.body : null });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  });
  await page.evaluate(id => openApptModal({ mode: 'add', jobId: id }), jobA);
  await page.waitForSelector('#modal-appt', { timeout: 5000 });
  await page.fill('#ap-step', 'Mirrored step');
  await page.fill('#ap-date', dPlus6);
  await page.click('#ap-save');
  await page.waitForTimeout(600);
  const mirror = await page.evaluate(id => {
    const j = jobs.find(x => x.id === id);
    const req = window.__capturedRequests.find(r => r.url.includes('/api/app-bookings'));
    localStorage.removeItem('sidekick_backend_token');
    window.fetch = window.__realFetch;
    return { jobCuid: j.cuid, req: req ? { url: req.url, body: JSON.parse(req.body) } : null };
  }, jobA);
  assert(mirror.req && mirror.req.body.job_cuid === mirror.jobCuid,
    '18: mirrored booking payload includes job_cuid = job.cuid, got ' + JSON.stringify(mirror.req && mirror.req.body));
  assert(mirror.req && mirror.req.body.title && mirror.req.body.title.includes('Mirrored step'),
    '18: mirrored payload carries the step title');
  // Server side accepts the field: API FIELDS + schema column present.
  const apiSrc = fs.readFileSync(require('path').join(__dirname, '../api/app-bookings.js'), 'utf8');
  const sqlSrc = fs.readFileSync(require('path').join(__dirname, '../sql/schema-core.sql'), 'utf8');
  assert(/'job_cuid'/.test(apiSrc), '18: api/app-bookings.js FIELDS includes job_cuid');
  assert(/job_cuid\s+text/.test(sqlSrc) && /alter table app_bookings add column if not exists job_cuid text/.test(sqlSrc),
    '18: schema-core.sql has the job_cuid column + idempotent migration');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
