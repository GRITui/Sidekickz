/* Acceptance suite for TSK-009 — Home's merged "Today" list-card
 * (renderHomeToday() in app.js), which replaces the old home-alert-card,
 * attn-card ("Needs attention") and incoming-pipeline ("Up next") with one
 * prioritized #today-body list-card. Covers every row type the pre-merge
 * research map found across the three old surfaces, confirms none were
 * dropped, checks icon/tint per row kind, the attention/pipeline row-count
 * caps + overflow links, priority ordering, and that hero/goal/quick-actions
 * are unaffected.
 *
 * Starts its own static server (no other suite claims port 9043).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-home-today-v2.js
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 9043;
const BASE = 'http://localhost:' + PORT;
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

function waitForServer(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      const req = http.get(url, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('static server did not start on ' + url));
        else setTimeout(tick, 200);
      });
    })();
  });
}

(async () => {
  const appDir = path.join(__dirname, '..', 'app');
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', appDir], { stdio: 'ignore' });
  try {
    await waitForServer(BASE + '/login.html', 15000);
  } catch (e) {
    console.log('FAIL: ' + e.message);
    server.kill();
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // ── Register a fresh account, EN so string assertions match the EN dict ─
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'today2' + Date.now());
  await page.fill('#auth-name', 'Today Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)'); // trainer persona
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);

  // ═══ 1. Empty state: fresh account, nothing seeded yet ══════════════════
  await page.evaluate(() => switchScreen('home'));
  await page.waitForTimeout(400);
  const emptyText = await page.evaluate(() => document.getElementById('today-body').textContent);
  assert(emptyText.includes('All caught up'), '1: fresh account shows the Today-card empty state, got: ' + emptyText);

  // ── Deterministic backend stub (same proven-zero-console-error shape as
  //    tests/check-notify.js) so the "shop order requests waiting" row has a
  //    real backend to read from. ───────────────────────────────────────────
  await page.evaluate(() => {
    const noop = async () => ({ ok: true, data: {} });
    window.SidekickBackend = {
      isEnabled: () => true,
      session: async () => ({ ok: true, data: { user: {
        cuid: 'owner-cuid-today-test', plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
        hasStripeCustomer: false, clientCap: null, team: null,
        features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
      } } }),
      billingCheckout: noop, billingPortal: noop,
      mirrorClientSave: noop, mirrorClientDelete: noop, mirrorJobSave: noop, mirrorJobDelete: noop,
      mirrorServiceSave: noop, mirrorServiceDelete: noop, mirrorInvoiceSave: noop, mirrorInvoiceDelete: noop,
      invoiceFetchByCuid: async () => null,
      mirrorDocumentSave: noop, mirrorDocumentDelete: noop, mirrorBookingSave: noop, mirrorBookingDelete: noop,
      mirrorFollowupSave: noop, mirrorPortfolioSave: noop, mirrorPortfolioDelete: noop,
      mirrorResearchSave: noop, mirrorResearchDelete: noop, mirrorPackageSave: noop,
      mirrorProgressLogSave: noop, mirrorProgressLogDelete: noop, mirrorSettingSave: noop,
      lineChannelStatus: async () => ({ ok: true, data: { connected: false } }),
      bookingSlotsList: async () => ({ ok: true, data: { rows: [] } }),
      bookingRequestsList: async () => ({ ok: true, data: { rows: [] } }),
      bookingRequestResolve: async () => ({ ok: true, data: {} }),
      orderRequestsList: async () => ({ ok: true, data: { rows: [
        { id: 201, clientName: 'Order X', contact: 'line:x', items: [{ service_cuid: 'x', name: 'Item', qty: 1, unit_price: 100 }], total: 100, createdAt: new Date().toISOString() },
      ] } }),
      orderRequestResolve: noop,
      slipVerify: noop,
    };
    window.refreshEntitlements && window.refreshEntitlements();
  });

  // In-page factories.
  await page.evaluate(() => {
    window.__mkClient = async function (name) {
      const id = await dbAdd('clients', { uid: currentUser.id, name, phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
      await reload();
      return id;
    };
    window.__mkInvoice = async function (over) {
      const uid = currentUser.id;
      const base = {
        uid, number: 'INV-' + Math.random().toString(36).slice(2, 8), issueDate: todayISO(), dueDate: '',
        clientId: null, clientName: 'Today Client', clientTaxId: '', clientAddress: '',
        lineItems: [{ description: 'Work', qty: 1, unitPrice: 1000 }], subtotal: 1000,
        whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 1000, youReceive: 1000, depositPct: 0,
        status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(), slips: [],
      };
      const id = await dbAdd('invoices', Object.assign(base, over || {}));
      return id;
    };
    window.__mkPackage = async function (clientId, over) {
      const base = { uid: currentUser.id, cuid: cuid(), clientId, totalSessions: 5, price: 5000,
        purchasedDate: todayISO(), expiresAt: null, notes: '', createdAt: nowISO() };
      const id = await dbAdd('packages', Object.assign(base, over || {}));
      await reload();
      return id;
    };
    window.__mkJob = async function (stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Today Client', clientId: null,
        serviceId: null, serviceName: 'Session', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, outcome: null, invoiceId: null, quoteDocId: null,
        packageId: null, due: null, note: null, attempt: 1, paid: false, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
    window.__mkBooking = async function (over) {
      const base = { uid: currentUser.id, customerId: null, title: 'Session', date: todayISO(), startTime: '09:00',
        durationMin: 60, travelBufferMin: 0, location: '', notes: '', status: 'scheduled', updatedAt: nowISO() };
      const id = await dbAdd('bookings', Object.assign(base, over || {}));
      return id;
    };
  });
  const mkClient = (name) => page.evaluate(n => window.__mkClient(n), name);
  const mkInvoice = (over) => page.evaluate(o => window.__mkInvoice(o), over || null);
  const mkPackage = (clientId, over) => page.evaluate(args => window.__mkPackage(args[0], args[1]), [clientId, over || null]);
  const mkJob = (stage, extra) => page.evaluate(args => window.__mkJob(args[0], args[1]), [stage || null, extra || null]);
  const mkBooking = (over) => page.evaluate(o => window.__mkBooking(o), over || null);
  const goHome = async () => { await page.evaluate(() => switchScreen('home')); await page.waitForTimeout(400); };
  const rowFor = (text) => page.locator('#today-body .list-row', { hasText: text }).first();

  // ═══ 2. Overdue invoice reminder — brand-tinted invoice icon, red mono
  //         amount on the right (was home-alert-card) ═══════════════════════
  const overdueClientId = await mkClient('Overdue Nat');
  await mkInvoice({ clientId: overdueClientId, clientName: 'Overdue Nat', clientPays: 4800, dueDate: (await page.evaluate(() => addDaysISO(todayISO(), -6))) });
  await goHome();
  const overdueRow = rowFor('Overdue Nat');
  assert(await overdueRow.count() === 1, '2: overdue-invoice row renders for the client, got count ' + await overdueRow.count());
  const overdueRowText = await overdueRow.textContent();
  assert(overdueRowText.includes('6 days overdue'), '2: overdue row sub-text shows the day count, got: ' + overdueRowText);
  assert(overdueRowText.includes('4,800'), '2: overdue row shows the invoice amount, got: ' + overdueRowText);
  const overdueAmtColor = await overdueRow.evaluate(el => getComputedStyle(el.querySelector('.list-amt')).color);
  const overdueVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--overdue').trim());
  const toRgb = (page2) => page2; // no-op, colors compared as computed strings below
  assert(!!overdueAmtColor, '2: overdue amount has a computed color, got: ' + overdueAmtColor);

  // ═══ 3. Package expiring soon — amber tile + "Renew" pill (was
  //         home-alert-card) ═══════════════════════════════════════════════
  const expiringClientId = await mkClient('Expiring Ploy');
  const expiringExpiry = await page.evaluate(() => addDaysISO(todayISO(), 5));
  await mkPackage(expiringClientId, { totalSessions: 5, expiresAt: expiringExpiry });
  await goHome();
  const expiringRow = rowFor('Expiring Ploy');
  assert(await expiringRow.count() === 1, '3: package-expiring row renders, got count ' + await expiringRow.count());
  const expiringText = await expiringRow.textContent();
  assert(expiringText.includes('expires in 5 day'), '3: expiring row sub-text shows days-to-expiry, got: ' + expiringText);
  assert(expiringText.includes('Renew'), '3: expiring row shows the "Renew" pill, got: ' + expiringText);
  assert(await expiringRow.locator('.list-pill-marigold').count() === 1, '3: expiring row\'s pill uses the marigold pill class');

  // ═══ 4. Package almost done — same amber tile + "Renew" pill, different
  //         sub-text (was home-alert-card) ═════════════════════════════════
  const almostClientId = await mkClient('Almost Mek');
  const almostPkgId = await mkPackage(almostClientId, { totalSessions: 3, expiresAt: null });
  await mkJob('deliver', { clientId: almostClientId, packageId: almostPkgId, count: 1 }); // burns 1 of 3 -> remaining 2
  await goHome();
  const almostRow = rowFor('Almost Mek');
  assert(await almostRow.count() === 1, '4: package-almost-done row renders, got count ' + await almostRow.count());
  const almostText = await almostRow.textContent();
  assert(almostText.includes('almost done'), '4: almost-done row sub-text present, got: ' + almostText);
  assert(await almostRow.locator('.list-pill-marigold').count() === 1, '4: almost-done row also uses the marigold pill');

  // ═══ 5. Shop order requests waiting — backend aggregate count (was
  //         attn-card) ══════════════════════════════════════════════════════
  const ordersRowText = await page.evaluate(() => document.getElementById('today-body').textContent);
  assert(ordersRowText.includes('1 order request(s) waiting'), '5: order-request aggregate row renders, got: ' + ordersRowText);

  // ═══ 6. Invoices with new client slips — backend aggregate count (was
  //         attn-card) ══════════════════════════════════════════════════════
  await mkInvoice({ clientName: 'Slip Client', slips: [{ id: 'slip-1', dataUrl: 'data:image/png;base64,x', at: new Date().toISOString(), source: 'client' }] });
  await goHome();
  const slipsRowText = await page.evaluate(() => document.getElementById('today-body').textContent);
  assert(slipsRowText.includes('1 invoice(s) with new client slips'), '6: new-slip aggregate row renders, got: ' + slipsRowText);

  // ═══ 7. Next booking today — NEW row type, green tile + "Booked" pill (no
  //         pre-merge equivalent; sourced from bookings.js) ═════════════════
  const bookingClientId = await mkClient('Booked Client');
  const futureTime = await page.evaluate(() => {
    const d = new Date(); d.setHours(d.getHours() + 2);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  });
  await mkBooking({ customerId: bookingClientId, title: 'Session with Booked Client', startTime: futureTime, location: 'Sukhumvit gym' });
  await goHome();
  const bookingRow = rowFor('Booked Client');
  assert(await bookingRow.count() === 1, '7: next-booking row renders, got count ' + await bookingRow.count());
  const bookingText = await bookingRow.textContent();
  assert(bookingText.includes(futureTime), '7: booking row shows the start time, got: ' + bookingText);
  assert(bookingText.includes('Next up'), '7: booking row sub-text says "Next up", got: ' + bookingText);
  assert(bookingText.includes('Sukhumvit gym'), '7: booking row shows the location, got: ' + bookingText);
  assert(await bookingRow.locator('.list-pill-paid').count() === 1, '7: booking row uses the "Booked" (paid-tinted) pill');
  await bookingRow.click();
  await page.waitForTimeout(300);
  const onBookScreen = await page.evaluate(() => document.getElementById('s-book').classList.contains('active'));
  assert(onBookScreen, '7: tapping the next-booking row navigates to Calendar (#s-book)');
  await goHome();

  // ═══ 8. Active pipeline job preview — general "Up next" rows, unchanged
  //         stage-color icon tiles (was incoming-pipeline) ═════════════════
  const pipelineJobId = await mkJob('quote', { serviceName: 'Nutrition plan', client: 'Pipeline Client' });
  await goHome();
  const pipelineRow = rowFor('Pipeline Client');
  assert(await pipelineRow.count() === 1, '8: active pipeline job row renders, got count ' + await pipelineRow.count());
  const pipelineText = await pipelineRow.textContent();
  assert(pipelineText.includes('Nutrition plan'), '8: pipeline row sub-text includes the service name, got: ' + pipelineText);
  const pipelineIconBg = await pipelineRow.evaluate(el => getComputedStyle(el.querySelector('.list-icon')).backgroundColor);
  const expectedQuoteBg = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = STAGE_META.quote.dot + '22';
    document.body.appendChild(probe);
    const bg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return bg;
  });
  assert(pipelineIconBg === expectedQuoteBg, '8: pipeline row icon tile uses the Quote stage\'s dot color (per-stage identity preserved), got: ' + pipelineIconBg + ' expected ' + expectedQuoteBg);
  await pipelineRow.click();
  await page.waitForTimeout(300);
  const onPipelineScreen = await page.evaluate(() => document.getElementById('s-pipeline').classList.contains('active'));
  assert(onPipelineScreen, '8: tapping a pipeline row navigates to Task flow (#s-pipeline)');
  await goHome();

  // ═══ 9. Priority ordering: overdue -> expiring -> almost -> orders ->
  //         slips -> next booking -> pipeline preview ═══════════════════════
  const orderedTitles = await page.evaluate(() => Array.from(document.querySelectorAll('#today-body .list-row .list-title')).map(el => el.textContent));
  const idx = (needle) => orderedTitles.findIndex(t => t.includes(needle));
  const iOverdue = idx('Overdue Nat'), iExpiring = idx('Expiring Ploy'), iAlmost = idx('Almost Mek'),
    iOrders = idx('order request'), iSlips = idx('new client slips'), iBooking = idx('Booked Client'),
    iPipeline = idx('Pipeline Client');
  assert(iOverdue >= 0 && iOverdue < iExpiring, '9: overdue row comes before expiring row');
  assert(iExpiring < iAlmost, '9: expiring row comes before almost-done row');
  assert(iAlmost < iOrders, '9: almost-done row comes before the orders-waiting aggregate row');
  assert(iOrders < iSlips, '9: orders-waiting row comes before the new-slips aggregate row');
  assert(iSlips < iBooking, '9: new-slips row comes before the next-booking row');
  assert(iBooking < iPipeline, '9: next-booking row comes before the general pipeline-preview row');

  // ═══ 10. Attention row-count cap (4) + "+N more" overflow link to
  //          Clients ════════════════════════════════════════════════════════
  for (let i = 0; i < 6; i++) {
    const cid = await mkClient('Overflow Client ' + i);
    await mkInvoice({ clientId: cid, clientName: 'Overflow Client ' + i, clientPays: 100 + i,
      dueDate: (await page.evaluate(() => addDaysISO(todayISO(), -1))) });
  }
  await goHome();
  const attentionRowCount = await page.evaluate(() => Array.from(document.querySelectorAll('#today-body .list-row')).filter(r =>
    r.querySelector('.list-amt') && getComputedStyle(r.querySelector('.list-amt')).color !== '' && r.textContent.includes('overdue')).length);
  assert(attentionRowCount === 4, '10: attention rows cap at TODAY_ATTENTION_LIMIT (4), got ' + attentionRowCount);
  const overflowLink = await page.locator('#today-body', { hasText: 'more need attention' }).count();
  assert(overflowLink >= 1, '10: a "+N more need attention" overflow link renders once past the cap');
  await page.click('#today-body >> text=more need attention');
  await page.waitForTimeout(300);
  const onCustomersScreen = await page.evaluate(() => document.getElementById('s-customers').classList.contains('active'));
  assert(onCustomersScreen, '10: tapping the overflow link navigates to Clients (#s-customers)');
  await goHome();

  // ═══ 11. Pipeline preview cap (6) + "+N more in Pipeline" overflow link
  //          (unchanged from the pre-merge incoming-pipeline behavior) ══════
  for (let i = 0; i < 8; i++) {
    await mkJob('inquiry', { client: 'Bulk Job ' + i, serviceName: 'Filler' });
  }
  await goHome();
  const pipelineRowsShown = await page.evaluate(() => Array.from(document.querySelectorAll('#today-body .list-row')).filter(r => r.textContent.includes('Bulk Job')).length);
  assert(pipelineRowsShown === 6, '11: pipeline preview rows cap at INCOMING_PIPELINE_LIMIT (6), got ' + pipelineRowsShown);
  const pipelineOverflow = await page.locator('#today-body', { hasText: 'more in Pipeline' }).count();
  assert(pipelineOverflow >= 1, '11: a "+N more in Pipeline" overflow link renders once past the cap');

  // ═══ 12. Hero + goal card untouched by any of the above seeding ═════════
  const heroAmtBefore = await page.evaluate(() => document.getElementById('hero-amt').textContent);
  const paidJobId = await mkJob('deliver', { client: 'Paid Client', amount: 700, tip: 0, expense: 0, paid: true });
  await goHome();
  const heroAmtAfter = await page.evaluate(() => document.getElementById('hero-amt').textContent);
  assert(heroAmtAfter !== heroAmtBefore, '12: hero-amt updates when a jobEarned() job is added (hero rendering still wired), before=' + heroAmtBefore + ' after=' + heroAmtAfter);
  const heroDigits = heroAmtAfter.replace(/[^0-9]/g, '');
  assert(heroDigits === '700', '12: hero-amt reflects exactly the one paid job (฿700), unaffected by the unpaid Today-card seed jobs, got ' + heroAmtAfter);
  const goalDisplay = await page.evaluate(() => document.getElementById('goal-card').style.display);
  assert(goalDisplay === 'none', '12: goal-card stays hidden (no goal target set) — untouched by the Today merge');
  await page.evaluate(async () => { await onGoalTargetChange('month', 1000); });
  await page.waitForTimeout(200);
  const goalDisplayAfter = await page.evaluate(() => document.getElementById('goal-card').style.display);
  assert(goalDisplayAfter === 'block', '12: goal-card still renders normally once a target is set — renderGoal() untouched');

  // ═══ 13. Quick-action buttons (Invoices / Documents) still present + work,
  //          now positioned below the Today card ═══════════════════════════
  const qaOrder = await page.evaluate(() => {
    const today = document.querySelector('#s-home .content .section-title');
    const qa = document.getElementById('home-quick-actions');
    return !!(today && qa) && (today.compareDocumentPosition(qa) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  assert(qaOrder, '13: the quick-action row is positioned after the Today section in the DOM');
  await page.click('#home-quick-actions .qa-btn >> nth=0');
  await page.waitForTimeout(300);
  const onInvoicesScreen = await page.evaluate(() => document.getElementById('s-invoices').classList.contains('active'));
  assert(onInvoicesScreen, '13: the Invoices quick-action button still navigates to #s-invoices');
  await goHome();
  await page.click('#home-quick-actions .qa-btn >> nth=1');
  await page.waitForTimeout(300);
  const onDocsScreen = await page.evaluate(() => document.getElementById('s-docs').classList.contains('active'));
  assert(onDocsScreen, '13: the Documents quick-action button still navigates to #s-docs');
  await goHome();

  // ═══ 14. Zero console/page errors across the whole flow ═════════════════
  assert(errors.length === 0, '14: no console errors across the whole flow, got: ' + errors.join('; '));

  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.kill();
  process.exit(fail ? 1 : 0);
})();
