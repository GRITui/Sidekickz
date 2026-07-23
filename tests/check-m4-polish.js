/* Acceptance suite for "M4 Pass P1 — polish": three independent items —
 *   1. docgen.js per-document TH/EN language picker (rec.lang, threaded
 *      through buildDocHtml()'s dt()/dd() locals instead of the bare
 *      t()/docDate() globals).
 *   2. The standalone Tax screen (#s-tax) folded into a collapsible
 *      details block inside the Docs screen, with switchScreen('tax')
 *      kept as an alias.
 *   3. A card-checkout waitlist row in Settings — pure demand
 *      instrumentation, no payment code.
 *
 * Harness pattern copied from tests/check-catalog.js / tests/check-thai-docs.js.
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-m4-polish.js
 * Expects http://localhost:9003 serving ../app.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:9003';
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 800 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  // ── Register a fresh account ─────────────────────────────────────────
  await page.goto(BASE + '/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'm4polish' + Date.now());
  await page.fill('#auth-name', 'M4 Polish Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  const openDocForm = async (type) => {
    await page.evaluate(t => openGenerateForm(t), type);
    await page.waitForSelector('#dg-modal.open', { timeout: 5000 });
  };
  const fillQuote = async (clientName) => {
    await page.fill('#dg-client-name', clientName);
    await page.evaluate(() => { dgQuoteItems = [{ description: 'Design work', qty: 1, unitPrice: 1000 }]; });
  };
  const fillReceipt = async (clientName) => {
    await page.fill('#dg-client-name', clientName);
    await page.fill('#dg-r-amount', '1000');
  };
  const saveDocForm = async () => {
    await page.click('#dg-modal .btn-submit');
    await page.waitForTimeout(300);
  };
  const latestDocByClient = (clientName) => page.evaluate(async name => {
    const uid = isGuest ? 'guest' : currentUser.id;
    const rows = (await dbAll('documents')).filter(d => d.uid === uid && d.clientName === name);
    rows.sort((a, b) => b.id - a.id);
    return rows[0];
  }, clientName);

  // ═══ 1. TH document generated from an EN-language UI ═══════════════════
  await page.evaluate(() => onLangChange('en'));
  await page.waitForTimeout(150);
  await openDocForm('quote');
  const defaultEnState = await page.evaluate(() => ({
    val: document.getElementById('dg-lang-val').value,
    enActive: document.getElementById('dg-lang-en').classList.contains('seg-active'),
    thActive: document.getElementById('dg-lang-th').classList.contains('seg-active'),
  }));
  assert(defaultEnState.val === 'en' && defaultEnState.enActive && !defaultEnState.thActive,
    '1: new-doc language toggle defaults to the current UI language (en), got ' + JSON.stringify(defaultEnState));
  await page.click('#dg-lang-th'); // override to Thai
  const afterOverride = await page.evaluate(() => ({
    val: document.getElementById('dg-lang-val').value,
    thActive: document.getElementById('dg-lang-th').classList.contains('seg-active'),
  }));
  assert(afterOverride.val === 'th' && afterOverride.thActive, '1: clicking the Thai toggle button flips #dg-lang-val to "th"');
  await fillQuote('EN-UI Thai Doc Client');
  await saveDocForm();
  const thFromEnUi = await latestDocByClient('EN-UI Thai Doc Client');
  assert(!!thFromEnUi, '1: quote saved while the UI was in English');
  assert(thFromEnUi.lang === 'th', '1: saved record carries lang === "th" even though the UI was English, got ' + thFromEnUi.lang);
  assert(thFromEnUi.content.includes('ใบเสนอราคา'), '1: saved content renders the Thai quote title, not the English one');
  assert(thFromEnUi.content.includes('2569'), '1: saved content uses the Buddhist-Era year (2026+543=2569) despite the EN UI');
  assert(!thFromEnUi.content.includes('Valid until'), '1: no English "Valid until" label leaks into the Thai-language document');

  // ═══ 2. Lang survives edit (re-saving without touching the toggle) ═════
  await page.evaluate(id => viewDocument(id), thFromEnUi.id);
  await page.waitForSelector('#dg-view-modal.open', { timeout: 5000 });
  await page.click('#dg-view-modal button[onclick="editSavedDocument()"]');
  await page.waitForSelector('#dg-modal.open', { timeout: 5000 });
  const editReopenState = await page.evaluate(() => ({
    val: document.getElementById('dg-lang-val').value,
    thActive: document.getElementById('dg-lang-th').classList.contains('seg-active'),
  }));
  assert(editReopenState.val === 'th' && editReopenState.thActive,
    '2: re-opening the saved Thai doc for edit preselects the Thai toggle, got ' + JSON.stringify(editReopenState));
  await saveDocForm(); // no changes — just re-save
  const thAfterEdit = await latestDocByClient('EN-UI Thai Doc Client');
  assert(thAfterEdit.lang === 'th', '2: lang stays "th" after an edit/re-save that never touched the toggle, got ' + thAfterEdit.lang);

  // ═══ 3. EN document generated from a TH-language UI ═════════════════════
  await page.evaluate(() => onLangChange('th'));
  await page.waitForTimeout(150);
  await openDocForm('receipt');
  const defaultThState = await page.evaluate(() => ({
    val: document.getElementById('dg-lang-val').value,
    thActive: document.getElementById('dg-lang-th').classList.contains('seg-active'),
  }));
  assert(defaultThState.val === 'th' && defaultThState.thActive,
    '3: new-doc language toggle defaults to the current UI language (th) on a fresh form, got ' + JSON.stringify(defaultThState));
  await page.click('#dg-lang-en'); // override to English
  await fillReceipt('TH-UI English Doc Client');
  await saveDocForm();
  const enFromThUi = await latestDocByClient('TH-UI English Doc Client');
  assert(!!enFromThUi, '3: receipt saved while the UI was in Thai');
  assert(enFromThUi.lang === 'en', '3: saved record carries lang === "en" even though the UI was Thai, got ' + enFromThUi.lang);
  assert(enFromThUi.content.includes('Received from:'), '3: saved content renders the English receipt label, not the Thai one');
  assert(/\d{4}-\d{2}-\d{2}/.test(enFromThUi.content) && !enFromThUi.content.includes(String(new Date().getFullYear() + 543)),
    '3: saved content keeps the ISO/CE date, not a Buddhist-Era year, despite the TH UI');

  // ═══ 4. A record with NO lang field renders byte-identically to the
  //        current-UI-language render (old documents keep working) ═══════
  const legacyCompare = await page.evaluate(() => {
    const rec = {
      type: 'quote', title: 'Quote', issueDate: '2026-07-17', clientName: 'Legacy Client',
      fields: { validUntil: '2026-08-01', subtotal: 1000, lineItems: [{ description: 'Work', qty: 1, unitPrice: 1000 }], notes: '' },
    };
    const noLangHtml = buildDocHtml(rec);
    const explicitCurLangHtml = buildDocHtml(Object.assign({}, rec, { lang: curLang() }));
    return { noLangHtml, explicitCurLangHtml, curLang: curLang() };
  });
  assert(legacyCompare.noLangHtml === legacyCompare.explicitCurLangHtml,
    '4: a document record with no rec.lang renders byte-identically to one explicitly set to the current UI language (' + legacyCompare.curLang + ')');
  assert(legacyCompare.noLangHtml.length > 0, '4: sanity — the legacy-render comparison actually produced content');

  // ═══ 5. Tax calculator lives inside the Docs details block ═════════════
  const sTaxGone = await page.evaluate(() => document.getElementById('s-tax') === null);
  assert(sTaxGone, '5: the old standalone #s-tax section no longer exists in the DOM');
  const taxDetailsInDocs = await page.evaluate(() => {
    const det = document.getElementById('docs-tax-details');
    const docsScreen = document.getElementById('s-docs');
    return !!det && !!docsScreen && docsScreen.contains(det);
  });
  assert(taxDetailsInDocs, '5: #docs-tax-details exists and lives inside #s-docs');

  await page.evaluate(() => switchScreen('home')); // land somewhere else first
  await page.waitForTimeout(150);
  await page.evaluate(() => switchScreen('tax'));
  await page.waitForTimeout(300);
  const taxAliasState = await page.evaluate(() => ({
    docsActive: document.getElementById('s-docs').classList.contains('active'),
    detailsOpen: document.getElementById('docs-tax-details').open,
    taxBodyHtml: document.getElementById('tax-body').innerHTML,
  }));
  assert(taxAliasState.docsActive, '5: switchScreen("tax") lands on the Docs screen (#s-docs active)');
  assert(taxAliasState.detailsOpen, '5: switchScreen("tax") opens the #docs-tax-details block');
  assert(taxAliasState.taxBodyHtml.length > 0, '5: the tax calculator (tax.js renderTax) actually rendered into #tax-body');

  // ═══ 6. Card-checkout waitlist row ═══════════════════════════════════════
  await page.evaluate(() => onLangChange('en'));
  await page.waitForTimeout(150);
  await page.evaluate(() => switchScreen('more'));
  await page.waitForTimeout(200);
  const waitlistOffState = await page.evaluate(() => ({
    pressed: document.getElementById('card-waitlist-toggle').getAttribute('aria-pressed'),
    sub: document.querySelector('#card-waitlist-body .list-sub').textContent,
    settingVal: !!settings.cardWaitlist,
    expectedSub: t('card_waitlist_sub'),
  }));
  assert(waitlistOffState.pressed === 'false' && !waitlistOffState.settingVal,
    '6: card waitlist row starts off — aria-pressed false, settings.cardWaitlist falsy');
  assert(waitlistOffState.sub === waitlistOffState.expectedSub, '6: off-state sub-copy matches t("card_waitlist_sub"), got "' + waitlistOffState.sub + '"');

  await page.click('#card-waitlist-toggle');
  await page.waitForTimeout(200);
  const waitlistOnState = await page.evaluate(() => ({
    pressed: document.getElementById('card-waitlist-toggle').getAttribute('aria-pressed'),
    sub: document.querySelector('#card-waitlist-body .list-sub').textContent,
    settingVal: settings.cardWaitlist,
    expectedThanks: t('card_waitlist_thanks'),
  }));
  assert(waitlistOnState.pressed === 'true' && waitlistOnState.settingVal === true,
    '6: clicking the toggle flips it on — aria-pressed true, settings.cardWaitlist === true');
  assert(waitlistOnState.sub === waitlistOnState.expectedThanks, '6: on-state sub-copy matches t("card_waitlist_thanks"), got "' + waitlistOnState.sub + '"');

  const loggedOn = await page.evaluate(async () => {
    const uid = isGuest ? 'guest' : currentUser.id;
    return (await dbAll('usageEvents')).some(e => e.uid === uid && e.name === 'card_waitlist:on');
  });
  assert(loggedOn, '6: toggling on logs a "card_waitlist:on" usageEvents row');

  // Persists across a reload
  await page.reload();
  await page.waitForFunction(() => { try { return typeof currentUser !== 'undefined' && !!currentUser; } catch (e) { return false; } }, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const persistedOn = await page.evaluate(() => !!settings.cardWaitlist);
  assert(persistedOn, '6: settings.cardWaitlist === true survives a full page reload');
  await page.evaluate(() => switchScreen('more'));
  await page.waitForTimeout(200);
  const persistedDomState = await page.evaluate(() => document.getElementById('card-waitlist-toggle').getAttribute('aria-pressed'));
  assert(persistedDomState === 'true', '6: the reloaded Settings screen re-renders the toggle as on (aria-pressed true)');

  // Undoable — clicking again turns it back off and logs the off event
  await page.click('#card-waitlist-toggle');
  await page.waitForTimeout(200);
  const waitlistOffAgain = await page.evaluate(() => settings.cardWaitlist);
  assert(waitlistOffAgain === false, '6: clicking the toggle a second time turns it back off (undoable)');
  const loggedOff = await page.evaluate(async () => {
    const uid = isGuest ? 'guest' : currentUser.id;
    return (await dbAll('usageEvents')).some(e => e.uid === uid && e.name === 'card_waitlist:off');
  });
  assert(loggedOff, '6: toggling off logs a "card_waitlist:off" usageEvents row');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
