/* Freelanz — bookings.js  (M3 BOOKING — day view + travel buffers)
 *
 * OWNED BY the booking agent. Replaces the stub entirely.
 * Loaded AFTER app.js (and the other M2/M3 modules), so app.js globals (dbAll,
 * dbAdd, dbPut, dbDel, dbGet, cuid, nowISO, todayISO, money, fmt, curSym,
 * htmlEsc, attrEsc, toast, switchScreen, fmtDate, settings, customers, services,
 * jobs, currentUser, isGuest) are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderBookings()           — fills #book-body (a single-day agenda)
 *   - openBookingForm(dateISO?)  — create/edit booking UI
 *
 * Self-contained day-view agenda over the 'bookings' IndexedDB store: prev/today/
 * next date nav, per-day list sorted by start time, and travel-buffer gap strips
 * between adjacent bookings. English-only, light-mode.
 */
'use strict';

(function () {

  // ══════════════════════════════════════════════════════════════════════
  //  Small local helpers
  // ══════════════════════════════════════════════════════════════════════
  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'bookings';
  // Same outline used by the nav's Book icon — kept as a shared line icon
  // instead of the 📅 emoji, matching the SVG icon style used elsewhere
  // (Pipeline's stage icons, the old jump-to-date button).
  const CAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:block"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>';

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }
  function n(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
  function pad2(v) { return String(v).padStart(2, '0'); }

  function addDays(iso, days) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // Time math is done in minutes-since-midnight throughout: HH:MM strings don't
  // subtract cleanly and gap/end computations need plain integer arithmetic.
  function toMin(hhmm) {
    if (!hhmm) return 0;
    const parts = String(hhmm).split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }
  function fmtMin(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440; // wrap past-midnight ends into a clock time
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  // Readable header label: reuse app.js's fmtDate, prefix with a relative word.
  function dayLabel(iso) {
    const base = (typeof fmtDate === 'function') ? fmtDate(iso) : iso;
    if (iso === todayISO()) return 'Today · ' + base;
    if (iso === addDays(todayISO(), 1)) return 'Tomorrow · ' + base;
    if (iso === addDays(todayISO(), -1)) return 'Yesterday · ' + base;
    const d = new Date(iso + 'T12:00:00');
    const wd = isNaN(d) ? '' : d.toLocaleDateString('en-GB', { weekday: 'long' }) + ' · ';
    return wd + base;
  }

  function customerName(id) {
    if (id == null || id === '') return '';
    const c = (typeof customers !== 'undefined' ? customers : []).find(x => x.id === id);
    return c ? (c.name || '') : '';
  }

  async function loadBookings(dateISO) {
    const uid = uidNow();
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid && r.date === dateISO);
    rows.sort((a, b) => {
      const d = toMin(a.startTime) - toMin(b.startTime);
      if (d !== 0) return d;
      return (a.id || 0) - (b.id || 0);
    });
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MONTH CALENDAR  →  #book-body
  // ══════════════════════════════════════════════════════════════════════
  // A full month grid replaces the old single-day agenda as the landing view:
  // each cell gets a small legend dot if that date has a booking and/or a
  // pipeline engagement (a 'jobs' record dated that day), so the user can see
  // where the month's activity is without stepping through days one at a
  // time. Tapping a cell expands an inline agenda panel below the grid (the
  // day-list rendering itself — buildDayList/rowHtml/stripHtml — is unchanged
  // from the old day view, just relocated into that panel).
  let selectedDate = todayISO();          // last date the user looked at (fallback for "+ New booking")
  let expandedDate = todayISO();          // date whose agenda panel is open beneath the grid; null = collapsed
  let calMonth = todayISO().slice(0, 7);  // 'YYYY-MM' currently shown in the grid
  let editing = null;                     // full record being edited, or null on create

  function shiftMonth(ym, delta) {
    let [y, m] = ym.split('-').map(Number);
    m += delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return `${y}-${pad2(m)}`;
  }
  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  // Small local datasets (bookings + jobs both live entirely on-device), so it's
  // cheapest to just compute the full set of active dates once per render
  // rather than re-querying per visible day, including the leading/trailing
  // days from adjacent months shown to fill the grid. Pipeline dates are
  // bucketed per CURRENT stage (jobStage()), not just "has a job" — the
  // calendar dot for a day shows exactly which stage(s) its engagements are
  // in, using the same stage names/colors as the Pipeline board.
  async function computeActivitySets() {
    const uid = uidNow();
    const allBookings = (await dbAll(STORE)).filter(r => r.uid === uid && r.status !== 'cancelled');
    const bookingDates = new Set(allBookings.map(r => r.date));
    const stageDates = {};        // stage id -> Set of dates (legend scoping)
    const stagesByDate = {};      // iso -> array of stage ids, one entry per engagement that day
    (typeof STAGES !== 'undefined' ? STAGES : []).forEach(s => { stageDates[s] = new Set(); });
    (typeof jobs !== 'undefined' ? jobs : []).forEach(j => {
      if (!j.date || typeof jobStage !== 'function') return;
      const s = jobStage(j);
      if (!stageDates[s]) return;
      stageDates[s].add(j.date);
      (stagesByDate[j.date] = stagesByDate[j.date] || []).push(s);
    });
    return { bookingDates, stageDates, stagesByDate };
  }

  // All dates shown in the ym grid, including the leading/trailing padding
  // days borrowed from adjacent months — used both to render cells and to
  // scope the legend to only what's actually visible this month.
  function monthGridDates(ym) {
    const [y, m] = ym.split('-').map(Number);
    const startWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday=0..Sunday=6
    const numDays = new Date(y, m, 0).getDate();
    const prevMonthDays = new Date(y, m - 1, 0).getDate();
    const out = [];
    for (let i = 0; i < startWeekday; i++) {
      const dayNum = prevMonthDays - startWeekday + 1 + i;
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
      out.push({ iso: `${py}-${pad2(pm)}-${pad2(dayNum)}`, dayNum, dim: true });
    }
    for (let d = 1; d <= numDays; d++) {
      out.push({ iso: `${y}-${pad2(m)}-${pad2(d)}`, dayNum: d, dim: false });
    }
    const trailing = (7 - ((startWeekday + numDays) % 7)) % 7;
    for (let i = 1; i <= trailing; i++) {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      out.push({ iso: `${ny}-${pad2(nm)}-${pad2(i)}`, dayNum: i, dim: true });
    }
    return out;
  }

  // A single engagement that day still renders as a small stage-colored dot
  // (matches the legend). Two or more render as one number badge instead —
  // stacking dots doesn't scale for "how many," and the exact breakdown is
  // one tap away in the day panel anyway. The badge is stage-colored when
  // every engagement that day shares one stage, otherwise a neutral brand
  // color (a single dot can't represent a mix of colors).
  function pipelineMarkerHtml(stagesHere) {
    if (!stagesHere || !stagesHere.length) return '';
    if (stagesHere.length === 1) {
      return `<span class="cal-dot" style="background:${STAGE_META[stagesHere[0]].dot}"></span>`;
    }
    const uniq = Array.from(new Set(stagesHere));
    const color = uniq.length === 1 ? STAGE_META[uniq[0]].dot : 'var(--brand)';
    return `<span class="cal-count" style="background:${color}">${stagesHere.length}</span>`;
  }

  function dayCellHtml(iso, dayNum, dim, bookingDates, stagesByDate) {
    const isToday = iso === todayISO();
    const isSelected = iso === expandedDate;
    const dots = pipelineMarkerHtml(stagesByDate[iso]) + (bookingDates.has(iso) ? '<span class="cal-dot cal-dot-book"></span>' : '');
    const cls = 'cal-cell' + (dim ? ' cal-dim' : '') + (isToday ? ' cal-today' : '') + (isSelected ? ' cal-selected' : '');
    return `<button type="button" class="${cls}" data-cal="${iso}">
        <span class="cal-daynum">${dayNum}</span>
        <span class="cal-dots">${dots}</span>
      </button>`;
  }

  function buildMonthGrid(gridDates, bookingDates, stagesByDate) {
    return gridDates.map(c => dayCellHtml(c.iso, c.dayNum, c.dim, bookingDates, stagesByDate)).join('');
  }

  function emptyDayHtml(dateISO) {
    return `<div class="empty" style="padding:28px 16px">
        <div class="empty-icon" style="font-size:44px;color:var(--brand)">${CAL_SVG}</div>
        <p>Nothing on ${esc(fmtDate(dateISO))}</p>
        <span>Tap “+ New session” above to log work.</span>
        ${scheduleBookingLinkHtml(dateISO)}
      </div>`;
  }

  // The main "+ New session" button logs pipeline work, not a scheduled time
  // slot — this small secondary link keeps the duration/travel-buffer
  // booking form (still fully built below) reachable for the "block out a
  // slot on the calendar" use case, without it competing with session-
  // logging for the primary call-to-action.
  function scheduleBookingLinkHtml(dateISO) {
    return `<button type="button" class="cal-schedule-link" onclick="openBookingForm('${aesc(dateISO)}')">+ Schedule a booking</button>`;
  }

  // A day's pipeline dot only says "something's here" — this row is what makes
  // it identifiable (which client, which stage), same info the Pipeline board
  // itself shows on a card. Tapping a row jumps straight to that stage there.
  function pipelineDayRowHtml(j) {
    const stage = (typeof jobStage === 'function') ? jobStage(j) : null;
    const meta = (stage && STAGE_META[stage]) || {};
    const amt = (typeof money === 'function') ? money(j.amount) : (j.amount || '');
    return `<div class="list-row" data-pipe-stage="${aesc(stage || '')}" tabindex="0" role="button">
        <div class="list-icon" style="background:${meta.dot}22;color:${meta.dot}">${meta.icon || ''}</div>
        <div class="list-main">
          <div class="list-title">${esc(j.client || 'Client')}</div>
          <div class="list-sub">${esc(meta.label || stage || '')}${j.serviceName ? ' · ' + esc(j.serviceName) : ''}</div>
        </div>
        <div class="list-right">
          <div class="list-amt tnum">${esc(amt)}</div>
        </div>
      </div>`;
  }

  async function buildDayPanel(dateISO) {
    const rows = await loadBookings(dateISO);
    // If the last active booking of the day runs past midnight, pull
    // tomorrow's first active booking too so the buffer/overlap check can
    // see across the day boundary instead of stopping dead at midnight.
    let nextDayFirst = null;
    const active = rows.filter(r => r.status !== 'cancelled');
    const last = active[active.length - 1];
    if (last && toMin(last.startTime) + n(last.durationMin) >= 1440) {
      const nextRows = await loadBookings(addDays(dateISO, 1));
      nextDayFirst = nextRows.filter(r => r.status !== 'cancelled')[0] || null;
    }
    // Pipeline dots and booking rows are two different domains (sales-stage
    // activity vs. scheduled time slots) — a day can have any mix of the two,
    // including several engagements on the same day, so both render as their
    // own list rather than trying to merge them into one row per client.
    const dayJobs = (typeof jobs !== 'undefined' ? jobs : []).filter(j => j.date === dateISO);
    const both = dayJobs.length > 0 && rows.length > 0;
    const pipelineSection = dayJobs.length
      ? (both ? `<div class="section-title" style="font-size:12px;margin:0 0 6px">Pipeline</div>` : '') +
        `<div class="list-card" style="margin-bottom:${both ? '14px' : '0'}">${dayJobs.map(pipelineDayRowHtml).join('')}</div>`
      : '';
    const bookingSection = rows.length
      ? (both ? `<div class="section-title" style="font-size:12px;margin:0 0 6px">Bookings</div>` : '') + buildDayList(rows, nextDayFirst)
      : '';
    const body = (pipelineSection || bookingSection)
      ? (pipelineSection + bookingSection + scheduleBookingLinkHtml(dateISO))
      : emptyDayHtml(dateISO);
    return `<div class="cal-daypanel">
        <div class="cal-daypanel-head">${esc(dayLabel(dateISO))}</div>
        ${body}
      </div>`;
  }

  async function renderBookings() {
    const el = document.getElementById('book-body');
    if (!el) return;
    if (!selectedDate) selectedDate = todayISO();
    if (!calMonth) calMonth = todayISO().slice(0, 7);

    let bookingDates, stageDates, stagesByDate, dayPanelHtml = '';
    try {
      ({ bookingDates, stageDates, stagesByDate } = await computeActivitySets());
      if (expandedDate) dayPanelHtml = await buildDayPanel(expandedDate);
    } catch (err) {
      console.error('renderBookings', err);
      el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load bookings.</p></div>`;
      return;
    }

    const monthNav = `<div class="cal-topnav">
        <button type="button" id="cal-prev" class="cal-navbtn" aria-label="Previous month">‹</button>
        <button type="button" id="cal-label" class="cal-monthlabel">${esc(monthLabel(calMonth))}</button>
        <button type="button" id="cal-next" class="cal-navbtn" aria-label="Next month">›</button>
        <button type="button" id="cal-today-btn" class="cal-todaybtn">Today</button>
        <input type="date" id="bk-jump" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">
      </div>`;

    const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const wdRow = `<div class="cal-wd-row">${WD.map(w => `<div class="cal-wd">${w}</div>`).join('')}</div>`;
    const gridDates = monthGridDates(calMonth);
    const grid = `<div class="cal-grid">${buildMonthGrid(gridDates, bookingDates, stagesByDate)}</div>`;

    // Legend only lists what's actually marked somewhere on the visible grid
    // (including its leading/trailing padding days) — no point explaining a
    // stage color the user can't currently see a dot for.
    const isos = gridDates.map(c => c.iso);
    const stageLegendItems = (typeof STAGES !== 'undefined' ? STAGES : [])
      .filter(s => stageDates[s] && isos.some(iso => stageDates[s].has(iso)))
      .map(s => `<span class="cal-legend-item"><span class="cal-dot" style="background:${STAGE_META[s].dot}"></span> ${esc(STAGE_META[s].label)}</span>`).join('');
    const bookingLegendItem = isos.some(iso => bookingDates.has(iso))
      ? `<span class="cal-legend-item"><span class="cal-dot cal-dot-book"></span> Booking</span>` : '';
    const legend = (stageLegendItems || bookingLegendItem)
      ? `<div class="cal-legend">${stageLegendItems}${bookingLegendItem}</div>` : '';
    const addLabel = expandedDate ? ' · ' + fmtDate(expandedDate) : '';
    // Adding from Calendar creates a pipeline session (same "Add session" job
    // form/modal used from Home/Pipeline's FAB, pre-filled with the selected
    // date), not a separate booking — a calendar day's primary action is
    // logging the work itself, not scheduling a time slot for it.
    const btn = `<button type="button" id="bk-new-btn" class="btn-submit" style="width:100%;margin:14px 0 16px">+ New session${esc(addLabel)}</button>`;

    // Two visual columns on desktop (`.cal-layout` grid, see styles.css) so
    // the day panel sits beside the month grid instead of below it — no
    // scrolling needed to see what's on a day after tapping it. On mobile
    // the grid rule doesn't apply and this just stacks top-to-bottom as before.
    const rightPanel = dayPanelHtml || `<div class="empty cal-daypanel-placeholder"><p>Tap a day to see what's on it.</p></div>`;
    el.innerHTML = `<div class="cal-layout">
        <div class="cal-left">${monthNav}${wdRow}${grid}${legend}${btn}</div>
        <div class="cal-right">${rightPanel}</div>
      </div>`;

    document.getElementById('cal-prev').addEventListener('click', () => { calMonth = shiftMonth(calMonth, -1); expandedDate = null; renderBookings(); });
    document.getElementById('cal-next').addEventListener('click', () => { calMonth = shiftMonth(calMonth, 1); expandedDate = null; renderBookings(); });
    document.getElementById('cal-today-btn').addEventListener('click', () => { calMonth = todayISO().slice(0, 7); expandedDate = todayISO(); selectedDate = todayISO(); renderBookings(); });
    document.getElementById('bk-new-btn').addEventListener('click', () => openAddJob(expandedDate || selectedDate || todayISO()));
    // Tapping the month label jumps straight to any date via the native date
    // picker, instead of stepping one month at a time with ‹ › — the hidden
    // input just proxies the picker UI.
    document.getElementById('cal-label').addEventListener('click', () => {
      const inp = document.getElementById('bk-jump');
      inp.value = expandedDate || selectedDate || todayISO();
      if (inp.showPicker) inp.showPicker(); else inp.click();
    });
    document.getElementById('bk-jump').addEventListener('change', (e) => {
      if (!e.target.value) return;
      calMonth = e.target.value.slice(0, 7);
      expandedDate = e.target.value;
      selectedDate = e.target.value;
      renderBookings();
    });

    el.querySelectorAll('[data-cal]').forEach(cell => {
      cell.addEventListener('click', () => {
        const iso = cell.getAttribute('data-cal');
        if (!iso) return;
        if (iso === expandedDate) { expandedDate = null; renderBookings(); return; }
        expandedDate = iso;
        selectedDate = iso;
        if (iso.slice(0, 7) !== calMonth) calMonth = iso.slice(0, 7);
        renderBookings();
      });
    });

    el.querySelectorAll('[data-bk]').forEach(row => {
      const open = () => openBookingEdit(parseInt(row.getAttribute('data-bk'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    // Pipeline rows in the day panel jump to that engagement's stage on the
    // Pipeline board — the calendar itself never edits pipeline data.
    el.querySelectorAll('[data-pipe-stage]').forEach(row => {
      const go = () => { if (typeof openPipelineAt === 'function') openPipelineAt(row.getAttribute('data-pipe-stage')); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }
  window.renderBookings = renderBookings;

  function buildDayList(rows, nextDayFirst) {
    // Buffer gaps are computed only between non-cancelled bookings; cancelled
    // ones still render (de-emphasized) but never contribute to a gap. Strips
    // are keyed by the NEXT booking's id (rendered immediately before it) so a
    // cancelled row sitting chronologically between two active ones can't
    // shift the strip onto the wrong pair.
    const active = rows.filter(r => r.status !== 'cancelled');
    const stripsBefore = {}; // nextBookingId -> strip HTML rendered right before that row
    for (let i = 0; i < active.length - 1; i++) {
      const prev = active[i], next = active[i + 1];
      const gap = toMin(next.startTime) - (toMin(prev.startTime) + n(prev.durationMin));
      const buf = n(prev.travelBufferMin);
      if (buf === 0 && gap >= 0) continue; // nothing worth flagging
      stripsBefore[next.id] = (gap < buf) ? stripHtml(true, gap, buf) : stripHtml(false, gap, buf);
    }

    let html = '<div class="list-card">';
    rows.forEach(r => {
      if (stripsBefore[r.id]) html += stripsBefore[r.id];
      html += rowHtml(r);
    });
    // Cross-midnight check: the last active booking here runs past midnight
    // (guaranteed by the renderBookings caller whenever nextDayFirst is set),
    // so compare its end against tomorrow's first booking on the same
    // continuous minutes-since-midnight timeline (+1440).
    if (nextDayFirst && active.length) {
      const last = active[active.length - 1];
      const lastEnd = toMin(last.startTime) + n(last.durationMin);
      const gap = (toMin(nextDayFirst.startTime) + 1440) - lastEnd;
      const buf = n(last.travelBufferMin);
      if (!(buf === 0 && gap >= 0)) {
        const ref = `tomorrow's "${nextDayFirst.title || 'booking'}"`;
        html += (gap < buf) ? stripHtml(true, gap, buf, ref) : stripHtml(false, gap, buf, ref);
      }
    }
    html += '</div>';
    return html;
  }

  function stripHtml(warn, gap, buf, refLabel) {
    const suffix = refLabel ? ` before ${refLabel}` : '';
    if (warn) {
      const msg = gap < 0
        ? (buf === 0 ? `⚠ Overlaps by ${-gap} min${suffix}` : `⚠ Overlaps by ${-gap} min${suffix} — need ${buf} min buffer`)
        : `⚠ Only ${gap} min${suffix} — need ${buf} min`;
      return `<div style="padding:7px 16px;font-size:11px;font-weight:700;color:var(--overdue);background:color-mix(in srgb,var(--overdue) 8%,var(--card));border-bottom:0.5px solid var(--border)">${esc(msg)}</div>`;
    }
    return `<div style="padding:6px 16px;font-size:11px;font-weight:600;color:var(--text3);border-bottom:0.5px solid var(--border)">${esc(gap + ' min free' + suffix)}</div>`;
  }

  function rowHtml(r) {
    const dim = (r.status === 'done' || r.status === 'cancelled');
    const start = toMin(r.startTime);
    const end = start + n(r.durationMin);
    const range = fmtMin(start) + '–' + fmtMin(end) + (end >= 1440 ? ' (+1d)' : '');
    const cust = customerName(r.customerId);
    const subParts = [];
    if (cust) subParts.push(esc(cust));
    if (r.location) subParts.push(esc(r.location));
    if (r.status === 'done') subParts.push('Done');
    if (r.status === 'cancelled') subParts.push('Cancelled');
    const titleStyle = dim ? ' style="text-decoration:line-through"' : '';
    return `<div class="list-row" data-bk="${r.id}" tabindex="0" role="button"${dim ? ' style="opacity:.55"' : ''}>
        <div class="list-icon" style="font-size:19px;color:var(--brand)">${CAL_SVG}</div>
        <div class="list-main">
          <div class="list-title"${titleStyle}>${esc(r.title || 'Booking')}</div>
          <div class="list-sub">${subParts.join(' · ')}</div>
        </div>
        <div class="list-right">
          <div class="list-amt tnum" style="font-size:14px">${esc(range)}</div>
          <div class="list-amt-sub tnum">${esc(n(r.durationMin) + ' min')}</div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  BOOKING FORM (create / edit)
  // ══════════════════════════════════════════════════════════════════════
  function openBookingForm(dateISO) {
    editing = null;
    const date = dateISO || selectedDate || todayISO();
    buildFormModal({
      title: 'New booking',
      customerId: '',
      bkTitle: '',
      date: date,
      startTime: '09:00',
      durationMin: 60,
      travelBufferMin: 0,
      location: '',
      notes: '',
      status: 'scheduled',
    }, false);
  }
  window.openBookingForm = openBookingForm;

  async function openBookingEdit(id) {
    const b = await dbGet(STORE, id);
    if (!b || b.uid !== uidNow()) { toast('Booking not found'); return; }
    editing = b;
    buildFormModal({
      title: 'Edit booking',
      customerId: b.customerId != null ? b.customerId : '',
      bkTitle: b.title || '',
      date: b.date || todayISO(),
      startTime: b.startTime || '09:00',
      durationMin: b.durationMin != null ? b.durationMin : 60,
      travelBufferMin: b.travelBufferMin != null ? b.travelBufferMin : 0,
      location: b.location || '',
      notes: b.notes || '',
      status: b.status || 'scheduled',
    }, true);
  }

  function buildFormModal(v, isEdit) {
    closeModal('bk-form-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'bk-form-modal';

    const custOpts = `<option value="">No client</option>` +
      (typeof customers !== 'undefined' ? customers : []).map(c =>
        `<option value="${c.id}"${String(c.id) === String(v.customerId) ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

    const statusOpts = ['scheduled', 'done', 'cancelled'].map(s =>
      `<option value="${s}"${s === v.status ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Booking form">
        <div class="modal-handle"></div>
        <div class="modal-title">${esc(v.title)}</div>
        <div class="form-body">
          <div class="field">
            <label for="bk-cust">Client</label>
            <select id="bk-cust">${custOpts}</select>
          </div>
          <div class="field">
            <label for="bk-title">Title</label>
            <input type="text" id="bk-title" value="${aesc(v.bkTitle)}" placeholder="e.g. Portrait shoot">
          </div>

          <div class="form-header">When</div>
          <div class="field">
            <label for="bk-date">Date</label>
            <input type="date" id="bk-date" value="${aesc(v.date)}">
          </div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="bk-start">Start time</label><input type="time" id="bk-start" value="${aesc(v.startTime)}"></div>
            <div class="field-half"><label for="bk-dur">Duration (min)</label><input type="number" id="bk-dur" class="tnum" inputmode="numeric" min="1" step="1" value="${aesc(v.durationMin)}"></div>
          </div>
          <div class="field">
            <label for="bk-buffer">Travel buffer after (min)</label>
            <input type="number" id="bk-buffer" class="tnum" inputmode="numeric" min="0" step="1" value="${aesc(v.travelBufferMin)}">
          </div>

          <div class="form-header">Details</div>
          <div class="field">
            <label for="bk-loc">Location</label>
            <input type="text" id="bk-loc" value="${aesc(v.location)}" placeholder="Address or place (optional)">
          </div>
          <div class="field">
            <label for="bk-status">Status</label>
            <select id="bk-status">${statusOpts}</select>
          </div>
          <div class="field">
            <label for="bk-notes">Notes</label>
            <textarea id="bk-notes" rows="2">${esc(v.notes)}</textarea>
          </div>
        </div>
        <button type="button" class="btn-submit" id="bk-save">${isEdit ? 'Save changes' : 'Create booking'}</button>
        ${isEdit ? `<button type="button" class="btn-danger" id="bk-del">Delete booking</button>` : ''}
        <button type="button" class="btn-danger" id="bk-cancel" style="border-color:var(--border-mid);color:var(--text3)">Cancel</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    overlay.querySelector('#bk-save').addEventListener('click', () => saveBooking(isEdit));
    overlay.querySelector('#bk-cancel').addEventListener('click', () => closeModal('bk-form-modal'));
    if (isEdit) overlay.querySelector('#bk-del').addEventListener('click', () => deleteBooking(editing.id));
  }

  async function saveBooking(isEdit) {
    document.querySelectorAll('#bk-form-modal .field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('#bk-form-modal .field-err').forEach(el => el.remove());

    const title = document.getElementById('bk-title').value.trim();
    const date = document.getElementById('bk-date').value;
    const startTime = document.getElementById('bk-start').value;
    const durationMin = Math.round(n(document.getElementById('bk-dur').value));
    const travelBufferMin = Math.max(0, Math.round(n(document.getElementById('bk-buffer').value)));

    let bad = false;
    if (!title) { markErr('bk-title', 'Enter a title for this booking'); bad = true; }
    if (!date) { markErr('bk-date', 'Pick a date'); bad = true; }
    if (!startTime) { markErr('bk-start', 'Pick a start time'); bad = true; }
    if (!(durationMin > 0)) { markErr('bk-dur', 'Duration must be at least 1 minute'); bad = true; }
    if (bad) return;

    const uid = uidNow();
    const custVal = document.getElementById('bk-cust').value;
    const base = {
      uid,
      customerId: custVal ? parseInt(custVal, 10) : null,
      title,
      date,
      startTime,
      durationMin,
      travelBufferMin,
      location: document.getElementById('bk-loc').value.trim(),
      notes: document.getElementById('bk-notes').value.trim(),
      status: document.getElementById('bk-status').value || 'scheduled',
      updatedAt: nowISO(),
    };

    try {
      if (isEdit) {
        base.id = editing.id;
        base.cuid = editing.cuid || cuid();
        base.createdAt = editing.createdAt || nowISO();
        await dbPut(STORE, base);
        toast('Booking updated');
      } else {
        base.cuid = cuid();
        base.createdAt = nowISO();
        await dbAdd(STORE, base);
        toast('Booking created');
      }
    } catch (err) {
      console.error(err);
      toast('Could not save booking');
      return;
    }
    // Follow the booking to its (possibly changed) day: expand that date's
    // panel and jump the grid to its month so the saved booking is visible.
    selectedDate = date;
    expandedDate = date;
    calMonth = date.slice(0, 7);
    closeModal('bk-form-modal');
    renderBookings();
  }

  function markErr(inputId, msg) {
    const input = document.getElementById(inputId);
    if (!input) { toast(msg); return; }
    const wrap = input.closest('.field, .field-half') || input.parentElement;
    wrap.classList.add('field-invalid');
    if (!wrap.querySelector('.field-err')) {
      const m = document.createElement('div');
      m.className = 'field-err';
      m.textContent = msg;
      wrap.appendChild(m);
    }
    input.addEventListener('input', function clr() {
      wrap.classList.remove('field-invalid');
      const e = wrap.querySelector('.field-err'); if (e) e.remove();
      input.removeEventListener('input', clr);
    });
  }

  async function deleteBooking(id) {
    if (!confirm('Delete this booking? This cannot be undone.')) return;
    try { await dbDel(STORE, id); } catch (e) { console.error(e); }
    closeModal('bk-form-modal');
    toast('Booking deleted');
    renderBookings();
  }

  function closeModal(idStr) {
    const el = document.getElementById(idStr);
    if (el) el.remove();
  }

})();
