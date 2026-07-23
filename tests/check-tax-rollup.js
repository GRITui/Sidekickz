/* Acceptance suite for "M4 Pass P4 — Thai annual tax roll-up (ภ.ง.ด.90/94)",
 * a report-only filing-prep summary added as a second block inside the
 * existing #docs-tax-details area (tax.js's renderTax() calculator lives in
 * the first block, #tax-body; this roll-up fills the second, #tax-rollup-body,
 * via the new renderTaxRollup()). Harness pattern copied from
 * tests/check-catalog.js: register a fresh account, seed data straight into
 * IndexedDB via in-page factories, drive the REAL UI, assert on rendered DOM.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-tax-rollup.js
 * Expects http://localhost:9033 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:9033';
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // ── Register a fresh account ─────────────────────────────────────────
  await page.goto(BASE + '/login.html');
  await page.click('#tab-register');
  await page.fill('#auth-user', 'taxroll' + Date.now());
  await page.fill('#auth-name', 'Tax Rollup Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // EN so string assertions can compare against the EN dict.
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);

  // In-page factories — window props die on page.reload() (never used here).
  await page.evaluate(() => {
    window.__mkInvoice = async function (over) {
      const uid = currentUser.id;
      const base = {
        uid, number: 'INV-' + Math.random().toString(36).slice(2, 8), issueDate: todayISO(), dueDate: '',
        clientId: null, clientName: 'Rollup Client', clientTaxId: '', clientAddress: '',
        lineItems: [{ description: 'Work', qty: 1, unitPrice: 1000 }], subtotal: 1000,
        whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 1000, youReceive: 1000, depositPct: 0,
        status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(),
      };
      const id = await dbAdd('invoices', Object.assign(base, over || {}));
      return id;
    };
    window.__mkJob = async function (stage, extra) {
      const uid = currentUser.id;
      const j = Object.assign({
        uid, date: todayISO(), client: 'Rollup Client', clientId: null, serviceId: null,
        serviceName: 'Job', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, invoiceId: null, quoteDocId: null,
        packageId: null, updatedAt: nowISO(),
      }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  const mkInvoice = (over) => page.evaluate(o => window.__mkInvoice(o), over || null);
  const mkJob = (stage, extra) => page.evaluate(args => window.__mkJob(args[0], args[1]), [stage || null, extra || null]);

  const openRollup = async () => {
    await page.evaluate(() => switchScreen('docs'));
    await page.waitForTimeout(150);
    await page.evaluate(() => { const d = document.getElementById('docs-tax-details'); if (d) d.open = true; });
    await page.evaluate(() => renderTaxRollup());
    await page.waitForTimeout(200);
  };
  // Uses a JS-dispatched change event (not Playwright's UI-driven
  // selectOption) — the select lives inside a native <details> block, and
  // its actionability checks are unreliable there even when the element is
  // genuinely visible and open. Dispatching the same 'change' event the
  // browser would fire is equivalent for exercising the app's onchange
  // handler.
  const selectAndWait = async (selector, value) => {
    await page.evaluate(([sel, val]) => {
      const el = document.querySelector(sel);
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, [selector, value]);
    await page.waitForTimeout(200);
  };
  const clickAndWait = async (selector) => {
    await page.evaluate(sel => document.querySelector(sel)?.click(), selector);
    await page.waitForTimeout(200);
  };
  const readNum = (id) => page.evaluate(elId => {
    const el = document.getElementById(elId);
    if (!el) return null;
    return parseFloat(String(el.textContent).replace(/[^0-9.\-]/g, ''));
  }, id);
  const readText = (id) => page.evaluate(elId => {
    const el = document.getElementById(elId);
    return el ? el.textContent.trim() : null;
  }, id);
  const readBand = (rate) => page.evaluate(r => {
    const row = document.querySelector(`.txr-band-row[data-rate="${r}"]`);
    if (!row) return null;
    return {
      tax: parseFloat(row.getAttribute('data-tax')),
      from: parseFloat(row.getAttribute('data-from')),
      to: parseFloat(row.getAttribute('data-to')),
    };
  }, rate);

  // ═══ 1. Container lives inside #docs-tax-details, as a sibling of #tax-body ═
  await openRollup();
  const placement = await page.evaluate(() => {
    const det = document.getElementById('docs-tax-details');
    const rollup = document.getElementById('tax-rollup-body');
    const taxBody = document.getElementById('tax-body');
    return { insideDetails: !!(det && rollup && det.contains(rollup)), hasContent: !!(rollup && rollup.innerHTML.length > 0), siblingOfTaxBody: !!(taxBody && rollup && taxBody.parentElement === rollup.parentElement) };
  });
  assert(placement.insideDetails, '1: #tax-rollup-body lives inside #docs-tax-details');
  assert(placement.hasContent, '1: #tax-rollup-body actually rendered content');
  assert(placement.siblingOfTaxBody, '1: #tax-rollup-body is a sibling of #tax-body (same details area)');

  // ═══ 2. Fresh account, no data yet: assessable income for "this year" is 0 ═
  const emptyIncome = await readNum('txr-income-total');
  assert(emptyIncome === 0, '2: assessable income is 0 with no data, got ' + emptyIncome);

  // ═══ 3. Disclaimer always present (EN) ═════════════════════════════════
  const disclaimerEn = await readText('txr-disclaimer');
  assert(disclaimerEn === 'Estimate only — not tax advice. Rates and deductions verified Jul 2026; confirm current rules and your own allowances with the Revenue Department (rd.go.th).',
    '3: EN disclaimer text matches exactly, got "' + disclaimerEn + '"');

  // ═══ 4/5/6. Golden bracket math A: net 150,000 -> tax ฿0 (payable, not refund) ═
  await mkInvoice({ issueDate: '2021-06-15', status: 'paid', youReceive: 300000, wht: 0 });
  await openRollup();
  await selectAndWait('#txr-year', '2021');
  await selectAndWait('#txr-category', '40_6'); // 30% std deduction, no cap
  const aNet = await readNum('txr-net-income');
  const aTax = await readNum('txr-tax-total');
  const aLabel = await readText('txr-net-result-label');
  assert(aNet === 150000, '4: net income = 300000*0.7 - 60000 = 150000, got ' + aNet);
  assert(aTax === 0, '5: tax on exactly 150000 net income is 0, got ' + aTax);
  assert(aLabel === 'Estimated payable', '6: 0 payable renders "Estimated payable" (not refund), got "' + aLabel + '"');

  // ═══ 7/8/9. Golden bracket math B: net 300,000 -> tax ฿7,500; 40(2) cap binds at ฿100,000 ═
  await mkInvoice({ issueDate: '2022-06-15', status: 'paid', youReceive: 460000, wht: 0 });
  await openRollup(); // re-fetches invoices so the 2022 option exists in #txr-year
  await selectAndWait('#txr-year', '2022');
  await selectAndWait('#txr-category', '40_2'); // 50% capped at 100,000 — 50% of 460k would be 230k, so the cap binds
  const bDeduction = await readNum('txr-deduction');
  const bNet = await readNum('txr-net-income');
  const bTax = await readNum('txr-tax-total');
  assert(bDeduction === 100000, '7: 40(2) standard deduction caps at exactly 100000 on 460000 income, got ' + bDeduction);
  assert(bNet === 300000, '8: net income = 460000 - 100000 - 60000 = 300000, got ' + bNet);
  assert(bTax === 7500, '9: tax on 300000 net income = 0*150000 + 0.05*150000 = 7500, got ' + bTax);

  // ═══ 10/11. Golden bracket math C: crosses 5 non-zero brackets, net 1,500,000 -> tax ฿240,000 ═
  await mkInvoice({ issueDate: '2023-06-15', status: 'paid', youReceive: 3900000, wht: 0 });
  await openRollup();
  await selectAndWait('#txr-year', '2023');
  await selectAndWait('#txr-category', '40_7_8'); // 60% std deduction, no cap
  const cNet = await readNum('txr-net-income');
  const cTax = await readNum('txr-tax-total');
  assert(cNet === 1500000, '10a: net income = 3900000*0.4 - 60000 = 1500000, got ' + cNet);
  assert(cTax === 240000, '10b: total tax across brackets (0+7500+20000+37500+50000+125000) = 240000, got ' + cTax);
  const band25 = await readBand('0.25');
  assert(!!band25 && band25.tax === 125000 && (band25.to - band25.from) === 500000,
    '11: the 25% bracket row shows taxable=500000, tax=125000, got ' + JSON.stringify(band25));

  // ═══ 12/13. Actual-expense toggle changes the deduction ════════════════
  await mkJob('booked', { paid: true, date: '2024-06-01', amount: 500000, expense: 45000, netAmount: 500000, invoiceId: null });
  await openRollup();
  await selectAndWait('#txr-year', '2024');
  await selectAndWait('#txr-category', '40_2');
  await clickAndWait('#txr-deduct-std');
  const dStd = await readNum('txr-deduction');
  await clickAndWait('#txr-deduct-actual');
  const dActual = await readNum('txr-deduction');
  assert(dStd === 100000, '12: standard 40(2) deduction on 500000 cash income caps at 100000, got ' + dStd);
  assert(dActual === 45000, '13: actual-expense mode sums the job\'s expense field for the year (45000), got ' + dActual);
  const dCashIncome = await readNum('txr-income-cash');
  assert(dCashIncome === 500000, '13b: cash-engagement income (paid job, no invoiceId) counted, got ' + dCashIncome);
  await clickAndWait('#txr-deduct-std'); // reset for later tests

  // ═══ 14/15. WHT netting produces a refund when credits exceed the tax owed ═
  await mkInvoice({ issueDate: '2025-06-15', status: 'paid', youReceive: 100000, whtPct: 5, wht: 5000 });
  await openRollup();
  await selectAndWait('#txr-year', '2025');
  await selectAndWait('#txr-category', '40_6'); // 30000 deduction -> net 10000, well inside the 0% band
  const eLabel = await readText('txr-net-result-label');
  const eAmt = await readNum('txr-net-result');
  assert(eLabel === 'Estimated refund', '14: tax(0) - credit(5000) < 0 renders "Estimated refund", got "' + eLabel + '"');
  assert(eAmt === 5000, '15: refund amount = 5000, got ' + eAmt);
  const eTawiHint = await readText('txr-tawi-hint');
  assert(eTawiHint === '0 of 1 50-Tawi certificates received', '15b: tawi hint counts received vs total (0 of 1, not yet marked received), got "' + eTawiHint + '"');

  // ═══ 16/17. Year selector isolates years — switching recomputes totals, doesn't accumulate ═
  await selectAndWait('#txr-year', '2021');
  const y2021Income = await readNum('txr-income-total');
  await selectAndWait('#txr-year', '2022');
  const y2022Income = await readNum('txr-income-total');
  assert(y2021Income === 300000, '16: year 2021 shows only its own invoice (300000), got ' + y2021Income);
  assert(y2022Income === 460000, '17: switching to 2022 shows only its own invoice (460000), not accumulated, got ' + y2022Income);

  // ═══ 18. Buddhist-Era year label in TH mode ════════════════════════════
  await page.evaluate(async () => { await onLangChange('th'); });
  await page.waitForTimeout(300);
  await selectAndWait('#txr-year', '2022');
  const beLabel = await page.evaluate(() => {
    const sel = document.getElementById('txr-year');
    return sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : null;
  });
  assert(beLabel === '2565', '18: TH mode shows Buddhist-Era year (2022+543=2565) in the selector, got "' + beLabel + '"');

  // ═══ 19. Disclaimer present in TH too ══════════════════════════════════
  const disclaimerTh = await readText('txr-disclaimer');
  assert(disclaimerTh === 'เป็นการประมาณการเท่านั้น ไม่ใช่คำแนะนำทางภาษี — อัตราและค่าลดหย่อนตรวจสอบเมื่อ ก.ค. 2569 โปรดยืนยันกฎปัจจุบันและค่าลดหย่อนของคุณกับกรมสรรพากร (rd.go.th)',
    '19: TH disclaimer text matches exactly, got "' + disclaimerTh + '"');
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);

  // ═══ 20/21. Filing-window countdown chip appears within 60 days of a deadline, not outside it ═
  await page.evaluate(() => { window.__taxrToday = '2026-09-01'; });
  await selectAndWait('#txr-year', '2026');
  const chipNear = await readText('txr-chip-94');
  assert(chipNear === '29 days left', '20: within 60 days of ภ.ง.ด.94\'s 30 Sep deadline (Sep 1 -> 29 days) shows the countdown chip, got "' + chipNear + '"');
  await page.evaluate(() => { window.__taxrToday = '2026-01-01'; });
  await page.evaluate(() => renderTaxRollup());
  await page.waitForTimeout(200);
  const chipFarExists = await page.evaluate(() => !!document.getElementById('txr-chip-94'));
  assert(!chipFarExists, '21: outside the 60-day window (Jan 1, 242 days out) the countdown chip does not render');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
