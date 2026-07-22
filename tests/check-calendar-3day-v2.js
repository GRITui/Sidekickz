/* Sidekick — Calendar 3-day mobile view (TSK-010, 2026-07-22).
 *
 * Closes TSK-010 (loop/backlog-inbox.md; design spec:
 * loop/design-handoff/README.md §"4. Calendar — 3-day view"). Makes a 3-day
 * column grid the MOBILE default for the Week/Month toggle's "week" mode
 * (data-cal-mode stays "week" — only its rendered shape and its toggle
 * button's label change per breakpoint), while the pre-existing 7-day grid
 * is fully preserved and still renders unchanged at >=900px (the app's
 * existing @media(min-width:900px) desktop-breakpoint convention).
 *
 * Covers: at a mobile viewport (390px) the 3-day grid renders instead of
 * 7-day, the pager shifts the visible window by 3 days, hour rows are 72px
 * tall, event blocks are >=44px tall (incl. a very short booking clamped to
 * the 44px minimum); at a desktop viewport (>=900px) the original 7-day grid
 * still renders with its original 60px hour rows and 24px block minimum
 * (regression guard — TSK-010 must not have changed desktop's pixel output);
 * Month view still opens/renders from both viewports; two overlapping
 * bookings still split side-by-side in the single 3-day column (same
 * assignLanes()/wkBlockStyle() lane logic the 7-day grid already used,
 * reused unchanged — see tests/check-week-view.js §5 for the 7-day
 * equivalent of this same assertion).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node check-calendar-3day-v2.js
 * Expects http://localhost:8923 serving ../app.
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];
  const trackErrors = (page) => {
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(String(err)));
  };

  const registerAndOnboard = async (page, userPrefix) => {
    await page.goto('http://localhost:8923/login.html');
    await page.waitForTimeout(300);
    await page.click('#tab-register');
    await page.fill('#auth-user', userPrefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
    await page.fill('#auth-name', userPrefix + ' Tester');
    await page.fill('#auth-pass', 'pass1234');
    await page.fill('#auth-confirm', 'pass1234');
    await page.click('#auth-submit');
    await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
    await page.click('#modal-persona-onboard .list-row:nth-child(1)');
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  };

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1 — mobile viewport (390px): 3-day grid
  // ═══════════════════════════════════════════════════════════════════════
  const mobile = await browser.newPage({ viewport: { width: 390, height: 800 } });
  trackErrors(mobile);
  await registerAndOnboard(mobile, 'cal3day-mobile');

  // Seed: two overlapping bookings today (10:00/60min + 10:30/60min, same
  // fixture shape as check-week-view.js §5) plus a 10-minute booking to
  // exercise the 44px minimum-block clamp.
  const mFixture = await mobile.evaluate(async () => {
    const today = todayISO();
    const mk = (title, date, startTime, durationMin) => dbAdd('bookings', {
      uid: currentUser.id, customerId: null, title, date, startTime, durationMin,
      travelBufferMin: 0, location: '', notes: '', status: 'scheduled',
      updatedAt: nowISO(), createdAt: nowISO(), cuid: cuid(), jobCuid: null,
    });
    const alphaId = await mk('Alpha Session', today, '10:00', 60);
    const betaId = await mk('Beta Session', today, '10:30', 60);
    const shortId = await mk('Short Ping', today, '14:00', 10);
    return { today, alphaId, betaId, shortId };
  });

  await mobile.evaluate(() => switchScreen('book'));
  await mobile.waitForTimeout(400);
  await mobile.click('[data-cal-mode="week"]');
  await mobile.waitForTimeout(400);

  // ═══ 1. 3-day grid renders (not 7-day), 3 columns ════════════════════
  const mColCount = await mobile.locator('.wk-daycol').count();
  const mHeadCount = await mobile.locator('.wk-day-head').count();
  const mScroller3Class = await mobile.evaluate(() => !!document.querySelector('.wk-scroll.wk3'));
  assert(mColCount === 3, '1: mobile (390px) renders 3 day columns, got ' + mColCount);
  assert(mHeadCount === 3, '1: mobile renders 3 day header cells, got ' + mHeadCount);
  assert(mScroller3Class, '1: mobile .wk-scroll carries the .wk3 modifier class');

  // ═══ 2. Toggle label reads "3-day" (not "Week") at mobile width ══════
  const toggleLabelMobile = await mobile.locator('[data-cal-mode="week"]').textContent();
  assert(toggleLabelMobile.trim() === await mobile.evaluate(() => t('cal_mode_3day')),
    '2: mobile toggle label is the 3-day i18n string, got "' + toggleLabelMobile + '"');

  // ═══ 3. Hour rows are 72px tall ═══════════════════════════════════════
  const hourRowH = await mobile.evaluate(() => {
    const el = document.querySelector('.wk-hour-lbl');
    return el ? el.getBoundingClientRect().height : null;
  });
  assert(hourRowH !== null && Math.abs(hourRowH - 72) < 1.5, '3: hour row height is 72px, got ' + hourRowH);
  const hourCellH = await mobile.evaluate(() => {
    const el = document.querySelector('.wk-hourcell');
    return el ? el.getBoundingClientRect().height : null;
  });
  assert(hourCellH !== null && Math.abs(hourCellH - 72) < 1.5, '3: hour tap-cell height is 72px, got ' + hourCellH);

  // ═══ 4. Event blocks are >=44px tall (a 60-min block, and the 10-min one
  //        clamped to the minimum) ═══════════════════════════════════════
  const blockHeights = await mobile.evaluate(({ alphaId, shortId }) => ({
    alpha: document.querySelector(`.wk-block[data-bk="${alphaId}"]`)?.getBoundingClientRect().height,
    short: document.querySelector(`.wk-block[data-bk="${shortId}"]`)?.getBoundingClientRect().height,
  }), mFixture);
  assert(blockHeights.alpha >= 44, '4: a 60-min block is >=44px tall, got ' + blockHeights.alpha);
  assert(blockHeights.short >= 44, '4: a 10-min block still clamps to >=44px, got ' + blockHeights.short);
  // Spec: a 1-hour block should render ~62px (72px row minus the 10px
  // breathing-room inset — see WK_VIEW_3DAY in bookings.js).
  assert(Math.abs(blockHeights.alpha - 62) < 2, '4: a 60-min block is ~62px tall per spec, got ' + blockHeights.alpha);

  // ═══ 5. Overlapping Alpha/Beta still split side-by-side in the 3-day grid
  const geom = await mobile.evaluate(({ alphaId, betaId }) => {
    const rect = id => document.querySelector(`.wk-block[data-bk="${id}"]`).getBoundingClientRect();
    return { alpha: rect(alphaId), beta: rect(betaId) };
  }, mFixture);
  const mVerticallyOverlap = geom.alpha.top < geom.beta.bottom && geom.beta.top < geom.alpha.bottom;
  const mSideBySide = Math.abs(geom.alpha.left - geom.beta.left) > 5;
  assert(mVerticallyOverlap, '5: Alpha/Beta overlap reflected vertically in the 3-day grid, got ' + JSON.stringify({ alpha: geom.alpha, beta: geom.beta }));
  assert(mSideBySide, '5: overlapping Alpha/Beta split side-by-side (different left) in the 3-day grid, got alpha.left=' + geom.alpha.left + ' beta.left=' + geom.beta.left);

  // ═══ 6. Pager shifts the 3-day window by 3 days ═══════════════════════
  const daysBefore = await mobile.evaluate(() => Array.from(document.querySelectorAll('.wk-daycol')).map(c => c.getAttribute('data-wk-day')));
  await mobile.click('#cal-next');
  await mobile.waitForTimeout(300);
  const daysAfter = await mobile.evaluate(() => Array.from(document.querySelectorAll('.wk-daycol')).map(c => c.getAttribute('data-wk-day')));
  const shiftedCorrectly = daysBefore.every((iso, i) => {
    const expected = new Date(iso + 'T12:00:00'); expected.setDate(expected.getDate() + 3);
    const exp = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
    return daysAfter[i] === exp;
  });
  assert(daysAfter.length === 3 && shiftedCorrectly,
    '6: › pager shifts all 3 visible dates by +3 days, before=' + JSON.stringify(daysBefore) + ' after=' + JSON.stringify(daysAfter));
  await mobile.click('#cal-prev');
  await mobile.waitForTimeout(300);
  const daysBackToStart = await mobile.evaluate(() => Array.from(document.querySelectorAll('.wk-daycol')).map(c => c.getAttribute('data-wk-day')));
  assert(JSON.stringify(daysBackToStart) === JSON.stringify(daysBefore),
    '6: ‹ pager shifts back by -3 days, restoring the original window, got ' + JSON.stringify(daysBackToStart));
  await mobile.click('#cal-today-btn');
  await mobile.waitForTimeout(300);

  // ═══ 7. Month view still works from mobile ════════════════════════════
  await mobile.click('[data-cal-mode="month"]');
  await mobile.waitForTimeout(400);
  const monthGridMobile = await mobile.locator('.cal-grid').count();
  assert(monthGridMobile === 1, '7: Month view still renders (.cal-grid) from mobile, got ' + monthGridMobile);
  // Switching back to the segmented control's "week" mode returns to the
  // 3-day grid (still mobile width).
  await mobile.click('[data-cal-mode="week"]');
  await mobile.waitForTimeout(400);
  assert(await mobile.locator('.wk-daycol').count() === 3, '7: switching back to week mode re-renders the 3-day grid on mobile');

  await mobile.close();

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2 — desktop viewport (>=900px): original 7-day grid unaffected
  // ═══════════════════════════════════════════════════════════════════════
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  trackErrors(desktop);
  await registerAndOnboard(desktop, 'cal3day-desktop');

  const dFixture = await desktop.evaluate(async () => {
    const today = todayISO();
    const mk = (title, date, startTime, durationMin) => dbAdd('bookings', {
      uid: currentUser.id, customerId: null, title, date, startTime, durationMin,
      travelBufferMin: 0, location: '', notes: '', status: 'scheduled',
      updatedAt: nowISO(), createdAt: nowISO(), cuid: cuid(), jobCuid: null,
    });
    const shortId = await mk('Desktop Short Ping', today, '14:00', 10);
    return { today, shortId };
  });

  await desktop.evaluate(() => switchScreen('book'));
  await desktop.waitForTimeout(400);
  await desktop.click('[data-cal-mode="week"]');
  await desktop.waitForTimeout(400);

  // ═══ 8. 7-day grid still renders at desktop width ═════════════════════
  const dColCount = await desktop.locator('.wk-daycol').count();
  const dHeadCount = await desktop.locator('.wk-day-head').count();
  const dHasWk3Class = await desktop.evaluate(() => !!document.querySelector('.wk-scroll.wk3'));
  assert(dColCount === 7, '8: desktop (>=900px) renders 7 day columns, got ' + dColCount);
  assert(dHeadCount === 7, '8: desktop renders 7 day header cells, got ' + dHeadCount);
  assert(!dHasWk3Class, '8: desktop .wk-scroll does NOT carry the .wk3 modifier class');

  // ═══ 9. Toggle label reads "Week" (not "3-day") at desktop width ═════
  const toggleLabelDesktop = await desktop.locator('[data-cal-mode="week"]').textContent();
  assert(toggleLabelDesktop.trim() === await desktop.evaluate(() => t('cal_mode_week')),
    '9: desktop toggle label is the Week i18n string, got "' + toggleLabelDesktop + '"');

  // ═══ 10. Regression guard: hour rows still 60px, block min still 24px ═
  const dHourRowH = await desktop.evaluate(() => {
    const el = document.querySelector('.wk-hour-lbl');
    return el ? el.getBoundingClientRect().height : null;
  });
  assert(dHourRowH !== null && Math.abs(dHourRowH - 60) < 1.5, '10: desktop hour row height is unchanged at 60px, got ' + dHourRowH);
  const dShortBlockH = await desktop.evaluate(({ shortId }) => {
    const el = document.querySelector(`.wk-block[data-bk="${shortId}"]`);
    return el ? el.getBoundingClientRect().height : null;
  }, dFixture);
  assert(dShortBlockH !== null && dShortBlockH >= 24 && dShortBlockH < 40,
    '10: desktop\'s 10-min block still clamps to the original ~24px minimum (not the mobile 44px one), got ' + dShortBlockH);

  // ═══ 11. Pager still shifts by 7 days at desktop width ════════════════
  const dDaysBefore = await desktop.evaluate(() => Array.from(document.querySelectorAll('.wk-daycol')).map(c => c.getAttribute('data-wk-day')));
  await desktop.click('#cal-next');
  await desktop.waitForTimeout(300);
  const dDaysAfter = await desktop.evaluate(() => Array.from(document.querySelectorAll('.wk-daycol')).map(c => c.getAttribute('data-wk-day')));
  const dShiftedCorrectly = dDaysBefore.every((iso, i) => {
    const expected = new Date(iso + 'T12:00:00'); expected.setDate(expected.getDate() + 7);
    const exp = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
    return dDaysAfter[i] === exp;
  });
  assert(dDaysAfter.length === 7 && dShiftedCorrectly,
    '11: › pager still shifts all 7 visible dates by +7 days at desktop width, before=' + JSON.stringify(dDaysBefore) + ' after=' + JSON.stringify(dDaysAfter));
  await desktop.click('#cal-today-btn');
  await desktop.waitForTimeout(300);

  // ═══ 12. Month view still works from desktop ══════════════════════════
  await desktop.click('[data-cal-mode="month"]');
  await desktop.waitForTimeout(400);
  const monthGridDesktop = await desktop.locator('.cal-grid').count();
  assert(monthGridDesktop === 1, '12: Month view still renders (.cal-grid) from desktop, got ' + monthGridDesktop);
  await desktop.click('[data-cal-mode="week"]');
  await desktop.waitForTimeout(400);
  assert(await desktop.locator('.wk-daycol').count() === 7, '12: switching back to week mode re-renders the 7-day grid on desktop');

  await desktop.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
