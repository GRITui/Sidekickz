/* Acceptance suite for TSK-002/007 (More/Settings rebuild): the old 12
 * <details> sections collapsed into an account card + Tools grid +
 * "Set up your business" drill-in rows (4 sub-pages) + Preferences + About.
 * Harness pattern copied from tests/check-payments.js / check-team.js.
 *
 * Covers:
 *   1. Every relocated action from the research assessment's inventory is
 *      still reachable from the new structure.
 *   2. The 4 drill-in sub-pages open from their root row and their back
 *      button returns to root.
 *   3. Status pills (Payments & shop / LINE & team / Data & backup) reflect
 *      REAL state, and update live when that state changes.
 *   4. The Follow-ups Tools-grid tile badge matches the real due count.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-more-settings-v2.js
 * Expects http://localhost:8923 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8923';
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('dialog', d => d.accept());

  // ── Register a fresh account, EN so string assertions compare cleanly ──
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'moresettings' + Date.now());
  await page.fill('#auth-name', 'More Settings Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');   // trainer
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);

  const active = (id) => page.evaluate(sel => document.getElementById(sel)?.classList.contains('active'), id);
  const goMore = async () => { await page.evaluate(() => switchScreen('more')); await page.waitForTimeout(200); };

  // ═══ 1. Root screen: account card, Tools grid, "Set up your business",
  //        Preferences, About all present with the right ids ═══════════════
  await goMore();
  assert(await active('s-more'), '1: More root screen is active after switchScreen(\'more\')');
  const rootIds = ['acct-avatar', 'acct-name', 'acct-sub', 'tool-tile-insights', 'pill-payments',
    'pill-line-team', 'pill-data-backup', 'set-lang', 'set-currency', 'set-goal-month', 'seg-theme-light',
    'seg-theme-dark', 'seg-theme-auto', 'set-count', 'app-version'];
  for (const id of rootIds) {
    assert(await page.locator('#' + id).count() === 1, `1: #${id} present on the More root screen`);
  }
  const insightsHiddenByDefault = await page.evaluate(() => document.getElementById('tool-tile-insights').hidden);
  assert(insightsHiddenByDefault === true, '1: Insights tile stays hidden until unlocked (gating preserved, not silently dropped)');

  // ═══ 2. Tools grid: Follow-ups/Portfolio/Research tiles navigate ═══════
  await page.click('.tool-tile:has-text("Follow-ups")');
  await page.waitForTimeout(150);
  assert(await active('s-followups'), '2: Follow-ups tile opens #s-followups');
  await goMore();
  await page.click('.tool-tile:has-text("Portfolio")');
  await page.waitForTimeout(150);
  assert(await active('s-portfolio'), '2: Portfolio tile opens #s-portfolio');
  await goMore();
  await page.click('.tool-tile:has-text("Research")');
  await page.waitForTimeout(150);
  assert(await active('s-research'), '2: Research tile opens #s-research');
  await goMore();

  // ═══ 3. Insights: tap-version-7x unlock still works, tile then reachable ═
  for (let i = 0; i < 7; i++) { await page.click('#app-version'); }
  await page.waitForTimeout(200);
  const insightsVisibleAfterUnlock = await page.evaluate(() => !document.getElementById('tool-tile-insights').hidden);
  assert(insightsVisibleAfterUnlock, '3: tapping the version 7x unlocks the Insights tile');
  await page.click('#tool-tile-insights');
  await page.waitForTimeout(150);
  assert(await active('s-insights'), '3: Insights tile opens #s-insights once unlocked');
  await goMore();

  // ═══ 4. "Business & documents" drill-in: opens, back button returns,
  //        every relocated field/row is present ═══════════════════════════
  await page.click('.biz-row:has-text("Business & documents")');
  await page.waitForTimeout(150);
  assert(await active('s-more-biz'), '4: Business & documents row opens #s-more-biz');
  const bizIds = ['set-business-type', 'set-package-unit', 'set-seller-name', 'set-seller-taxid',
    'set-seller-address', 'seller-logo-body', 'set-wht', 'set-vat', 'set-page-size', 'workflow-body'];
  for (const id of bizIds) {
    assert(await page.locator('#' + id).count() === 1, `4: #${id} present on Business & documents`);
  }
  const wfRows = await page.locator('#workflow-body .wf-row').count();
  assert(wfRows > 0, '4: Stage order (reorder-only workflow controls) rendered inside Business & documents, got ' + wfRows);
  await page.click('#s-more-biz .list-card .biz-row');   // "Manage services & products" row
  await page.waitForTimeout(150);
  assert(await active('s-services'), '4: "Manage services & products" row opens #s-services');
  await page.evaluate(() => switchScreen('more-biz'));
  await page.waitForTimeout(150);
  await page.click('#s-more-biz button.avatar');
  await page.waitForTimeout(150);
  assert(await active('s-more'), '4: back button on Business & documents returns to #s-more');

  // ═══ 5. "Payments & shop" drill-in ═════════════════════════════════════
  await page.click('.biz-row:has-text("Payments & shop")');
  await page.waitForTimeout(150);
  assert(await active('s-more-pay'), '5: Payments & shop row opens #s-more-pay');
  for (const id of ['payment-channels-list', 'shop-link-body', 'shop-orders-body', 'slip-verify-body']) {
    assert(await page.locator('#' + id).count() === 1, `5: #${id} present on Payments & shop`);
  }
  assert(await page.locator('button:has-text("Add payment channel")').count() === 1, '5: "+ Add payment channel" button present');
  await page.click('#s-more-pay button.avatar');
  await page.waitForTimeout(150);
  assert(await active('s-more'), '5: back button on Payments & shop returns to #s-more');

  // ═══ 6. "LINE & team" drill-in ═════════════════════════════════════════
  await page.click('.biz-row:has-text("LINE & team")');
  await page.waitForTimeout(150);
  assert(await active('s-more-line'), '6: LINE & team row opens #s-more-line');
  for (const id of ['line-channel-body', 'booking-slots-body', 'team-body']) {
    assert(await page.locator('#' + id).count() === 1, `6: #${id} present on LINE & team`);
  }
  await page.click('#s-more-line button.avatar');
  await page.waitForTimeout(150);
  assert(await active('s-more'), '6: back button on LINE & team returns to #s-more');

  // ═══ 7. "Data & backup" drill-in ═══════════════════════════════════════
  await page.click('.biz-row:has-text("Data & backup")');
  await page.waitForTimeout(150);
  assert(await active('s-more-data'), '7: Data & backup row opens #s-more-data');
  const bannerText = await page.locator('#data-backup-banner').textContent();
  assert(bannerText && bannerText.toLowerCase().includes('backup'), '7: info banner shows a backup-status message, got "' + bannerText + '"');
  const exportBtnTexts = await page.locator('#s-more-data .export-btns button').allTextContents();
  assert(exportBtnTexts.some(t => t.includes('Export CSV')), '7: Export CSV button present, got ' + JSON.stringify(exportBtnTexts));
  assert(exportBtnTexts.some(t => t.includes('Backup JSON')), '7: Backup JSON button present');
  assert(exportBtnTexts.some(t => t.includes('clients CSV')), '7: Export clients CSV button present');
  assert(exportBtnTexts.some(t => t.includes('invoices CSV')), '7: Export invoices CSV button present');
  assert(exportBtnTexts.some(t => t.includes('P.N.D.')), '7: Export P.N.D. summary CSV button present');
  assert(await page.locator('button:has-text("Restore JSON")').count() === 1, '7: Restore JSON button present');
  assert(await page.locator('#backup-file').count() === 1, '7: hidden restore file input present');
  await page.click('#s-more-data button.avatar');
  await page.waitForTimeout(150);
  assert(await active('s-more'), '7: back button on Data & backup returns to #s-more');

  // ═══ 8. Preferences: Theme segmented control actually switches theme ═══
  await page.click('#seg-theme-dark');
  await page.waitForTimeout(150);
  const themeDark = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeDark === 'dark', '8: clicking the Dark segment applies dark theme, got ' + themeDark);
  const darkOn = await page.evaluate(() => document.getElementById('seg-theme-dark').classList.contains('on'));
  const lightOn = await page.evaluate(() => document.getElementById('seg-theme-light').classList.contains('on'));
  assert(darkOn === true && lightOn === false, '8: only the Dark segment carries .on after switching');
  await page.click('#seg-theme-light');
  await page.waitForTimeout(150);

  // ═══ 9. Payments & shop status pill reflects REAL state ════════════════
  const pillTextBefore = await page.locator('#pill-payments').textContent();
  assert(pillTextBefore.trim() === 'Set up', '9: Payments pill starts "Set up" (amber) with no channel configured, got "' + pillTextBefore + '"');
  const pillClassBefore = await page.evaluate(() => document.getElementById('pill-payments').className);
  assert(pillClassBefore.includes('amber'), '9: Payments pill has the amber class before any channel exists, got ' + pillClassBefore);

  await page.evaluate(() => openAddPaymentChannel());
  await page.waitForSelector('#modal-paychannel.open', { timeout: 5000 });
  await page.fill('#pc-label', 'Test PromptPay');
  await page.fill('#pc-detail', '099-999-9999');
  await page.click('#modal-paychannel button.btn-submit');
  await page.waitForTimeout(300);
  await goMore();
  const pillTextAfterAdd = await page.locator('#pill-payments').textContent();
  const pillClassAfterAdd = await page.evaluate(() => document.getElementById('pill-payments').className);
  assert(pillTextAfterAdd.trim() === 'Connected', '9: Payments pill flips to "Connected" once a channel exists, got "' + pillTextAfterAdd + '"');
  assert(pillClassAfterAdd.includes('green'), '9: Payments pill carries the green class once connected, got ' + pillClassAfterAdd);

  // Remove the channel and confirm the pill reverts.
  await page.evaluate(async () => {
    const chans = paymentChannels();
    if (chans[0]) await saveSetting('paymentChannels', []);
  });
  await goMore();
  const pillTextAfterRemove = await page.locator('#pill-payments').textContent();
  assert(pillTextAfterRemove.trim() === 'Set up', '9: Payments pill reverts to "Set up" once the channel is removed, got "' + pillTextAfterRemove + '"');

  // ═══ 10. LINE & team status pill reflects REAL (faked-backend) state ═══
  let lineConnected = null;
  await page.exposeFunction('__fakeLineStatus', () => lineConnected
    ? { connected: true, channelId: lineConnected, botUserId: 'U_bot_1', webhookUrl: 'https://x/line-webhook', bookingPageUrl: 'https://x/book.html' }
    : { connected: false, webhookUrl: 'https://x/line-webhook', bookingPageUrl: 'https://x/book.html' });
  // Monkey-patch only the calls this pill test needs, keeping the rest of
  // the real SidekickBackend (dataClient.js) intact — 'more' still fires
  // renderShopSection()/renderShopOrdersSection()/renderSlipVerifySection()
  // in the same render pass, and those need their real implementations.
  await page.evaluate(() => {
    window.SidekickBackend.isEnabled = () => true;
    window.SidekickBackend.session = async () => ({ ok: true, data: { user: {
      plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null, hasStripeCustomer: true, clientCap: null,
      features: { cloudSync: true, lineBooking: true, recurringBookings: true, researchPremium: true, docBranding: true },
    } } });
    window.SidekickBackend.lineChannelStatus = async () => ({ ok: true, data: await window.__fakeLineStatus() });
    window.SidekickBackend.bookingSlotsList = async () => ({ ok: true, data: { rows: [] } });
    window.SidekickBackend.bookingRequestsList = async () => ({ ok: true, data: { rows: [] } });
  });
  await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());
  await goMore();
  const linePillBefore = await page.locator('#pill-line-team').textContent();
  assert(linePillBefore.trim() === 'Set up', '10: LINE & team pill starts "Set up" when not connected, got "' + linePillBefore + '"');
  lineConnected = 'ch-123';
  await page.evaluate(() => window.renderLineChannelSection && window.renderLineChannelSection());
  await page.waitForTimeout(200);
  const linePillAfter = await page.locator('#pill-line-team').textContent();
  const linePillClassAfter = await page.evaluate(() => document.getElementById('pill-line-team').className);
  assert(linePillAfter.trim() === 'Connected', '10: LINE & team pill flips to "Connected" once the channel connects, got "' + linePillAfter + '"');
  assert(linePillClassAfter.includes('green'), '10: LINE & team pill carries the green class once connected');

  // ═══ 11. Data & backup pill/banner reflect REAL settings.lastBackupAt ══
  const dataPillNever = await page.locator('#pill-data-backup').textContent();
  assert(dataPillNever.trim().length > 0, '11: Data & backup pill shows something before any backup, got "' + dataPillNever + '"');
  await page.evaluate(async () => { await saveSetting('lastBackupAt', new Date().toISOString()); });
  await goMore();
  const dataPillToday = await page.locator('#pill-data-backup').textContent();
  assert(dataPillToday.trim() === 'Today', '11: Data & backup pill reads "Today" right after a backup, got "' + dataPillToday + '"');

  // ═══ 12. Follow-ups tile badge matches the REAL due count ══════════════
  const badgeHiddenBefore = await page.evaluate(() => document.getElementById('tool-badge-followups').hidden);
  assert(badgeHiddenBefore === true, '12: Follow-ups badge starts hidden with nothing due, got hidden=' + badgeHiddenBefore);

  await page.evaluate(async () => {
    const uid = currentUser.id;
    const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    await dbAdd('invoices', {
      uid, number: 'INV-OVERDUE-1', issueDate: past, dueDate: past,
      clientId: null, clientName: 'Overdue Client', clientTaxId: '', clientAddress: '',
      lineItems: [{ description: 'Work', qty: 1, unitPrice: 1000 }], subtotal: 1000,
      whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 1000, youReceive: 1000, depositPct: 0,
      status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(),
    });
    await reload();
  });
  await goMore();
  await page.waitForTimeout(200);
  const dueCount = await page.evaluate(() => window.followupsDueCount());
  const badgeHiddenAfter = await page.evaluate(() => document.getElementById('tool-badge-followups').hidden);
  const badgeText = await page.locator('#tool-badge-followups').textContent();
  const subText = await page.locator('#tool-sub-followups').textContent();
  assert(dueCount >= 1, '12: followupsDueCount() reflects the new overdue invoice, got ' + dueCount);
  assert(badgeHiddenAfter === false, '12: Follow-ups badge becomes visible once something is due');
  assert(Number(badgeText) === dueCount, '12: badge number matches followupsDueCount(), got badge=' + badgeText + ' count=' + dueCount);
  assert(subText.includes(String(dueCount)) && subText.toLowerCase().includes('due'), '12: sub-line reads "N due today", got "' + subText + '"');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
