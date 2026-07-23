/* Sidekick — Calendar Week view (2026-07-17, viewport updated 2026-07-22 for
 * TSK-010).
 *
 * Closes the recorded P2 "Calendar Week view" — assessed & recommended in
 * the project changelog, distinct from the REJECTED work-week/quarter/year
 * modes (those stay dead; this is the one week view that was recommended).
 * Replaces the previous calMode==='week' shape (a 7-day strip selector +
 * one day's timeline underneath) with a real 7-day-column hour grid: the
 * whole week is visible at once, bookings render as absolutely-positioned
 * blocks inside their day column, overlapping bookings split side-by-side.
 *
 * TSK-010 note: this suite originally ran at a 360px (mobile) viewport, back
 * when the 7-day grid was the only Week-mode shape at every width. TSK-010
 * made a 3-day grid the mobile default below the app's 900px desktop
 * breakpoint (see styles.css's existing @media(min-width:900px) convention)
 * — the 7-day grid this suite exercises now only renders at >=900px, so the
 * viewport below was moved to a desktop width to keep testing the same
 * 7-day geometry/behavior this suite has always covered. The 3-day mobile
 * grid has its own dedicated coverage in check-calendar-3day-v2.js.
 *
 * v1 scope covered here: the grid renders correctly (7 columns, plausible
 * block geometry incl. an overlap split), the Week/Month toggle persists via
 * calViewMode, tapping a block opens its edit form, tapping an empty hour
 * cell opens a pre-filled new-booking form, and the grid's own scroll
 * container is the only source of any horizontal overflow at desktop width.
 * NOT covered (residual, by design): 3+-way overlap cascading, cross-midnight
 * bookings, and the ▲/▼ off-range clamp hint (no fixture exercises a
 * booking starting before 06:00 or ending after 22:00).
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node check-week-view.js
 * Expects http://localhost:8923 serving ../app.
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true });
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
  const errors = [];

  // Desktop width (>=900px) — the 7-day grid's breakpoint as of TSK-010.
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  await page.goto('http://localhost:8923/login.html');
  await page.waitForTimeout(300);
  await page.click('#tab-register');
  await page.fill('#auth-user', 'weekview-test-' + Date.now());
  await page.fill('#auth-name', 'Weekview Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());

  // ── Seed 3 bookings: two overlapping today (10:00/60min + 10:30/60min,
  // the second starting mid-way through the first), plus an isolated
  // 90-minute one two days out — enough to exercise the overlap-split lane
  // logic, single-lane geometry, and cross-day-column placement in one pass.
  const fixture = await page.evaluate(async () => {
    const today = todayISO();
    // Gamma (and later the "empty cell" probe) must land inside the *same*
    // Mon–Sun week bookings.js's weekDates() computes for `today`
    // (mondayOffset = (getDay()+6)%7, week spans Monday-start offsets 0..6,
    // i.e. calendar-day deltas -mondayOffset..6-mondayOffset from `today`).
    // A flat "+N days" only stays in-week when today's mondayOffset is
    // small enough; on Thu/Fri/Sat/Sun a naive "+2" or "+1" can roll into
    // next week and no .wk-daycol for it is ever rendered. Instead, pick
    // target days by their Monday-start offset within the week (which is
    // in-week by construction) and convert back to a calendar delta from
    // `today` — correct on every day of the week.
    const mondayOffset = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
    const deltaForWeekOffset = weekOffset => weekOffset - mondayOffset;
    const plus2 = tlAddDays(today, deltaForWeekOffset((mondayOffset + 2) % 7));
    const emptyDay = tlAddDays(today, deltaForWeekOffset((mondayOffset + 1) % 7));
    const mk = (title, date, startTime, durationMin) => dbAdd('bookings', {
      uid: currentUser.id, customerId: null, title, date, startTime, durationMin,
      travelBufferMin: 0, location: '', notes: '', status: 'scheduled',
      updatedAt: nowISO(), createdAt: nowISO(), cuid: cuid(), jobCuid: null,
    });
    const alphaId = await mk('Alpha Session', today, '10:00', 60);
    const betaId = await mk('Beta Session', today, '10:30', 60);
    const gammaId = await mk('Gamma Trip', plus2, '07:00', 90);
    return { today, plus2, emptyDay, alphaId, betaId, gammaId };
  });

  await page.evaluate(() => switchScreen('book'));
  await page.waitForTimeout(400);

  // ═══ 1. Toggle to Week view, persists across reload ════════════════════
  await page.click('[data-cal-mode="week"]');
  await page.waitForTimeout(400);
  const modeAfterClick = await page.evaluate(() => ({
    active: document.querySelector('[data-cal-mode="week"]').classList.contains('active'),
    setting: settings.calViewMode,
    scroller: !!document.querySelector('.wk-scroll'),
  }));
  assert(modeAfterClick.active && modeAfterClick.setting === 'week' && modeAfterClick.scroller,
    '1: clicking Week activates it, persists calViewMode, renders .wk-scroll, got ' + JSON.stringify(modeAfterClick));

  await page.reload();
  await page.waitForFunction(() => { try { return typeof settings !== 'undefined' && settings.calViewMode; } catch (e) { return false; } }, null, { timeout: 20000 });
  await page.evaluate(() => { document.getElementById('cloud-backup-modal')?.remove(); switchScreen('book'); });
  await page.waitForTimeout(400);
  const modeAfterReload = await page.evaluate(() => ({
    active: document.querySelector('[data-cal-mode="week"]')?.classList.contains('active'),
    scroller: !!document.querySelector('.wk-scroll'),
  }));
  assert(modeAfterReload.active && modeAfterReload.scroller, '1: Week view still active after reload, got ' + JSON.stringify(modeAfterReload));

  // ═══ 2. 7 day columns render ═════════════════════════════════════════
  const colCount = await page.locator('.wk-daycol').count();
  const headCount = await page.locator('.wk-day-head').count();
  assert(colCount === 7, '2: 7 day columns render, got ' + colCount);
  assert(headCount === 7, '2: 7 day header cells render, got ' + headCount);

  // ═══ 3. Today's header is highlighted ═══════════════════════════════
  const todayHead = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.wk-day-head.wk-today'));
    return { count: els.length, num: els[0] ? els[0].querySelector('.wk-day-num').textContent.trim() : null };
  });
  const todayNum = await page.evaluate(() => new Date(todayISO() + 'T12:00:00').getDate());
  assert(todayHead.count === 1, '3: exactly one .wk-day-head.wk-today, got ' + todayHead.count);
  assert(todayHead.num === String(todayNum), `3: highlighted header shows today's day number ${todayNum}, got ${todayHead.num}`);

  // ═══ 4. The three blocks land in the right day columns ══════════════
  const placement = await page.evaluate(({ today, plus2 }) => {
    const titlesIn = iso => Array.from(document.querySelectorAll(`.wk-daycol[data-wk-day="${iso}"] .wk-block`)).map(b => b.querySelector('.wk-block-title').textContent.trim());
    return { todayTitles: titlesIn(today), plus2Titles: titlesIn(plus2) };
  }, { today: fixture.today, plus2: fixture.plus2 });
  assert(placement.todayTitles.includes('Alpha Session') && placement.todayTitles.includes('Beta Session'),
    "4: today's column has Alpha + Beta, got " + JSON.stringify(placement.todayTitles));
  assert(placement.plus2Titles.length === 1 && placement.plus2Titles[0] === 'Gamma Trip',
    '4: +2-day column has exactly Gamma, got ' + JSON.stringify(placement.plus2Titles));

  // ═══ 5. Plausible block geometry ═════════════════════════════════════
  const geom = await page.evaluate(({ alphaId, betaId, gammaId }) => {
    const rect = id => document.querySelector(`.wk-block[data-bk="${id}"]`).getBoundingClientRect();
    return { alpha: rect(alphaId), beta: rect(betaId), gamma: rect(gammaId) };
  }, fixture);
  assert(geom.gamma.height > geom.alpha.height && geom.gamma.height > geom.beta.height,
    `5: the 90-min block is taller than the 60-min ones, got gamma=${geom.gamma.height} alpha=${geom.alpha.height} beta=${geom.beta.height}`);
  assert(Math.abs(geom.alpha.height - geom.beta.height) < 2,
    `5: the two 60-min blocks have matching height, got alpha=${geom.alpha.height} beta=${geom.beta.height}`);
  const verticallyOverlap = geom.alpha.top < geom.beta.bottom && geom.beta.top < geom.alpha.bottom;
  const sideBySide = Math.abs(geom.alpha.left - geom.beta.left) > 5;
  assert(verticallyOverlap, `5: Alpha/Beta's 10:00 overlap is reflected vertically, got alpha=${JSON.stringify({ top: geom.alpha.top, bottom: geom.alpha.bottom })} beta=${JSON.stringify({ top: geom.beta.top, bottom: geom.beta.bottom })}`);
  assert(sideBySide, `5: overlapping Alpha/Beta split side-by-side (different left), got alpha.left=${geom.alpha.left} beta.left=${geom.beta.left}`);

  // ═══ 6. Tap a block → edit form for the right booking ════════════════
  await page.click(`.wk-block[data-bk="${fixture.alphaId}"]`);
  await page.waitForSelector('#bk-form-modal', { timeout: 5000 });
  const editTitle = await page.locator('#bk-title').inputValue();
  assert(editTitle === 'Alpha Session', "6: tapping Alpha's block opens edit form prefilled with its title, got " + editTitle);
  await page.click('#bk-cancel');
  await page.waitForTimeout(200);

  // ═══ 7. Tap an empty hour cell → new-booking form prefilled ══════════
  // Use fixture.emptyDay: a day within the same rendered week that has no
  // fixture booking on it (distinct from `today` and `plus2` by construction
  // — see the fixture setup above), clearly empty.
  const emptyDay = fixture.emptyDay;
  await page.click(`.wk-daycol[data-wk-day="${emptyDay}"] .wk-hourcell[data-wk-cell-time="09:00"]`);
  await page.waitForSelector('#bk-form-modal', { timeout: 5000 });
  const newForm = await page.evaluate(() => ({
    date: document.getElementById('bk-date').value,
    start: document.getElementById('bk-start').value,
    isNew: document.querySelector('#bk-del') === null,
  }));
  assert(newForm.isNew, '7: tapping an empty cell opens the CREATE form (no delete button), got isNew=' + newForm.isNew);
  assert(newForm.date === emptyDay, `7: new-booking form date prefilled to the tapped column ${emptyDay}, got ${newForm.date}`);
  assert(newForm.start === '09:00', '7: new-booking form start time prefilled to the tapped hour, got ' + newForm.start);
  await page.click('#bk-cancel');
  await page.waitForTimeout(200);

  // ═══ 8. No page-level horizontal scroll at desktop width ═════════════
  const scrollCheck = await page.evaluate(() => ({
    bodyScrollW: document.body.scrollWidth, bodyClientW: document.body.clientWidth,
  }));
  assert(scrollCheck.bodyScrollW === scrollCheck.bodyClientW,
    `8: horizontal scroll confined to .wk-scroll (body scrollWidth === clientWidth) at desktop width, got ${JSON.stringify(scrollCheck)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
