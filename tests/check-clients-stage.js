const { chromium } = require('playwright');

// Covers the Clients screen's engagement-stage pill, service-prospect line,
// search box, and filter chips (clientStage()/clientProspectService() in
// app.js + renderCustomers()). Same structure/conventions as
// check-options-lost.js: fresh registered account (zero seeded data), a
// client+job factory installed via page.evaluate against dbAdd/dbPut, IDB
// seeded directly for hard-to-reach engagement states.

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];

  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'clstage-test-' + Date.now());
  await page.fill('#auth-name', 'Client Stage Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)'); // trainer persona
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // Client + job factory (same in-page pattern as check-options-lost.js).
  const installHelpers = () => page.evaluate(async () => {
    window.__mkClient = async function (name) {
      const id = await dbAdd('clients', { uid: currentUser.id, name, phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
      await reload();
      return id;
    };
    window.__mkJob = async function (clientId, serviceName, stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: '', clientId,
        serviceId: null, serviceName, jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, outcome: null, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkClient = (name) => page.evaluate(n => window.__mkClient(n), name);
  const mkJob = (clientId, serviceName, stage, extra) =>
    page.evaluate(args => window.__mkJob(args[0], args[1], args[2], args[3]), [clientId, serviceName, stage || null, extra || null]);

  const stamp = Date.now();
  const activeName = `Active-${stamp}`;
  const inquiryName = `Inquiry-${stamp}`;
  const lostName = `Lost-${stamp}`;
  const zeroName = `Zero-${stamp}`;

  const activeId = await mkClient(activeName);
  await mkJob(activeId, '1-on-1 session', 'paid'); // reaches 'paid' → jobEarned → active-customer

  const inquiryId = await mkClient(inquiryName);
  await mkJob(inquiryId, 'Nutrition plan', 'quote'); // in progress, not earned, not lost

  const lostId = await mkClient(lostName);
  await mkJob(lostId, 'Group class', 'quote', { outcome: 'lost' }); // never earned, most recent job lost

  const zeroId = await mkClient(zeroName);
  void zeroId; // zero jobs — no factory call

  await page.evaluate(() => window.switchScreen && window.switchScreen('customers'));
  await page.waitForTimeout(400);

  const rowFor = (name) => page.locator('#customers-body .list-row', { hasText: name }).first();

  // ═══ 1. Stage pill + color class per stage ══════════════════════════════
  const activePill = rowFor(activeName).locator('.stage-pill');
  assert(await activePill.count() === 1, '1: active-customer row has a stage pill');
  assert(await activePill.evaluate(el => el.classList.contains('stage-pill-active')), '1: active-customer pill uses stage-pill-active');
  const activeLabel = await page.evaluate(() => t('client_stage_active'));
  assert((await activePill.textContent()).trim() === activeLabel, '1: active-customer pill label matches i18n, got: ' + (await activePill.textContent()));

  const inquiryPill = rowFor(inquiryName).locator('.stage-pill');
  assert(await inquiryPill.evaluate(el => el.classList.contains('stage-pill-inquiry')), '1: inquiry row pill uses stage-pill-inquiry');
  const inquiryLabel = await page.evaluate(() => t('client_stage_inquiry'));
  assert((await inquiryPill.textContent()).trim() === inquiryLabel, '1: inquiry pill label matches i18n');

  const lostPill = rowFor(lostName).locator('.stage-pill');
  assert(await lostPill.evaluate(el => el.classList.contains('stage-pill-lost')), '1: lost row pill uses stage-pill-lost');
  const lostLabel = await page.evaluate(() => t('client_stage_lost'));
  assert((await lostPill.textContent()).trim() === lostLabel, '1: lost pill label matches i18n');

  // ═══ 2. Service-prospect text shows the most-recent job's service name ══
  const activeSub = await rowFor(activeName).locator('.list-sub').textContent();
  assert(activeSub.includes('1-on-1 session'), '2: active client sub-line shows its most-recent job service name, got: ' + activeSub);
  const inquirySub = await rowFor(inquiryName).locator('.list-sub').textContent();
  assert(inquirySub.includes('Nutrition plan'), '2: inquiry client sub-line shows its service name, got: ' + inquirySub);

  // ═══ 3. Zero-job client: 'inquiry' stage + no-engagement-yet fallback ════
  const zeroPill = rowFor(zeroName).locator('.stage-pill');
  assert(await zeroPill.evaluate(el => el.classList.contains('stage-pill-inquiry')), '3: zero-job client classified inquiry');
  const noEngagementText = await page.evaluate(() => t('no_engagement_yet'));
  const zeroSub = await rowFor(zeroName).locator('.list-sub').textContent();
  assert(zeroSub.includes(noEngagementText), '3: zero-job client shows the no-engagement-yet fallback, got: ' + zeroSub);

  // ═══ 4. Search filters the list live, case-insensitively ════════════════
  await page.fill('#client-search', activeName.toLowerCase());
  await page.waitForTimeout(200);
  let visibleRows = await page.locator('#customers-body .list-row').count();
  assert(visibleRows === 1, '4: search narrows list to 1 matching row, got ' + visibleRows);
  assert(await rowFor(activeName).count() === 1, '4: the matching row is the searched-for client');
  await page.fill('#client-search', '');
  await page.waitForTimeout(200);
  visibleRows = await page.locator('#customers-body .list-row').count();
  assert(visibleRows === 4, '4: clearing search restores all 4 clients, got ' + visibleRows);

  // ═══ 5. Filter chips filter correctly and show live counts ══════════════
  const chipCount = async (key) => parseInt(await page.locator(`.pl-chip[onclick="selectClientFilterStage('${key}')"] .pl-chip-count`).textContent(), 10);
  assert(await chipCount('all') === 4, '5: All chip count is 4');
  assert(await chipCount('active-customer') === 1, '5: Active customer chip count is 1');
  assert(await chipCount('inquiry') === 2, '5: Inquiry chip count is 2 (in-progress + zero-job)');
  assert(await chipCount('lost') === 1, '5: Lost customer chip count is 1');

  await page.click(`.pl-chip[onclick="selectClientFilterStage('active-customer')"]`);
  await page.waitForTimeout(200);
  assert(await page.locator('#customers-body .list-row').count() === 1, '5: Active customer chip filters list to 1 row');
  assert(await rowFor(activeName).count() === 1, '5: filtered row is the active-customer client');
  assert(await page.locator(`.pl-chip[onclick="selectClientFilterStage('active-customer')"]`).evaluate(el => el.classList.contains('active')), '5: clicked chip gets the active class');

  await page.click(`.pl-chip[onclick="selectClientFilterStage('lost')"]`);
  await page.waitForTimeout(200);
  assert(await page.locator('#customers-body .list-row').count() === 1, '5: Lost customer chip filters list to 1 row');
  assert(await rowFor(lostName).count() === 1, '5: filtered row is the lost client');

  await page.click(`.pl-chip[onclick="selectClientFilterStage('inquiry')"]`);
  await page.waitForTimeout(200);
  assert(await page.locator('#customers-body .list-row').count() === 2, '5: Inquiry chip filters list to 2 rows');

  await page.click(`.pl-chip[onclick="selectClientFilterStage('all')"]`);
  await page.waitForTimeout(200);
  assert(await page.locator('#customers-body .list-row').count() === 4, '5: All chip restores all 4 rows');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
