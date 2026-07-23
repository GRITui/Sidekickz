/* Acceptance suite for TSK-008 — Job modal Quick log / Full details split
 * (design-handoff README §2). Covers the segmented control itself, the
 * field visibility it drives, the live net-take box on both paths, the
 * de-escalated Cancel button, the 4 drill-row summaries + their open/close
 * behavior, the edit-mode Quick-vs-Full default decision (full when the job
 * already carries data in a "full" field), and a from-scratch Quick-log-only
 * save.
 *
 * This suite does NOT re-test the sub-features' own mechanics (options
 * booking hooks, milestone gating, item catalog snapshotting, timer ticking,
 * etc.) — those stay covered by check-options-lost.js/check-items.js/
 * check-merges.js/check-scheduling.js, updated alongside this suite to open
 * the relevant drill row before interacting with it (see those files'
 * TSK-008 comments). This suite only proves the new presentation layer
 * itself: segment, drill rows, and the mode-default decision.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-job-modal-v2.js
 * Expects http://localhost:8923 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8923';
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

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
  await page.fill('#auth-user', 'jm2-' + Date.now());
  await page.fill('#auth-name', 'JobModal2 Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);

  const installHelpers = () => page.evaluate(async () => {
    window.__cid = await dbAdd('clients', { uid: currentUser.id, name: 'JM2 Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    await reload();   // customers[] must be refreshed before openAddJob()'s populateJobSelects() runs
    window.__mkJob = async function (over) {
      const j = Object.assign({
        uid: currentUser.id, date: todayISO(), client: 'JM2 Client', clientId: window.__cid,
        serviceId: null, serviceName: '', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 0, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO(),
      }, over || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkJob = (over) => page.evaluate(o => window.__mkJob(o), over || null);
  const job = (id, expr) => page.evaluate(args => { const j = jobs.find(x => x.id === args[0]); return eval(args[1]); }, [id, expr]);
  const segState = () => page.evaluate(() => ({
    quickOn: document.getElementById('seg-job-quick').classList.contains('on'),
    fullOn: document.getElementById('seg-job-full').classList.contains('on'),
  }));
  const fieldDisplay = (id) => page.evaluate(i => getComputedStyle(document.getElementById(i)).display, id);

  // ═══ 1. Add-mode defaults to Quick log; right fields shown/hidden ══════
  await page.evaluate(() => openAddJob());
  await page.waitForTimeout(200);
  let seg = await segState();
  assert(seg.quickOn && !seg.fullOn, '1: add-mode opens on Quick log, got ' + JSON.stringify(seg));
  assert(await fieldDisplay('j-service-field') === 'none', '1: Quick log hides Service');
  assert(await fieldDisplay('j-full-row') === 'none', '1: Quick log hides Expense/Sessions');
  assert(await fieldDisplay('j-notes-field') === 'none', '1: Quick log hides Notes');
  assert(await fieldDisplay('j-amount') !== 'none', '1: Quick log still shows Fee (Fee|Tip stays on both paths)');
  assert(await fieldDisplay('j-tip') !== 'none', '1: Quick log still shows Tip');
  assert(await page.evaluate(() => getComputedStyle(document.getElementById('job-tracking-section')).display) === 'none',
    '1: add-mode never shows the tracking section (no saved job id yet), even on Quick log');

  // ═══ 2. Switching to Full details reveals the rest; add-mode still hides
  //         the tracking section (nothing to attach sub-features to yet) ═══
  await page.evaluate(() => setJobModalMode('full'));
  await page.waitForTimeout(100);
  seg = await segState();
  assert(!seg.quickOn && seg.fullOn, '2: segment flips to Full details');
  assert(await fieldDisplay('j-service-field') !== 'none', '2: Full details shows Service');
  assert(await fieldDisplay('j-full-row') !== 'none', '2: Full details shows Expense/Sessions');
  assert(await fieldDisplay('j-notes-field') !== 'none', '2: Full details shows Notes');
  assert(await page.evaluate(() => getComputedStyle(document.getElementById('job-tracking-section')).display) === 'none',
    '2: Full details in add-mode STILL hides the tracking section — no job id to attach sub-features to yet');
  await page.evaluate(() => setJobModalMode('quick'));
  await page.waitForTimeout(100);
  assert(await fieldDisplay('j-notes-field') === 'none', '2: switching back to Quick re-hides Notes');

  // ═══ 3. Net-take recomputes live on the Quick path (expense defaults 0) ═
  await page.fill('#j-amount', '1000');
  await page.fill('#j-tip', '200');
  await page.waitForTimeout(100);
  let net = await page.locator('#j-net').textContent();
  assert(net.includes('1,200') || net.includes('1200'), '3: Quick-path net = fee+tip (expense untouched → 0), got ' + net);

  // ═══ 4. Net-take recomputes live on the Full path (expense subtracted) ═
  await page.evaluate(() => setJobModalMode('full'));
  await page.fill('#j-expense', '300');
  await page.waitForTimeout(100);
  net = await page.locator('#j-net').textContent();
  assert(net.includes('900'), '4: Full-path net = fee+tip-expense (1000+200-300=900), got ' + net);
  // clear the expense back out so it doesn't leak into test 6's save
  await page.fill('#j-expense', '');
  await page.waitForTimeout(100);

  // ═══ 5. Cancel is de-escalated to plain-text, Save stays full-width brand ═
  const btnClasses = await page.evaluate(() => {
    // Save/Delete/Cancel are the 3 direct-child buttons of .modal itself
    // (everything else — fastpath, drill-row buttons, etc. — is nested
    // deeper inside .form-section/#job-tracking-section).
    const btns = Array.from(document.querySelectorAll('#modal-job > .modal > button'));
    return btns.map(b => ({ text: b.textContent.trim(), cls: b.className }));
  });
  const cancelBtn = btnClasses.find(b => /cancel/i.test(b.text) || b.text === 'ยกเลิก');
  const saveBtn = btnClasses.find(b => /save/i.test(b.text) || b.text.includes('บันทึก'));
  assert(!!cancelBtn && !cancelBtn.cls.includes('btn-danger'), '5: Cancel button no longer carries .btn-danger, got ' + JSON.stringify(cancelBtn));
  assert(!!cancelBtn && cancelBtn.cls.includes('btn-text'), '5: Cancel button uses the existing plain-text .btn-text class, got ' + JSON.stringify(cancelBtn));
  assert(!!saveBtn && saveBtn.cls.includes('btn-submit'), '5: Save stays the full-width primary .btn-submit button, got ' + JSON.stringify(saveBtn));

  // ═══ 6. A from-scratch new job saves correctly via Quick log alone ═════
  await page.evaluate(() => setJobModalMode('quick'));
  await page.waitForTimeout(100);
  await page.selectOption('#j-customer', String(await page.evaluate(() => window.__cid)));
  await page.fill('#j-amount', '800');
  await page.fill('#j-tip', '50');
  await page.evaluate(() => saveJob());
  await page.waitForTimeout(400);
  const newJob = await page.evaluate(async () => {
    const all = await dbAll('jobs');
    return all.filter(j => j.clientId === window.__cid).sort((a, b) => b.id - a.id)[0];
  });
  assert(!!newJob, '6: a new job was actually created');
  assert(newJob.amount === 800 && newJob.tip === 50 && newJob.expense === 0,
    '6: Quick-log-only save carries fee/tip and defaults expense to 0, got ' + JSON.stringify({ amount: newJob.amount, tip: newJob.tip, expense: newJob.expense }));
  assert(newJob.netAmount === 850, '6: netAmount computed fee+tip-expense, got ' + newJob.netAmount);

  // ═══ 7. Editing a genuinely empty job defaults to Quick log ═══════════
  const bareJob = await mkJob();
  await page.evaluate(id => openEditJob(id), bareJob);
  await page.waitForTimeout(300);
  seg = await segState();
  assert(seg.quickOn && !seg.fullOn, '7: editing a job with nothing in the "full" fields defaults to Quick log, got ' + JSON.stringify(seg));
  assert(await page.evaluate(() => getComputedStyle(document.getElementById('job-tracking-section')).display) === 'none',
    '7: Quick-log edit view keeps the tracking section (drill rows) hidden');
  await page.evaluate(() => closeJobModal());

  // ═══ 8. Editing a job that already has sub-feature data opens straight
  //         into Full details — an edit must never hide existing data ═════
  const nowStamp = new Date().toISOString();
  const fullJob = await mkJob({
    options: [{ id: 'o1', name: 'Opt A', status: 'considering', note: '' }, { id: 'o2', name: 'Opt B', status: 'interested', note: '' }],
    items: [{ id: 'i1', serviceId: null, name: 'Extra item', qty: 1, unitPrice: 100 }],
    subTasks: [{ id: 's1', text: 'Step 1', done: false }, { id: 's2', text: 'Step 2', done: true }],
    milestones: [{ id: 'm1', pct: 50, amount: 500, gatingSubTaskId: null }],
    timeEntries: [{ id: 't1', minutes: 125, startedAt: nowStamp, endedAt: nowStamp, invoiced: false }],
  });
  await page.evaluate(id => openEditJob(id), fullJob);
  await page.waitForTimeout(300);
  seg = await segState();
  assert(!seg.quickOn && seg.fullOn, '8: editing a job with existing options/items/plan/time defaults straight to Full details, got ' + JSON.stringify(seg));
  assert(await page.evaluate(() => getComputedStyle(document.getElementById('job-tracking-section')).display) !== 'none',
    '8: Full-details edit view shows the tracking section (drill rows)');

  // ═══ 9. Each of the 4 drill rows shows the right "· N" count and starts
  //         closed; tapping its summary opens the underlying sub-view ═════
  const counts = await page.evaluate(() => ({
    options: document.getElementById('job-options-count').textContent,
    items: document.getElementById('job-items-count').textContent,
    plan: document.getElementById('job-plan-count').textContent,
    time: document.getElementById('job-time-count').textContent,
  }));
  assert(counts.options.includes('2'), '9: options drill row shows count 2, got ' + JSON.stringify(counts.options));
  assert(counts.items.includes('1'), '9: items drill row shows count 1, got ' + JSON.stringify(counts.items));
  assert(counts.plan.includes('2') && counts.plan.includes('1'), '9: plan drill row shows 2 steps + 1 milestone, got ' + JSON.stringify(counts.plan));
  assert(counts.time.includes('2:05'), '9: time tracking drill row shows total logged time 2:05 (125 min), got ' + JSON.stringify(counts.time));

  const openStates = ['job-options-details', 'job-items-details', 'job-plan-details', 'job-time-details'];
  for (const id of openStates) {
    const openBefore = await page.evaluate(i => document.getElementById(i).open, id);
    assert(openBefore === false, `9: ${id} starts closed`);
  }
  // Tap the options drill row's own summary (real click, not JS-forced) —
  // this is the actual user affordance the design calls for.
  await page.click('#job-options-details summary');
  await page.waitForTimeout(100);
  const optionsOpenAfter = await page.evaluate(() => document.getElementById('job-options-details').open);
  assert(optionsOpenAfter === true, '9: tapping the options summary opens the drill row');
  const optionsBodyVisible = await page.locator('#job-options-body .list-row').first().isVisible();
  assert(optionsBodyVisible, '9: once open, the real options list (2 rows) is visible/interactable');
  const optionRowCount = await page.locator('#job-options-body .list-row').count();
  assert(optionRowCount === 2, '9: options drill row reveals exactly the 2 options that were counted, got ' + optionRowCount);

  await page.evaluate(() => closeJobModal());

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
