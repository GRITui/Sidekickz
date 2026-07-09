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
  //  DAY VIEW  →  #book-body
  // ══════════════════════════════════════════════════════════════════════
  let selectedDate = todayISO();   // module-closure state — nav re-renders this day only
  let editing = null;              // full record being edited, or null on create

  async function renderBookings() {
    const el = document.getElementById('book-body');
    if (!el) return;
    if (!selectedDate) selectedDate = todayISO();
    const rows = await loadBookings(selectedDate);

    const nav = `<div style="display:flex;align-items:center;gap:8px;background:var(--card);border:0.5px solid var(--border);border-radius:var(--radius-sm);padding:6px;margin:0 0 14px">
        <button type="button" id="bk-prev" aria-label="Previous day" style="flex:0 0 auto;width:40px;padding:10px 0;border:none;background:var(--brand-tint);color:var(--brand);border-radius:9px;font-size:18px;font-weight:800;font-family:inherit;cursor:pointer">‹</button>
        <button type="button" id="bk-today" style="flex:1;padding:8px;border:none;background:none;color:var(--text);border-radius:9px;font-family:inherit;cursor:pointer;text-align:center">
          <div style="font-size:14px;font-weight:800">${esc(dayLabel(selectedDate))}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">${selectedDate === todayISO() ? 'Tap ‹ › to change day' : 'Tap to jump to today'}</div>
        </button>
        <button type="button" id="bk-next" aria-label="Next day" style="flex:0 0 auto;width:40px;padding:10px 0;border:none;background:var(--brand-tint);color:var(--brand);border-radius:9px;font-size:18px;font-weight:800;font-family:inherit;cursor:pointer">›</button>
      </div>`;

    const btn = `<button type="button" id="bk-new-btn" class="btn-submit" style="width:100%;margin:0 0 16px">+ New booking</button>`;

    let content;
    if (!rows.length) {
      content = `<div class="empty"><div class="empty-icon">📅</div>
           <p>No bookings for this day</p>
           <span>Tap “+ New booking” to schedule work — set a duration and a travel buffer so back-to-back jobs stay realistic.</span>
         </div>`;
    } else {
      content = buildDayList(rows);
    }

    el.innerHTML = nav + btn + content;

    document.getElementById('bk-prev').addEventListener('click', () => { selectedDate = addDays(selectedDate, -1); renderBookings(); });
    document.getElementById('bk-next').addEventListener('click', () => { selectedDate = addDays(selectedDate, 1); renderBookings(); });
    document.getElementById('bk-today').addEventListener('click', () => { selectedDate = todayISO(); renderBookings(); });
    document.getElementById('bk-new-btn').addEventListener('click', () => openBookingForm(selectedDate));

    el.querySelectorAll('[data-bk]').forEach(row => {
      const open = () => openBookingEdit(parseInt(row.getAttribute('data-bk'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }
  window.renderBookings = renderBookings;

  function buildDayList(rows) {
    // Buffer gaps are computed only between non-cancelled bookings; cancelled
    // ones still render (de-emphasized) but never contribute to a gap.
    const active = rows.filter(r => r.status !== 'cancelled');
    const strips = {}; // prevBookingId -> strip HTML rendered after that row
    for (let i = 0; i < active.length - 1; i++) {
      const prev = active[i], next = active[i + 1];
      const gap = toMin(next.startTime) - (toMin(prev.startTime) + n(prev.durationMin));
      const buf = n(prev.travelBufferMin);
      if (buf === 0 && gap >= 0) continue; // nothing worth flagging
      strips[prev.id] = (gap < buf) ? stripHtml(true, gap, buf) : stripHtml(false, gap, buf);
    }

    let html = '<div class="list-card">';
    rows.forEach(r => {
      html += rowHtml(r);
      if (strips[r.id]) html += strips[r.id];
    });
    html += '</div>';
    return html;
  }

  function stripHtml(warn, gap, buf) {
    if (warn) {
      const msg = gap < 0
        ? `⚠ Overlaps by ${-gap} min — need ${buf} min buffer`
        : `⚠ Only ${gap} min — need ${buf} min`;
      return `<div style="padding:7px 16px;font-size:11px;font-weight:700;color:var(--overdue);background:color-mix(in srgb,var(--overdue) 8%,var(--card));border-bottom:0.5px solid var(--border)">${esc(msg)}</div>`;
    }
    return `<div style="padding:6px 16px;font-size:11px;font-weight:600;color:var(--text3);border-bottom:0.5px solid var(--border)">${esc(gap + ' min free')}</div>`;
  }

  function rowHtml(r) {
    const dim = (r.status === 'done' || r.status === 'cancelled');
    const start = toMin(r.startTime);
    const range = fmtMin(start) + '–' + fmtMin(start + n(r.durationMin));
    const cust = customerName(r.customerId);
    const subParts = [];
    if (cust) subParts.push(esc(cust));
    if (r.location) subParts.push(esc(r.location));
    if (r.status === 'done') subParts.push('Done');
    if (r.status === 'cancelled') subParts.push('Cancelled');
    const titleStyle = dim ? ' style="text-decoration:line-through"' : '';
    return `<div class="list-row" data-bk="${r.id}" tabindex="0" role="button"${dim ? ' style="opacity:.55"' : ''}>
        <div class="list-icon">📅</div>
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
    selectedDate = date; // follow the booking to its (possibly changed) day
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
