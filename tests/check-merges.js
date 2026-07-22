/* Acceptance suite for "M4 Pass P3 — two consolidation merges":
 *
 * MERGE 1 (UI-only): the job modal's separate "Sub-tasks" and "Milestone
 *   payments" sections fold into one "Plan & payments" section. The
 *   underlying data model is untouched — milestones stay payment-schedule
 *   entries ({id, pct, amount, gatingSubTaskId}), categorically not steps —
 *   so this suite drives the real lock/unlock + draft-invoice mechanics to
 *   prove zero behavior change, not just that markup moved.
 *
 * MERGE 2 (data migration): a realestate client's deals[] migrates ONCE,
 *   non-destructively, into option rows on one of that client's own jobs
 *   (creating a job only if none is open), with any future-dated viewing
 *   becoming a real dated step + calendar booking. The client modal's old
 *   deals CRUD is replaced by a read-through "Properties in play" section.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-merges.js
 * Expects http://localhost:9023 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:9023';
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });

  // ═════════════════════════════════════════════════════════════════════
  // PART A — Merge 1: "Plan & payments" (trainer persona, registered acct)
  // ═════════════════════════════════════════════════════════════════════
  const errorsA = [];
  const pageA = await browser.newPage({ viewport: { width: 320, height: 700 } });
  pageA.on('console', msg => { if (msg.type() === 'error') errorsA.push(msg.text()); });
  pageA.on('pageerror', err => errorsA.push(String(err)));

  await pageA.goto(BASE + '/login.html');
  await pageA.click('#tab-register');
  await pageA.fill('#auth-user', 'merges' + Date.now());
  await pageA.fill('#auth-name', 'Merges Tester');
  await pageA.fill('#auth-pass', 'pass1234');
  await pageA.fill('#auth-confirm', 'pass1234');
  await pageA.click('#auth-submit');
  await pageA.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await pageA.click('#modal-persona-onboard .list-row:nth-child(1)'); // trainer
  await pageA.waitForTimeout(500);
  await pageA.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await pageA.evaluate(async () => { await onLangChange('en'); });
  await pageA.waitForTimeout(200);

  const installHelpersA = () => pageA.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'Merge Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'Merge Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (serviceName, stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Merge Client', clientId: window.__cid,
        serviceId: null, serviceName, jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpersA();
  const mkJob = (name, stage, extra) =>
    pageA.evaluate(args => window.__mkJob(args[0], args[1], args[2]), [name, stage || null, extra || null]);
  const job = (id, expr) => pageA.evaluate(args => { const j = jobs.find(x => x.id === args[0]); return eval(args[1]); }, [id, expr]);
  const tA = (key) => pageA.evaluate(k => t(k), key);

  const jobA = await mkJob('Plan test job', 'inquiry');
  assert(typeof jobA === 'number', 'setup: job created for Merge 1 tests');
  await pageA.evaluate(id => openEditJob(id), jobA);
  await pageA.waitForTimeout(300);

  // ═══ 1. One "Plan & payments" header replaces the two separate headers ═
  const headerTitles = await pageA.evaluate(() =>
    Array.from(document.querySelectorAll('#job-tracking-section .section-title')).map(el => el.textContent.trim()));
  const planTitle = await tA('plan_section_title');
  const subtasksTitle = await tA('subtasks_title');
  const milestonesTitle = await tA('milestones_title');
  assert(headerTitles.filter(x => x === planTitle).length === 1,
    '1: exactly one "Plan & payments" header in the job modal, got: ' + JSON.stringify(headerTitles));
  assert(!headerTitles.includes(subtasksTitle), '1: separate "Sub-tasks" header no longer present');
  assert(!headerTitles.includes(milestonesTitle), '1: separate "Milestone payments" header no longer present');

  // ═══ 2. Both the steps list and milestone list render inside that section ═
  assert(await pageA.locator('#job-tracking-section #job-subtasks-body').count() === 1, '2: steps list container present in the section');
  assert(await pageA.locator('#job-tracking-section #job-milestones-body').count() === 1, '2: milestone list container present in the section');

  // TSK-008: Plan & payments now lives behind Full details + a collapsed
  // drill row — switch mode and pop the row open before the UI clicks below.
  await pageA.evaluate(() => { setJobModalMode('full'); document.getElementById('job-plan-details').open = true; });

  // ═══ 3. "+ Step with date" still creates a real dated step (mechanics intact) ═
  await pageA.click('#job-tracking-section button[data-i18n="appt_add_dated"]');
  await pageA.waitForSelector('#modal-appt', { timeout: 5000 });
  await pageA.fill('#ap-step', 'Site visit done');
  const futureDate = await pageA.evaluate(() => tlAddDays(todayISO(), 3));
  await pageA.fill('#ap-date', futureDate);
  await pageA.click('#ap-save');
  await pageA.waitForTimeout(400);
  const gateId = await job(jobA, `(j.subTasks.find(s => s.text === 'Site visit done') || {}).id`);
  assert(!!gateId, '3: dated step created inside the merged section (will gate the milestone)');
  const stepRowInSubtasksBody = await pageA.evaluate(() =>
    document.getElementById('job-subtasks-body').textContent.includes('Site visit done'));
  assert(stepRowInSubtasksBody, '3: the new dated step renders in #job-subtasks-body, unchanged location');

  // ═══ 4. Add a milestone gated on that step → renders Locked ═════════════
  await pageA.click('#job-tracking-section button[data-i18n="add_milestone"]');
  await pageA.waitForTimeout(200);
  await pageA.fill('#ms-pct', '50');
  await pageA.fill('#ms-amount', '2500');
  await pageA.selectOption('#ms-gate', gateId);
  await pageA.click('#job-milestones-body button[onclick*="saveMilestone"]');
  await pageA.waitForTimeout(300);
  const msId = await job(jobA, `(j.milestones && j.milestones[0] && j.milestones[0].id) || null`);
  assert(!!msId, '4: milestone saved with pct/amount/gatingSubTaskId — data model untouched');
  assert(await job(jobA, `!!(j.milestones[0].pct === 50 && j.milestones[0].amount === 2500 && j.milestones[0].gatingSubTaskId)`) === true,
    '4: milestone record shape is exactly {id, pct, amount, gatingSubTaskId}, not a step');
  const lockedHtml = await pageA.locator('#job-milestones-body').innerHTML();
  const lockedLabel = await tA('milestone_locked');
  assert(lockedHtml.includes(lockedLabel), '4: milestone shows "Locked" while its gating step is undone');

  // ═══ 5. Milestone rows carry a distinct visual badge; step rows do not ═
  const milestonesHtml = await pageA.evaluate(() => document.getElementById('job-milestones-body').innerHTML);
  const subtasksHtml = await pageA.evaluate(() => document.getElementById('job-subtasks-body').innerHTML);
  assert(milestonesHtml.includes('💰'), '5: milestone rows carry a distinct badge');
  assert(!subtasksHtml.includes('💰'), '5: step rows do NOT carry the milestone badge (visually distinct styles)');

  // ═══ 6. Completing the gating step unlocks the milestone ═══════════════
  await pageA.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#job-subtasks-body .list-row'));
    rows.find(r => r.textContent.includes('Site visit done')).click();
  });
  await pageA.waitForTimeout(300);
  assert(await job(jobA, `j.subTasks.find(s => s.text === 'Site visit done').done`) === true, '6: gating step marked done');
  const unlockedHtml = await pageA.locator('#job-milestones-body').innerHTML();
  const draftInvoiceLabel = await tA('draft_invoice');
  assert(unlockedHtml.includes(draftInvoiceLabel), '6: milestone unlocked — shows "Draft invoice" button');
  assert(!unlockedHtml.includes(lockedLabel), '6: "Locked" chip is gone once the gate resolves');

  // ═══ 7. Draft invoice → prefilled invoice form → save → milestone links ═
  await pageA.click('#job-milestones-body button[onclick*="draftMilestoneInvoice"]');
  await pageA.waitForSelector('#inv-form-modal.open', { timeout: 5000 });
  const lineDesc = await pageA.evaluate(() => (document.querySelector('.inv-line input[data-f="description"]') || {}).value || '');
  assert(lineDesc.includes('50%'), '7: invoice form line item prefilled from the milestone (50%), got: ' + lineDesc);
  const cnamePrefill = await pageA.inputValue('#inv-cname');
  assert(cnamePrefill === 'Merge Client', '7: invoice client name prefilled from the job, got: ' + cnamePrefill);
  await pageA.click('#inv-form-modal #inv-save');
  await pageA.waitForTimeout(600);
  assert(await job(jobA, `j.milestones[0].invoiceId != null`) === true, '7: milestone.invoiceId linked after the drafted invoice is saved');
  await pageA.evaluate(id => openEditJob(id), jobA);
  await pageA.waitForTimeout(300);
  const invoicedHtml = await pageA.locator('#job-milestones-body').innerHTML();
  const invoicedLabel = await tA('time_invoiced_label');
  assert(invoicedHtml.includes(invoicedLabel), '7: reopening the job shows the milestone as Invoiced');

  // ═══ 8. Trainer persona (non-realestate): client modal has no deals/
  //         properties section at all, zero behavioral change ═══════════
  await pageA.evaluate(id => openEditCustomer(id), await pageA.evaluate(() => window.__cid));
  await pageA.waitForSelector('#modal-customer.open', { timeout: 5000 });
  await pageA.waitForTimeout(300);
  const trainerTrackerHtml = await pageA.evaluate(() => document.getElementById('cust-persona-body').innerHTML);
  const optionsTitleLabel = await tA('client_options_title');
  assert(!trainerTrackerHtml.includes(optionsTitleLabel), '8: trainer persona client modal shows no "Properties in play" section');
  assert(!/deal/i.test(trainerTrackerHtml), '8: trainer persona client modal has no deal-related markup at all');
  await pageA.evaluate(() => closeCustomerModal());

  // ═════════════════════════════════════════════════════════════════════
  // PART B — Merge 2: deals[] → job options[] (realestate demo persona)
  // ═════════════════════════════════════════════════════════════════════
  const errorsB = [];
  const context = await browser.newContext();
  const pageB = await context.newPage({ viewport: { width: 320, height: 700 } });
  pageB.on('console', msg => { if (msg.type() === 'error') errorsB.push(msg.text()); });
  pageB.on('pageerror', err => errorsB.push(String(err)));

  await pageB.goto(BASE + '/login.html?demo=1');
  await pageB.waitForTimeout(300);
  await pageB.waitForURL('**/index.html', { timeout: 5000 }).catch(() => {});
  await pageB.waitForTimeout(400);
  await pageB.click('#modal-persona-onboard .list-row:nth-child(2)'); // realestate
  await pageB.waitForTimeout(800);
  await pageB.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await pageB.evaluate(async () => { await onLangChange('en'); });
  await pageB.waitForTimeout(200);
  const tB = (key) => pageB.evaluate(k => t(k), key);

  // ── Inject a FUTURE viewing onto the demo client's dormant deal, then
  //    open her client modal — this is what actually triggers the migration.
  const setup = await pageB.evaluate(async () => {
    const c = customers.find(x => x.name === 'Ann Thongchai');
    if (!c) return null;
    const future = tlAddDays(todayISO(), 4);
    c.deals[0].viewings.push({ id: cuid(), date: future, verdict: 'interested' });
    await dbPut('clients', c);
    const existingJob = jobs.find(j => j.clientId === c.id);
    return {
      id: c.id, future,
      dealProperty: c.deals[0].property, dealStage: c.deals[0].stage, dealCommission: c.deals[0].commission,
      dealNotes: c.deals[0].notes, dealsCountBefore: c.deals.length, viewingsCountBefore: c.deals[0].viewings.length,
      existingJobId: existingJob ? existingJob.id : null,
    };
  });
  assert(!!setup, 'setup: demo seeded realestate client "Ann Thongchai" with a deal');
  assert(!!setup.existingJobId, 'setup: Ann already has an open (non-complete) demo job — reuse branch will be exercised');

  await pageB.evaluate(id => openEditCustomer(id), setup.id);
  await pageB.waitForSelector('#modal-customer.open', { timeout: 5000 });
  await pageB.waitForFunction(async (id) => {
    const c = await dbGet('clients', id);
    return !!(c && c.dealsMigratedAt);
  }, setup.id, { timeout: 8000 }).catch(() => {});

  const migrated = await pageB.evaluate(async (input) => {
    const c = await dbGet('clients', input.id);
    const allJobs = (await dbAll('jobs')).filter(j => j.clientId === input.id);
    const targetJob = allJobs.find(j => (j.options || []).some(o => o.name === input.dealProperty));
    const opt = targetJob ? targetJob.options.find(o => o.name === input.dealProperty) : null;
    const step = targetJob ? (targetJob.subTasks || []).find(s => s.date === input.future && s.dateType === 'exact') : null;
    const bk = step ? (await dbAll('bookings')).find(b => b.cuid === step.bookingCuid) : null;
    const expectedNotes = [c.deals[0].notes, c.deals[0].commission ? ('commission ' + money(c.deals[0].commission)) : '']
      .filter(Boolean).join(' · ');
    return {
      dealsMigratedAt: c.dealsMigratedAt,
      dealsCountAfter: (c.deals || []).length, dealsPropertyAfter: c.deals[0].property,
      viewingsCountAfter: (c.deals[0].viewings || []).length,
      jobCount: allJobs.length, targetJobId: targetJob ? targetJob.id : null,
      optStatus: opt ? opt.status : null, optNotesMatch: opt ? opt.notes === expectedNotes : false,
      stepFound: !!step, bookingFound: !!bk, bookingDate: bk ? bk.date : null, bookingJobCuid: bk ? bk.jobCuid : null,
      targetJobCuid: targetJob ? targetJob.cuid : null,
    };
  }, setup);

  // ═══ 9. Migration ran and stamped dealsMigratedAt ═══════════════════════
  assert(!!migrated.dealsMigratedAt, '9: client.dealsMigratedAt stamped after the migration runs');

  // ═══ 10. Raw deals[] is untouched — non-destructive rollback data ══════
  assert(migrated.dealsCountAfter === setup.dealsCountBefore, '10: raw client.deals[] length unchanged');
  assert(migrated.dealsPropertyAfter === setup.dealProperty, '10: raw deal.property left exactly as-is');
  assert(migrated.viewingsCountAfter === setup.viewingsCountBefore, '10: raw deal.viewings[] (incl. the injected future one) left exactly as-is');

  // ═══ 11. Existing non-complete job is REUSED, not duplicated ═══════════
  assert(migrated.jobCount === 1, '11: exactly one job for the client after migration (existing job reused), got ' + migrated.jobCount);
  assert(migrated.targetJobId === setup.existingJobId, '11: migration attached options to the client\'s existing open job, not a new one');

  // ═══ 12. Stage → option status mapping ══════════════════════════════════
  const expectedStatus = { searching: 'viewing', viewing: 'viewing', offer: 'interested', negotiating: 'interested', closing: 'chosen', closed: 'chosen' }[setup.dealStage];
  assert(migrated.optStatus === expectedStatus, `12: deal stage "${setup.dealStage}" mapped to option status "${expectedStatus}", got ${migrated.optStatus}`);
  assert(migrated.optNotesMatch, '12: option notes built from [deal.notes, commission] joined with " · "');

  // ═══ 13. Future viewing → dated 'exact' step + real calendar booking ════
  assert(migrated.stepFound, '13: the future-dated viewing produced a dated exact sub-task on the job');
  assert(migrated.bookingFound && migrated.bookingDate === setup.future && migrated.bookingJobCuid === migrated.targetJobCuid,
    '13: that step created a real linked calendar booking on the right date, got ' + JSON.stringify({ bookingFound: migrated.bookingFound, bookingDate: migrated.bookingDate }));

  // ═══ 14. Reopening the client modal does NOT re-run the migration or
  //          duplicate options (idempotent — stamp + in-flight guard) ═════
  await pageB.evaluate(() => closeCustomerModal());
  await pageB.waitForTimeout(200);
  await pageB.evaluate(id => openEditCustomer(id), setup.id);
  await pageB.waitForSelector('#modal-customer.open', { timeout: 5000 });
  await pageB.waitForTimeout(600);
  const reopened = await pageB.evaluate(async (id) => {
    const allJobs = (await dbAll('jobs')).filter(j => j.clientId === id);
    const opts = allJobs.flatMap(j => j.options || []);
    return { jobCount: allJobs.length, optCount: opts.length };
  }, setup.id);
  assert(reopened.jobCount === 1, '14: reopening the client modal creates no extra job, got ' + reopened.jobCount);
  assert(reopened.optCount === 1, '14: reopening the client modal does not duplicate the option, got ' + reopened.optCount);

  // ═══ 15. Read-through "Properties in play" section lists the option +
  //          status, with a working "Open engagement →" link ══════════════
  const readThroughHtml = await pageB.evaluate(() => document.getElementById('cust-persona-body').innerHTML);
  const clientOptionsTitle = await tB('client_options_title');
  const optionStatusLabel = await tB('option_status_' + expectedStatus);
  const openEngagementLabel = await tB('open_engagement_link');
  assert(readThroughHtml.includes(clientOptionsTitle), '15: read-through section header "Properties in play" renders');
  assert(readThroughHtml.includes(setup.dealProperty), '15: read-through section lists the option name');
  assert(readThroughHtml.includes(optionStatusLabel), '15: read-through section shows the mapped status label');
  assert(readThroughHtml.includes(openEngagementLabel), '15: "Open engagement →" link renders');

  await pageB.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#cust-persona-body button'))
      .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes('openClientEngagement'));
    if (btn) btn.click();
  });
  await pageB.waitForTimeout(400);
  const afterLinkClick = await pageB.evaluate(() => ({
    custModalOpen: document.getElementById('modal-customer').classList.contains('open'),
    jobModalOpen: document.getElementById('modal-job').classList.contains('open'),
    editId: document.getElementById('j-edit-id').value,
  }));
  assert(!afterLinkClick.custModalOpen, '15: clicking "Open engagement →" closes the client modal');
  assert(afterLinkClick.jobModalOpen && parseInt(afterLinkClick.editId, 10) === migrated.targetJobId,
    '15: clicking "Open engagement →" opens the exact right job, got editId=' + afterLinkClick.editId);
  await pageB.evaluate(() => closeJobModal());

  // ═══ 16. A client with dormant deals but NO existing job gets a fresh
  //          job created for it (the other branch of the migration) ═══════
  const freshClient = await pageB.evaluate(async () => {
    const id = await dbAdd('clients', {
      uid: isGuest ? 'guest' : currentUser.id, name: 'Fresh Deal Client ' + Date.now(), phone: '', notes: '',
      cuid: cuid(), memberNo: 'SK-9999', updatedAt: nowISO(),
      deals: [{ id: cuid(), property: 'New Fresh Condo', stage: 'closed', commission: 50000, notes: 'Ready to close', viewings: [] }],
    });
    await reload();
    return { id };
  });
  await pageB.evaluate(id => openEditCustomer(id), freshClient.id);
  await pageB.waitForSelector('#modal-customer.open', { timeout: 5000 });
  await pageB.waitForFunction(async (id) => {
    const c = await dbGet('clients', id);
    return !!(c && c.dealsMigratedAt);
  }, freshClient.id, { timeout: 8000 }).catch(() => {});
  const freshResult = await pageB.evaluate(async (id) => {
    const allJobs = (await dbAll('jobs')).filter(j => j.clientId === id);
    const j = allJobs[0];
    return {
      jobCount: allJobs.length,
      serviceName: j ? j.serviceName : null,
      optStatus: j && j.options && j.options[0] ? j.options[0].status : null,
      dealsMigratedAt: (await dbGet('clients', id)).dealsMigratedAt,
    };
  }, freshClient.id);
  const expectedServiceName = await tB('deal_search_service');
  assert(freshResult.jobCount === 1, '16: a brand-new job was created for a client with deals but no existing job, got ' + freshResult.jobCount);
  assert(freshResult.serviceName === expectedServiceName, '16: the created job uses the deal_search_service name, got ' + freshResult.serviceName);
  assert(freshResult.optStatus === 'chosen', "16: stage 'closed' mapped to option status 'chosen', got " + freshResult.optStatus);
  assert(!!freshResult.dealsMigratedAt, '16: the new client also got dealsMigratedAt stamped');
  await pageB.evaluate(() => closeCustomerModal());

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors (Part A):', errorsA.length ? errorsA : 'none');
  console.log('Console/page errors (Part B):', errorsB.length ? errorsB : 'none');
  await browser.close();
  process.exit(fail > 0 || errorsA.length > 0 || errorsB.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
