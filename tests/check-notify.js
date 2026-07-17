/* Acceptance suite for "M4 Pass P2 — slip auto-verify seam + needs-attention
 * notifications": Settings ▸ Shop ▸ Slip verification (provider/key/branch),
 * the per-slip "Verify" button + result chips on the invoice detail modal
 * (app/invoices.js), and Home's "Needs attention" card (pending shop orders
 * + invoices carrying an unseen client slip, app/app.js). Harness pattern
 * copied from tests/check-shop.js Part 2 (in-app Settings + a full
 * SidekickBackend stub) / tests/check-catalog.js (in-page dbAdd factories).
 *
 * Starts its own static server (no other suite claims port 9013).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-notify.js
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 9013;
const BASE = 'http://localhost:' + PORT;
const EXE = '/opt/pw-browsers/chromium';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
  await page.fill('#auth-user', 'notify' + Date.now());
  await page.fill('#auth-name', 'Notify Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.evaluate(async () => { await onLangChange('en'); });
  await page.waitForTimeout(200);

  // ── Deterministic backend stub — same base shape as tests/check-shop.js's
  //    Part 2 stub (proven zero-console-error against the full 'more' screen
  //    render), plus orderRequestsList returning a fixed 2 pending rows and
  //    a reconfigurable slipVerify(). ──────────────────────────────────────
  await page.evaluate(() => {
    const noop = async () => ({ ok: true, data: {} });
    window.__slipVerifyCalls = [];
    window.__slipVerifyResult = { status: 'verified', amount: 1070, ref: 'TRX-1' };
    window.SidekickBackend = {
      isEnabled: () => true,
      session: async () => ({ ok: true, data: { user: {
        cuid: 'owner-cuid-notify-test', plan: 'pro', subscriptionStatus: 'active', locked: false, trialDaysLeft: null,
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
        { id: 101, clientName: 'Order A', contact: 'line:a', items: [{ service_cuid: 'x', name: 'Item', qty: 1, unit_price: 100 }], total: 100, createdAt: new Date().toISOString() },
        { id: 102, clientName: 'Order B', contact: 'line:b', items: [{ service_cuid: 'y', name: 'Item2', qty: 1, unit_price: 200 }], total: 200, createdAt: new Date().toISOString() },
      ] } }),
      orderRequestResolve: noop,
      slipVerify: async (invoiceCuid, slipId, creds) => {
        window.__slipVerifyCalls.push({ invoiceCuid, slipId, creds });
        return { ok: true, status: 200, data: { ok: true, verify: Object.assign({ at: new Date().toISOString() }, window.__slipVerifyResult) } };
      },
    };
  });
  // __entitlements is populated at real app boot; this test swaps
  // SidekickBackend in AFTER boot, so refresh it before the 'more' screen
  // reads it synchronously — same as tests/check-shop.js.
  await page.evaluate(() => window.refreshEntitlements && window.refreshEntitlements());

  // In-page invoice factory carrying a `slips` array (client-uploaded slips
  // are what api/invoice-public.js writes with source:'client' — simulated
  // here directly via dbAdd, same as check-catalog.js's __mkInvoice).
  await page.evaluate(() => {
    window.__mkInvoiceWithSlips = async function (over) {
      const uid = currentUser.id;
      const base = {
        uid, number: 'INV-' + Math.random().toString(36).slice(2, 8), issueDate: todayISO(), dueDate: '',
        clientId: null, clientName: 'Notify Client', clientTaxId: '', clientAddress: '',
        lineItems: [{ description: 'Work', qty: 1, unitPrice: 1070 }], subtotal: 1070,
        whtPct: 0, vatPct: 0, vat: 0, wht: 0, clientPays: 1070, youReceive: 1070, depositPct: 0,
        status: 'sent', paymentChannels: [], notes: '', cuid: cuid(), updatedAt: nowISO(), slips: [],
      };
      const id = await dbAdd('invoices', Object.assign(base, over || {}));
      await reload();
      return id;
    };
  });
  const mkInvoiceWithSlips = (over) => page.evaluate(o => window.__mkInvoiceWithSlips(o), over || null);
  const openInvoiceModal = async (id) => {
    await page.evaluate(() => switchScreen('invoices'));
    await page.waitForTimeout(200);
    await page.evaluate(invId => document.querySelector(`[data-inv="${invId}"]`)?.click(), id);
    await page.waitForSelector('#inv-detail-modal.open', { timeout: 5000 });
  };

  // ═══ 1. Settings ▸ Shop ▸ Slip verification: defaults to "Off" ══════════
  await page.evaluate(() => switchScreen('more'));
  await page.waitForTimeout(500);
  const providerBefore = await page.locator('#slipverify-provider').inputValue().catch(() => null);
  assert(providerBefore === '', '1: provider select defaults to "" (Off), got ' + providerBefore);
  assert(await page.locator('#slipverify-key').count() === 0, '1: no API key field rendered while provider is Off');

  // ═══ 2. A slip on an invoice, opened while provider is still unconfigured,
  //         renders no Verify button — also stamps slipsSeenAt on open, so
  //         this invoice never resurfaces in the Home attention count later ═
  const invZeroId = await mkInvoiceWithSlips({ slips: [{ id: 'slip-z1', dataUrl: PNG_DATA_URL, at: new Date().toISOString(), source: 'client' }] });
  await openInvoiceModal(invZeroId);
  assert(await page.locator('[data-slip-verify]').count() === 0, '2: no Verify button renders while no provider is configured');
  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 3. Selecting a provider reveals key/branch fields; saving persists ═
  await page.evaluate(() => switchScreen('more'));
  await page.waitForTimeout(300);
  await page.selectOption('#slipverify-provider', 'slipok');
  await page.waitForTimeout(200);
  assert(await page.locator('#slipverify-key').count() === 1, '3: API key field appears once "slipok" is selected');
  assert(await page.locator('#slipverify-branch').count() === 1, '3: Branch ID field appears once "slipok" is selected');
  await page.fill('#slipverify-key', 'test-api-key-123');
  await page.locator('#slipverify-key').blur();
  await page.fill('#slipverify-branch', 'branch-42');
  await page.locator('#slipverify-branch').blur();
  await page.waitForTimeout(200);
  const savedSettings = await page.evaluate(() => ({
    provider: settings.slipVerifyProvider, key: settings.slipVerifyKey, branch: settings.slipVerifyBranch,
  }));
  assert(savedSettings.provider === 'slipok', '3: provider persisted to settings.slipVerifyProvider, got ' + savedSettings.provider);
  assert(savedSettings.key === 'test-api-key-123', '3: API key persisted to settings.slipVerifyKey, got ' + savedSettings.key);
  assert(savedSettings.branch === 'branch-42', '3: branch persisted to settings.slipVerifyBranch, got ' + savedSettings.branch);

  // ═══ 4. Home "Needs attention": order count + new-client-slip count ═════
  // invA carries 3 client-uploaded slips, never yet opened — counts as ONE
  // invoice with new slips (distinct-invoice count, not distinct-slip count).
  const invAId = await mkInvoiceWithSlips({
    clientPays: 1070,
    slips: [
      { id: 'slip-a1', dataUrl: PNG_DATA_URL, at: new Date().toISOString(), source: 'client' },
      { id: 'slip-a2', dataUrl: PNG_DATA_URL, at: new Date().toISOString(), source: 'client' },
      { id: 'slip-a3', dataUrl: PNG_DATA_URL, at: new Date().toISOString(), source: 'client' },
    ],
  });
  await page.evaluate(() => switchScreen('home'));
  await page.waitForTimeout(500);
  const attnDisplay1 = await page.evaluate(() => document.getElementById('attn-card').style.display);
  assert(attnDisplay1 !== 'none', '4: "Needs attention" card is visible, got display=' + attnDisplay1);
  const attnText1 = await page.evaluate(() => document.getElementById('attn-body').textContent);
  assert(attnText1.includes('2 order request(s) waiting'), '4: order-request count row renders (stubbed 2), got: ' + attnText1);
  assert(attnText1.includes('1 invoice(s) with new client slips'), '4: new-client-slip count row renders (1 invoice — invA, invZero already seen), got: ' + attnText1);

  // ═══ 5. Opening invA: Verify buttons appear (now configured), and this
  //         open stamps slipsSeenAt ════════════════════════════════════════
  await openInvoiceModal(invAId);
  assert(await page.locator('[data-slip-verify]').count() === 3, '5: a Verify button renders per slip once a provider is configured, got ' + await page.locator('[data-slip-verify]').count());

  // ═══ 6. Verify slip-a1 -> stubbed 'verified' result: chip renders + persists ═
  await page.click('[data-slip-verify="slip-a1"]');
  await page.waitForTimeout(400);
  const okChip = await page.locator('[data-slip-chip="verified"]').first();
  assert(await okChip.count() === 1, '6: a verified chip (data-slip-chip="verified") renders after Verify, got count ' + await okChip.count());
  const okChipText = await okChip.textContent().catch(() => '');
  assert(okChipText.includes('✓') && okChipText.includes('1,070.00'), '6: verified chip shows the ✓ icon and the amount, got: ' + okChipText);
  const persistedVerify = await page.evaluate(async id => {
    const inv = await dbGet('invoices', id);
    const s = (inv.slips || []).find(x => x.id === 'slip-a1');
    return s && s.verify;
  }, invAId);
  assert(persistedVerify && persistedVerify.status === 'verified', '6: verify result persisted onto the slip record, got ' + JSON.stringify(persistedVerify));
  const call1 = await page.evaluate(() => window.__slipVerifyCalls[0]);
  assert(call1 && call1.slipId === 'slip-a1' && call1.creds.apiKey === 'test-api-key-123' && call1.creds.branchId === 'branch-42',
    '6: slipVerify() called with the slip id + saved provider credentials, got ' + JSON.stringify(call1));

  // ═══ 7. Verify slip-a2 -> stubbed 'mismatch' result: chip renders ═══════
  await page.evaluate(() => { window.__slipVerifyResult = { status: 'mismatch', amount: 500 }; });
  await page.click('[data-slip-verify="slip-a2"]');
  await page.waitForTimeout(400);
  const mismatchChip = page.locator('[data-slip-chip="mismatch"]').first();
  assert(await mismatchChip.count() === 1, '7: a mismatch chip renders after Verify, got count ' + await mismatchChip.count());
  const mismatchText = await mismatchChip.textContent().catch(() => '');
  assert(mismatchText.includes('✗') && mismatchText.toLowerCase().includes('mismatch'), '7: mismatch chip shows the ✗ icon + "mismatch" text, got: ' + mismatchText);

  // ═══ 8. Verify slip-a3 -> stubbed 'duplicate' result: chip renders ══════
  await page.evaluate(() => { window.__slipVerifyResult = { status: 'duplicate' }; });
  await page.click('[data-slip-verify="slip-a3"]');
  await page.waitForTimeout(400);
  const dupChip = page.locator('[data-slip-chip="duplicate"]').first();
  assert(await dupChip.count() === 1, '8: a duplicate chip renders after Verify, got count ' + await dupChip.count());
  const dupText = await dupChip.textContent().catch(() => '');
  assert(dupText.includes('⚠'), '8: duplicate chip shows the ⚠ icon, got: ' + dupText);

  await page.click('#inv-d-close');
  await page.waitForTimeout(150);

  // ═══ 9. Back on Home: opening invA stamped slipsSeenAt, so the new-slip
  //         row is gone — order row is unaffected (still the stubbed 2) ════
  await page.evaluate(() => switchScreen('home'));
  await page.waitForTimeout(500);
  const attnText2 = await page.evaluate(() => document.getElementById('attn-body').textContent);
  assert(!attnText2.includes('invoice(s) with new client slips'), '9: new-client-slip row is gone after opening invA (slipsSeenAt stamped), got: ' + attnText2);
  assert(attnText2.includes('2 order request(s) waiting'), '9: order-request row is unaffected, still shows 2, got: ' + attnText2);
  const attnDisplay2 = await page.evaluate(() => document.getElementById('attn-card').style.display);
  assert(attnDisplay2 !== 'none', '9: "Needs attention" card stays visible for the still-pending order requests');

  // ═══ 10. Zero console/page errors across the whole flow ═════════════════
  assert(errors.length === 0, '10: no console errors across the whole flow, got: ' + errors.join('; '));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  server.kill();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
