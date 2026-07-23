/* Acceptance suite for TSK-016 — the inline stage-gate's linked Calendar
 * booking. Since TSK-012 the gate wrote only job.due (a scalar reminder);
 * this restores the old full-screen gate's real bookings-row behavior
 * alongside it, via job.dueBookingCuid + syncGateBookingForDue() in app.js.
 *
 * Run: NODE_PATH=/opt/node22/lib/node_modules node tests/check-gate-booking.js
 * Harness pattern copied from tests/check-task-flow-v2.js.
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:9003';
const EXE = '/opt/pw-browsers/chromium';

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
  await page.fill('#auth-user', 'gatebk' + Date.now());
  await page.fill('#auth-name', 'Gate Booking Tester');
  await page.fill('#auth-pass', 'pass1234');
  await page.fill('#auth-confirm', 'pass1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#modal-persona-onboard.open', { timeout: 20000 });
  await page.click('#modal-persona-onboard .list-row:nth-child(1)');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('cloud-backup-modal')?.remove());
  await page.evaluate(async () => { await onLangChange('en'); renderPipeline(); });
  await page.waitForTimeout(200);

  const installHelpers = () => page.evaluate(async () => {
    const existing = (await dbAll('clients')).find(c => c.uid === currentUser.id && c.name === 'Gate Client');
    window.__cid = existing ? existing.id
      : await dbAdd('clients', { uid: currentUser.id, name: 'Gate Client', phone: '', notes: '', createdAt: nowISO(), cuid: cuid() });
    window.__mkJob = async function (stage, extra) {
      const j = Object.assign({ uid: currentUser.id, date: todayISO(), client: 'Gate Client', clientId: window.__cid,
        serviceId: null, serviceName: 'Gate svc', jobType: settings.workType || '', amount: 500, tip: 0, expense: 0,
        count: 1, notes: '', netAmount: 500, cuid: cuid(), stageOrder: getStageOrder().slice(),
        stage: stage || getStageOrder()[0], complete: false, outcome: null, invoiceId: null, quoteDocId: null,
        packageId: null, due: null, note: null, attempt: 1, dueBookingCuid: null, updatedAt: nowISO() }, extra || {});
      const id = await dbPut('jobs', j);
      await reload();
      return id;
    };
  });
  await installHelpers();
  const mkJob = (stage, extra) => page.evaluate(args => window.__mkJob(args[0], args[1]), [stage || null, extra || null]);
  const job = (id, expr) => page.evaluate(args => {
    const j = jobs.find(x => x.id === args[0]);
    return eval(args[1]);
  }, [id, expr]);
  const bookingsForJob = (jobCuid) => page.evaluate(async (cuidVal) => {
    const all = await dbAll('bookings');
    return all.filter(b => b.jobCuid === cuidVal).map(b => ({ cuid: b.cuid, date: b.date, title: b.title }));
  }, jobCuid);
  const goto = (stage) => page.evaluate(s => { switchScreen('pipeline'); setPipelineView('board'); selectPipelineStage(s); }, stage);

  // ═══ 1. Advancing with a date creates a real booking on Calendar ═══════
  const j1 = await mkJob('inquiry');
  const j1cuid = await job(j1, 'j.cuid');
  await goto('inquiry');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'quote'), j1);
  await page.waitForTimeout(300);
  const dateVal1 = await page.evaluate(() => addDaysISO(todayISO(), 7));
  await page.fill(`#gate-date-${j1}`, dateVal1);
  await page.click('.gate-btn-primary');   // "Book & move"
  await page.waitForTimeout(400);
  const bk1 = await bookingsForJob(j1cuid);
  assert(bk1.length === 1, '1: advancing with a date creates exactly 1 linked booking, got ' + bk1.length);
  assert(bk1[0] && bk1[0].date === dateVal1, '1: the booking carries the chosen date, got ' + JSON.stringify(bk1));
  assert(bk1[0] && bk1[0].title.includes('Gate Client'), '1: booking title includes the client name, got ' + JSON.stringify(bk1));
  const dueBookingCuid1 = await job(j1, 'j.dueBookingCuid');
  assert(dueBookingCuid1 && dueBookingCuid1 === bk1[0].cuid, '1: job.dueBookingCuid links to the created booking');

  // ═══ 2. Skip creates no booking ══════════════════════════════════════════
  const j2 = await mkJob('inquiry');
  const j2cuid = await job(j2, 'j.cuid');
  await goto('inquiry');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'quote'), j2);
  await page.waitForTimeout(300);
  await page.click('.gate-btn-secondary');   // "Skip"
  await page.waitForTimeout(400);
  const bk2 = await bookingsForJob(j2cuid);
  assert(bk2.length === 0, '2: skipping the gate creates no booking, got ' + bk2.length);
  assert(await job(j2, 'j.dueBookingCuid') === null, '2: job.dueBookingCuid stays null after Skip');

  // ═══ 3. Postpone MOVES the existing booking, doesn't duplicate it ═══════
  const j3 = await mkJob('booked', { due: '2020-01-01' });
  const j3cuid = await job(j3, 'j.cuid');
  await goto('booked');
  await page.waitForTimeout(300);
  // Seed a pre-existing linked booking directly (simulates one already made
  // by an earlier Advance), the way #1 above produced one organically.
  const seedCuid = await page.evaluate(async ({ id, cuidVal, client }) => {
    const j = jobs.find(x => x.id === id);
    const row = { uid: currentUser.id, cuid: cuid(), customerId: j.clientId, title: 'Session — ' + client,
      date: '2020-01-01', startTime: '09:00', durationMin: 60, travelBufferMin: 0, location: '',
      notes: '', status: 'scheduled', jobCuid: cuidVal, createdAt: nowISO(), updatedAt: nowISO() };
    const key = await dbAdd('bookings', row); row.id = key;
    j.dueBookingCuid = row.cuid;
    await dbPut('jobs', j);
    await reload();
    return row.cuid;
  }, { id: j3, cuidVal: j3cuid, client: 'Gate Client' });
  await page.waitForTimeout(200);
  await page.evaluate(id => openGateCard(id, 'postpone'), j3);
  await page.waitForTimeout(300);
  const newDate3 = await page.evaluate(() => addDaysISO(todayISO(), 14));
  await page.fill(`#gate-date-${j3}`, newDate3);
  await page.click('.gate-btn-primary');   // "Rebook"
  await page.waitForTimeout(400);
  const bk3 = await bookingsForJob(j3cuid);
  assert(bk3.length === 1, '3: postponing moves the SAME booking rather than creating a second one, got ' + bk3.length);
  assert(bk3[0] && bk3[0].cuid === seedCuid, '3: the booking cuid is unchanged (moved in place, not recreated)');
  assert(bk3[0] && bk3[0].date === newDate3, '3: the moved booking carries the new date, got ' + JSON.stringify(bk3));

  // ═══ 4. Redo also moves (not duplicates) the linked booking ════════════
  const j4 = await mkJob('quote');
  const j4cuid = await job(j4, 'j.cuid');
  const seedCuid4 = await page.evaluate(async ({ id, cuidVal }) => {
    const j = jobs.find(x => x.id === id);
    const row = { uid: currentUser.id, cuid: cuid(), customerId: j.clientId, title: 'Quote follow-up — Gate Client',
      date: '2020-02-02', startTime: '09:00', durationMin: 60, travelBufferMin: 0, location: '',
      notes: '', status: 'scheduled', jobCuid: cuidVal, createdAt: nowISO(), updatedAt: nowISO() };
    const key = await dbAdd('bookings', row); row.id = key;
    j.dueBookingCuid = row.cuid; j.due = '2020-02-02';
    await dbPut('jobs', j);
    await reload();
    return row.cuid;
  }, { id: j4, cuidVal: j4cuid });
  await goto('quote');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'redo'), j4);
  await page.waitForTimeout(300);
  const newDate4 = await page.evaluate(() => addDaysISO(todayISO(), 21));
  await page.fill(`#gate-date-${j4}`, newDate4);
  await page.click('.gate-btn-primary');   // "Save date"
  await page.waitForTimeout(400);
  const bk4 = await bookingsForJob(j4cuid);
  assert(bk4.length === 1, '4: Redo with a date moves the same booking, got ' + bk4.length);
  assert(bk4[0] && bk4[0].cuid === seedCuid4, '4: the booking cuid is unchanged across Redo');
  assert(bk4[0] && bk4[0].date === newDate4, '4: the moved booking carries the new date, got ' + JSON.stringify(bk4));

  // ═══ 5. Cancel deletes the linked booking (no orphaned calendar entry) ══
  const j5 = await mkJob('inquiry');
  const j5cuid = await job(j5, 'j.cuid');
  await goto('inquiry');
  await page.waitForTimeout(300);
  await page.evaluate(id => openGateCard(id, 'quote'), j5);
  await page.waitForTimeout(300);
  const dateVal5 = await page.evaluate(() => addDaysISO(todayISO(), 5));
  await page.fill(`#gate-date-${j5}`, dateVal5);
  await page.click('.gate-btn-primary');
  await page.waitForTimeout(400);
  assert((await bookingsForJob(j5cuid)).length === 1, '5 setup: job has a linked booking before cancelling');
  await page.evaluate(id => openGateCard(id, 'cancel'), j5);
  await page.waitForTimeout(300);
  await page.click('.gate-btn-danger');   // "Cancel job"
  await page.waitForTimeout(400);
  const bk5 = await bookingsForJob(j5cuid);
  assert(bk5.length === 0, '5: cancelling the job deletes its linked booking, got ' + bk5.length);
  assert(await job(j5, 'j.dueBookingCuid') === null, '5: job.dueBookingCuid cleared after cancel');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('Console/page errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
