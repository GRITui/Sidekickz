/* Freelanz — followups.js  (M3 FOLLOW-UP QUEUE / lightweight CRM)
 *
 * OWNED BY the CRM agent. Loaded AFTER app.js and invoices.js, so app.js
 * globals (dbAll, dbAdd, dbPut, cuid, nowISO, todayISO, htmlEsc, attrEsc,
 * toast, customers, jobs, currentUser, isGuest) are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderFollowups()   — fills #followups-body
 *
 * The queue itself is NEVER stored: it is recomputed live on every render from
 * customers / jobs / the READ-ONLY 'invoices' store. The 'followups' store
 * holds ONLY the user's snooze/dismiss decisions, matched back by a stable key.
 * English-only, light-mode.
 */
'use strict';

(function () {

  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'followups';
  const DRAFT_STALE_DAYS = 3;
  const CUSTOMER_STALE_DAYS = 30;

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }

  function addDays(iso, days) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function daysBetween(fromISO, toISO) {
    const a = new Date(fromISO + 'T12:00:00'), b = new Date(toISO + 'T12:00:00');
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.round((b - a) / 86400000);
  }

  let queue = [];   // live candidates surviving snooze/dismiss, in render order

  async function buildQueue() {
    const uid = uidNow();
    const today = todayISO();
    const invoices = (await dbAll('invoices')).filter(r => r.uid === uid);
    const custList = (typeof customers !== 'undefined' ? customers : []);
    const jobList = (typeof jobs !== 'undefined' ? jobs : []);
    const custById = new Map(custList.map(c => [String(c.id), c]));

    const candidates = [];

    // 1. Overdue invoices, 2. Unsent drafts.
    invoices.forEach(inv => {
      const cid = inv.clientId != null && inv.clientId !== '' ? String(inv.clientId) : '';
      const cust = cid ? custById.get(cid) : null;
      const name = (cust && cust.name) || inv.clientName || 'No client';

      if (inv.status !== 'paid' && inv.dueDate && inv.dueDate < today) {
        const n = daysBetween(inv.dueDate, today);
        candidates.push({
          group: 0, sortN: n, icon: '🧾', title: name,
          reason: `Invoice ${inv.number || ''} is ${n} day${n === 1 ? '' : 's'} overdue`,
          key: `overdue:${cid}:${inv.id}`,
        });
      } else if (inv.status === 'draft' && inv.issueDate && daysBetween(inv.issueDate, today) >= DRAFT_STALE_DAYS) {
        const n = daysBetween(inv.issueDate, today);
        candidates.push({
          group: 1, sortN: n, icon: '🧾', title: name,
          reason: `Draft invoice ${inv.number || ''} has been sitting unsent for ${n} day${n === 1 ? '' : 's'}`,
          key: `draft:${cid}:${inv.id}`,
        });
      }
    });

    // 3. Stale customers — only those with prior job/invoice history.
    custList.forEach(c => {
      const dates = [];
      jobList.forEach(j => { if (j.clientId === c.id && j.date) dates.push(j.date); });
      invoices.forEach(inv => {
        if (inv.clientId != null && String(inv.clientId) === String(c.id) && inv.issueDate) dates.push(inv.issueDate);
      });
      if (!dates.length) return;   // nothing to be stale about yet
      const last = dates.reduce((mx, d) => (d > mx ? d : mx), dates[0]);
      const n = daysBetween(last, today);
      if (n > CUSTOMER_STALE_DAYS) {
        candidates.push({
          group: 2, sortN: n, icon: '👤', title: c.name || 'Customer',
          reason: `No activity with ${c.name || 'this customer'} in ${n} days`,
          key: `stale:${c.id}:`,
        });
      }
    });

    // Apply snooze/dismiss decisions.
    const decisions = new Map();
    (await dbAll(STORE)).filter(r => r.uid === uid).forEach(r => decisions.set(r.key, r));
    const surviving = candidates.filter(cand => {
      const rec = decisions.get(cand.key);
      if (!rec) return true;
      if (rec.dismissed === true) return false;
      if (rec.snoozedUntil && rec.snoozedUntil >= today) return false;
      return true;
    });

    surviving.sort((a, b) => (a.group - b.group) || (b.sortN - a.sortN));
    return surviving;
  }

  async function applyDecision(key, patch) {
    const uid = uidNow();
    const existing = (await dbAll(STORE)).filter(r => r.uid === uid).find(r => r.key === key);
    if (existing) {
      Object.assign(existing, patch, { updatedAt: nowISO() });
      await dbPut(STORE, existing);
    } else {
      await dbAdd(STORE, {
        uid, key, dismissed: false, snoozedUntil: '',
        createdAt: nowISO(), updatedAt: nowISO(),
        ...patch,
      });
    }
  }

  async function snooze(key) {
    try { await applyDecision(key, { snoozedUntil: addDays(todayISO(), 7), dismissed: false }); }
    catch (e) { console.error(e); toast('Could not snooze'); return; }
    toast('Snoozed for 7 days');
    renderFollowups();
  }
  async function dismiss(key) {
    try { await applyDecision(key, { dismissed: true }); }
    catch (e) { console.error(e); toast('Could not dismiss'); return; }
    toast('Dismissed');
    renderFollowups();
  }

  async function renderFollowups() {
    const el = document.getElementById('followups-body');
    if (!el) return;
    queue = await buildQueue();

    if (!queue.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">✅</div>
        <p>You're all caught up</p></div>`;
      return;
    }

    el.innerHTML = '<div class="list-card">' + queue.map((it, i) => `
      <div class="list-row" style="cursor:default">
        <div class="list-icon">${it.icon}</div>
        <div class="list-main">
          <div class="list-title">${esc(it.title)}</div>
          <div class="list-sub">${esc(it.reason)}</div>
        </div>
        <div class="list-right" style="display:flex;gap:6px">
          <button type="button" data-fu-snooze="${i}" style="padding:7px 9px;border:1px solid var(--border);background:var(--card);color:var(--text3);border-radius:var(--radius-sm);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">Snooze 7d</button>
          <button type="button" data-fu-dismiss="${i}" style="padding:7px 9px;border:1px solid var(--overdue);background:none;color:var(--overdue);border-radius:var(--radius-sm);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">Dismiss</button>
        </div>
      </div>`).join('') + '</div>';

    el.querySelectorAll('[data-fu-snooze]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = queue[parseInt(btn.getAttribute('data-fu-snooze'), 10)];
        if (it) snooze(it.key);
      });
    });
    el.querySelectorAll('[data-fu-dismiss]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = queue[parseInt(btn.getAttribute('data-fu-dismiss'), 10)];
        if (it) dismiss(it.key);
      });
    });
  }
  window.renderFollowups = renderFollowups;

})();
