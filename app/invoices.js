/* Freelanz — invoices.js  (M2 INVOICING + PromptPay)
 *
 * OWNED BY the invoicing agent. Replaces the stub entirely.
 * Loaded AFTER app.js and tax.js, so app.js globals (dbAll, dbAdd, dbPut,
 * dbDel, cuid, nowISO, todayISO, money, fmt, curSym, htmlEsc, attrEsc, toast,
 * switchScreen, settings, customers, services, jobs, currentUser, isGuest) and
 * window.computeTax are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderInvoices()          — fills #invoices-body
 *   - openInvoiceForm(fromJobId?, prefillQuote?) — create/edit invoice UI.
 *     prefillQuote (from docgen.js's Quote → Invoice conversion) is
 *     {clientId, clientName, lineItems} and takes priority over fromJobId.
 *
 * Everything below is self-contained: EMVCo PromptPay payload builder,
 * CRC16-CCITT-FALSE, and a byte-mode QR encoder (Nayuki-style, reference
 * algorithm) — no CDN, no network, no external libraries. English-only,
 * light-mode, THB via money()/curSym().
 */
'use strict';

(function () {

  // ══════════════════════════════════════════════════════════════════════
  //  Small local helpers
  // ══════════════════════════════════════════════════════════════════════
  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'invoices';

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }
  function n(v) { const x = parseFloat(v); return isFinite(x) ? x : 0; }
  function addDays(iso, days) {
    const d = new Date((iso || todayISO()) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function money2(v) { return money(v, 2); }

  async function loadInvoices() {
    const uid = uidNow();
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid);
    rows.sort((a, b) => {
      const d = String(b.issueDate || '').localeCompare(String(a.issueDate || ''));
      if (d !== 0) return d;
      return String(b.number || '').localeCompare(String(a.number || ''));
    });
    return rows;
  }

  // Shared with docgen.js's quote/receipt numbering — see app.js's nextDocNumber().
  function nextNumber(rows) { return nextDocNumber(rows, 'INV'); }

  function statusChip(status) {
    const map = {
      paid: ['chip-paid', 'Paid'],
      overdue: ['chip-overdue', 'Overdue'],
      sent: ['chip-due', 'Sent'],
      draft: ['', 'Draft'],
    };
    const [cls, label] = map[status] || map.draft;
    if (!cls) {
      return `<span class="chip" style="background:var(--border);color:var(--text3)">${label}</span>`;
    }
    return `<span class="chip ${cls}">${label}</span>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  LIST SCREEN  →  #invoices-body
  // ══════════════════════════════════════════════════════════════════════
  async function renderInvoices() {
    const el = document.getElementById('invoices-body');
    if (!el) return;
    const rows = await loadInvoices();

    const btn = `<button type="button" id="inv-new-btn" class="btn-submit" style="width:100%;margin:0 0 16px">+ New invoice</button>`;

    if (!rows.length) {
      el.innerHTML = btn +
        `<div class="empty"><div class="empty-icon">🧾</div>
           <p>No invoices yet</p>
           <span>Create your first invoice — add line items, snapshot tax, and share a PromptPay QR.</span>
         </div>`;
      document.getElementById('inv-new-btn').addEventListener('click', () => openInvoiceForm());
      return;
    }

    // Outstanding total (client-pays for non-paid invoices)
    let outstanding = 0;
    rows.forEach(r => { if (r.status !== 'paid') outstanding += n(r.clientPays); });

    const summary = `<div style="background:var(--card);border:0.5px solid var(--border);border-radius:var(--radius-sm);padding:14px 16px;margin:0 0 14px">
        <div style="font-size:11px;font-weight:600;color:var(--text3)">Outstanding</div>
        <div class="tnum" style="font-size:22px;font-weight:800;color:var(--text)">${esc(money2(outstanding))}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${rows.length} invoice${rows.length === 1 ? '' : 's'}</div>
      </div>`;

    const list = '<div class="list-card">' + rows.map(r => {
      const sub = [esc(r.clientName || 'No client'), esc(fmtInvDate(r.issueDate))].filter(Boolean).join(' · ');
      return `<div class="list-row" data-inv="${r.id}" tabindex="0" role="button">
        <div class="list-icon">🧾</div>
        <div class="list-main">
          <div class="list-title">${esc(r.number || 'Invoice')}</div>
          <div class="list-sub">${sub}</div>
        </div>
        <div class="list-right">
          <div class="list-amt tnum">${esc(money2(r.clientPays))}</div>
          <div class="list-amt-sub" style="margin-top:3px">${statusChip(r.status)}</div>
        </div>
      </div>`;
    }).join('') + '</div>';

    el.innerHTML = btn + summary + list;
    document.getElementById('inv-new-btn').addEventListener('click', () => openInvoiceForm());
    el.querySelectorAll('[data-inv]').forEach(row => {
      const open = () => openInvoiceDetail(parseInt(row.getAttribute('data-inv'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }
  window.renderInvoices = renderInvoices;

  function fmtInvDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  INVOICE FORM (create / edit)
  // ══════════════════════════════════════════════════════════════════════
  let lines = [];        // working line items: {description, qty, unitPrice}
  let editing = null;    // full record being edited, or null on create
  let formFromJobId = null; // pipeline session this form was opened from (for engagement linking)

  function openInvoiceForm(fromJobId, prefillQuote) {
    editing = null;
    lines = [];
    formFromJobId = (fromJobId != null) ? fromJobId : null;

    let preClientId = '', preClientName = '';
    if (prefillQuote) {
      // Prefill from an accepted Quote document (docgen.js) — every quote
      // line item carries over as its own invoice line.
      preClientId = prefillQuote.clientId != null ? prefillQuote.clientId : '';
      preClientName = prefillQuote.clientName || '';
      (prefillQuote.lineItems || []).forEach(li => {
        lines.push({ description: li.description || '', qty: n(li.qty) || 1, unitPrice: n(li.unitPrice) });
      });
    } else if (fromJobId != null) {
      // Prefill from a job if requested
      const j = (typeof jobs !== 'undefined' ? jobs : []).find(x => x.id === fromJobId);
      if (j) {
        preClientName = j.client || '';
        if (j.clientId != null) preClientId = j.clientId;
        lines.push({
          description: j.serviceName || 'Service',
          qty: Math.max(1, n(j.count) || 1),
          unitPrice: n(j.amount),
        });
      }
    }
    if (!lines.length) lines.push({ description: '', qty: 1, unitPrice: 0 });

    buildFormModal({
      title: 'New invoice',
      number: '(assigned on save)',
      clientId: preClientId,
      clientName: preClientName,
      clientTaxId: '',
      clientAddress: '',
      issueDate: todayISO(),
      dueDate: addDays(todayISO(), 7),
      whtPct: settingsDefault('wht', 3),
      vatPct: settingsDefault('vat', 7),
      depositPct: 0,
      status: 'draft',
      notes: '',
    }, false);
  }
  window.openInvoiceForm = openInvoiceForm;

  function openInvoiceEdit(inv) {
    editing = inv;
    formFromJobId = null;
    lines = (inv.lineItems && inv.lineItems.length)
      ? inv.lineItems.map(li => ({ description: li.description || '', qty: n(li.qty), unitPrice: n(li.unitPrice) }))
      : [{ description: '', qty: 1, unitPrice: 0 }];
    buildFormModal({
      title: 'Edit invoice',
      number: inv.number || '',
      clientId: inv.clientId != null ? inv.clientId : '',
      clientName: inv.clientName || '',
      clientTaxId: inv.clientTaxId || '',
      clientAddress: inv.clientAddress || '',
      issueDate: inv.issueDate || todayISO(),
      dueDate: inv.dueDate || addDays(todayISO(), 7),
      whtPct: inv.whtPct != null ? inv.whtPct : settingsDefault('wht', 3),
      vatPct: inv.vatPct != null ? inv.vatPct : settingsDefault('vat', 7),
      depositPct: inv.depositPct != null ? inv.depositPct : 0,
      status: inv.status || 'draft',
      notes: inv.notes || '',
    }, true);
  }

  function settingsDefault(key, fallback) {
    const v = (typeof settings !== 'undefined' && settings) ? settings[key] : undefined;
    return (v == null || v === '') ? fallback : v;
  }

  function buildFormModal(v, isEdit) {
    closeModal('inv-form-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'inv-form-modal';

    const custOpts = `<option value="">— Free text —</option>` +
      (typeof customers !== 'undefined' ? customers : []).map(c =>
        `<option value="${c.id}"${String(c.id) === String(v.clientId) ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

    const svcOpts = `<option value="">+ Add line from service…</option>` +
      (typeof services !== 'undefined' ? services : []).map(s =>
        `<option value="${s.id}">${esc(s.name)} · ${esc(money(s.rate))}</option>`).join('');

    const statusOpts = ['draft', 'sent', 'paid', 'overdue'].map(s =>
      `<option value="${s}"${s === v.status ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Invoice form">
        <div class="modal-handle"></div>
        <div class="modal-title">${esc(v.title)} <span style="font-size:12px;font-weight:600;color:var(--text3)">${esc(v.number)}</span></div>
        <div class="form-body">
          <div class="form-header">Client</div>
          <div class="field">
            <label for="inv-cust">Pick a client</label>
            <select id="inv-cust">${custOpts}</select>
          </div>
          <div class="field">
            <label for="inv-cname">Bill to (name)</label>
            <input type="text" id="inv-cname" value="${aesc(v.clientName)}" placeholder="Client or company name">
          </div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="inv-ctax">Tax ID</label><input type="text" id="inv-ctax" value="${aesc(v.clientTaxId)}"></div>
            <div class="field-half"><label for="inv-caddr">Address</label><input type="text" id="inv-caddr" value="${aesc(v.clientAddress)}"></div>
          </div>

          <div class="form-header">Dates &amp; status</div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="inv-issue">Issue date</label><input type="date" id="inv-issue" value="${aesc(v.issueDate)}"></div>
            <div class="field-half"><label for="inv-due">Due date</label><input type="date" id="inv-due" value="${aesc(v.dueDate)}"></div>
          </div>
          <div class="field">
            <label for="inv-status">Status</label>
            <select id="inv-status">${statusOpts}</select>
          </div>

          <div class="form-header">Line items</div>
          <div id="inv-lines"></div>
          <div class="field">
            <label for="inv-svc">Add from service</label>
            <select id="inv-svc">${svcOpts}</select>
          </div>
          <div style="padding:10px 16px">
            <button type="button" id="inv-add-line" style="width:100%;padding:11px;background:var(--brand-tint);color:var(--brand);border:none;border-radius:9px;font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">+ Add blank line</button>
          </div>

          <div class="form-header">Tax &amp; deposit</div>
          <div class="field-row" style="display:flex">
            <div class="field-half"><label for="inv-vat">VAT %</label><input type="number" id="inv-vat" class="tnum" inputmode="decimal" min="0" step="0.01" value="${aesc(v.vatPct)}"></div>
            <div class="field-half"><label for="inv-wht">WHT %</label><input type="number" id="inv-wht" class="tnum" inputmode="decimal" min="0" step="0.01" value="${aesc(v.whtPct)}"></div>
          </div>
          <div class="field">
            <label for="inv-deposit">Deposit % (upfront, optional)</label>
            <input type="number" id="inv-deposit" class="tnum" inputmode="decimal" min="0" max="100" step="1" value="${aesc(v.depositPct)}">
          </div>

          <div class="form-header">Notes</div>
          <div class="field">
            <label for="inv-notes">Notes (shown on the invoice)</label>
            <textarea id="inv-notes" rows="2">${esc(v.notes)}</textarea>
          </div>

          <div id="inv-totals" style="margin:8px 16px 4px;background:var(--brand-tint);border-radius:var(--radius-sm);padding:14px 16px"></div>
        </div>
        <button type="button" class="btn-submit" id="inv-save">${isEdit ? 'Save changes' : 'Create invoice'}</button>
        ${isEdit ? `<button type="button" class="btn-danger" id="inv-del">Delete invoice</button>` : ''}
        <button type="button" class="btn-danger" id="inv-cancel" style="border-color:var(--border-mid);color:var(--text3)">Cancel</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    // Wire controls
    overlay.querySelector('#inv-cust').addEventListener('change', onCustChange);
    overlay.querySelector('#inv-svc').addEventListener('change', onSvcChange);
    overlay.querySelector('#inv-add-line').addEventListener('click', () => {
      lines.push({ description: '', qty: 1, unitPrice: 0 });
      renderLineRows(); recalcTotals();
    });
    overlay.querySelector('#inv-save').addEventListener('click', () => saveInvoice(isEdit));
    overlay.querySelector('#inv-cancel').addEventListener('click', () => closeModal('inv-form-modal'));
    if (isEdit) overlay.querySelector('#inv-del').addEventListener('click', () => deleteInvoice(editing.id));
    ['inv-vat', 'inv-wht', 'inv-deposit'].forEach(id => {
      overlay.querySelector('#' + id).addEventListener('input', recalcTotals);
    });

    renderLineRows();
    recalcTotals();
  }

  function onCustChange(e) {
    const id = e.target.value;
    if (!id) return;
    const c = (typeof customers !== 'undefined' ? customers : []).find(x => String(x.id) === String(id));
    if (!c) return;
    const set = (sel, val) => { const el = document.querySelector(sel); if (el) el.value = val || ''; };
    set('#inv-cname', c.name);
    set('#inv-ctax', c.taxId);
    set('#inv-caddr', c.billingAddress);
  }

  function onSvcChange(e) {
    const id = e.target.value;
    if (!id) return;
    const s = (typeof services !== 'undefined' ? services : []).find(x => String(x.id) === String(id));
    if (s) {
      lines.push({ description: s.name || '', qty: 1, unitPrice: n(s.rate) });
      renderLineRows(); recalcTotals();
    }
    e.target.value = '';
  }

  function renderLineRows() {
    const wrap = document.getElementById('inv-lines');
    if (!wrap) return;
    if (!document.getElementById('inv-focus-style')) {
      const fs = document.createElement('style');
      fs.id = 'inv-focus-style';
      fs.textContent = '#inv-form-modal input:focus-visible,#inv-form-modal select:focus-visible,#inv-form-modal textarea:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand)}';
      document.head.appendChild(fs);
    }
    wrap.innerHTML = lines.map((li, i) => {
      const amt = n(li.qty) * n(li.unitPrice);
      return `<div class="inv-line" data-i="${i}" style="border-bottom:0.5px solid var(--border);padding:10px 16px">
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input type="text" data-f="description" placeholder="Description" value="${aesc(li.description)}"
            style="flex:1;border:none;outline:none;background:transparent;font-size:15px;color:var(--text);font-family:inherit;padding:4px 0">
          <button type="button" data-rm="${i}" aria-label="Remove line"
            style="border:none;background:none;color:var(--overdue);font-size:20px;line-height:1;cursor:pointer;padding:2px 4px">×</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:4px">
          <label style="font-size:11px;color:var(--text3);font-weight:700">Qty</label>
          <input type="number" data-f="qty" aria-label="Quantity" class="tnum" inputmode="decimal" min="0" step="any" value="${aesc(li.qty)}"
            style="width:64px;border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:14px;background:var(--card);color:var(--text);outline:none">
          <label style="font-size:11px;color:var(--text3);font-weight:700">Rate</label>
          <input type="number" data-f="unitPrice" aria-label="Unit price" class="tnum" inputmode="decimal" min="0" step="any" value="${aesc(li.unitPrice)}"
            style="width:96px;border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:14px;background:var(--card);color:var(--text);outline:none">
          <div class="tnum" data-amt="${i}" style="margin-left:auto;font-weight:800;color:var(--text);font-size:14px">${esc(money2(amt))}</div>
        </div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('.inv-line').forEach(rowEl => {
      const i = parseInt(rowEl.getAttribute('data-i'), 10);
      rowEl.querySelectorAll('[data-f]').forEach(input => {
        input.addEventListener('input', () => {
          const f = input.getAttribute('data-f');
          lines[i][f] = (f === 'description') ? input.value : n(input.value);
          const amtEl = wrap.querySelector(`[data-amt="${i}"]`);
          if (amtEl) amtEl.textContent = money2(n(lines[i].qty) * n(lines[i].unitPrice));
          recalcTotals();
        });
      });
      const rm = rowEl.querySelector('[data-rm]');
      if (rm) rm.addEventListener('click', () => {
        lines.splice(i, 1);
        if (!lines.length) lines.push({ description: '', qty: 1, unitPrice: 0 });
        renderLineRows(); recalcTotals();
      });
    });
  }

  function currentSubtotal() {
    return lines.reduce((s, li) => s + n(li.qty) * n(li.unitPrice), 0);
  }

  function recalcTotals() {
    const box = document.getElementById('inv-totals');
    if (!box) return;
    const subtotal = currentSubtotal();
    const vatPct = n(document.getElementById('inv-vat').value);
    const whtPct = n(document.getElementById('inv-wht').value);
    const depositPct = n(document.getElementById('inv-deposit').value);
    const t = window.computeTax(subtotal, whtPct, vatPct);
    const deposit = t.clientPays * (depositPct / 100);
    const row = (label, val, strong) =>
      `<div style="display:flex;justify-content:space-between;margin:3px 0;${strong ? 'font-weight:800;font-size:15px;color:var(--brand)' : 'font-size:13px;color:var(--text2)'}">
        <span>${label}</span><span class="tnum">${esc(val)}</span></div>`;
    box.innerHTML =
      row('Subtotal', money2(subtotal)) +
      row(`VAT (${fmt(vatPct, 2)}%)`, '+ ' + money2(t.vat)) +
      row(`WHT (${fmt(whtPct, 2)}%)`, '- ' + money2(t.wht)) +
      `<div style="border-top:1px solid var(--border-mid);margin:6px 0"></div>` +
      row('Client pays', money2(t.clientPays), true) +
      row('You receive', money2(t.youReceive)) +
      (depositPct > 0 ? row(`Deposit (${fmt(depositPct, 0)}%)`, money2(deposit)) : '');
  }

  async function saveInvoice(isEdit) {
    // Validation
    document.querySelectorAll('#inv-form-modal .field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('#inv-form-modal .field-err').forEach(el => el.remove());

    const clientName = document.getElementById('inv-cname').value.trim();
    const cleanLines = lines
      .map(li => ({ description: (li.description || '').trim(), qty: n(li.qty), unitPrice: n(li.unitPrice) }))
      .filter(li => li.description || li.qty * li.unitPrice > 0);

    let bad = false;
    if (!clientName) { markErr('inv-cname', 'Enter who this invoice is billed to'); bad = true; }
    if (!cleanLines.length) { toast('Add at least one line item'); bad = true; }
    else if (currentSubtotal() <= 0) { toast('Invoice total must be greater than zero'); bad = true; }
    if (bad) return;

    const uid = uidNow();
    const subtotal = cleanLines.reduce((s, li) => s + li.qty * li.unitPrice, 0);
    const vatPct = n(document.getElementById('inv-vat').value);
    const whtPct = n(document.getElementById('inv-wht').value);
    const depositPct = n(document.getElementById('inv-deposit').value);
    const tax = window.computeTax(subtotal, whtPct, vatPct);
    const custId = document.getElementById('inv-cust').value;

    const base = {
      uid,
      number: isEdit ? editing.number : nextNumber(await loadInvoices()),
      issueDate: document.getElementById('inv-issue').value || todayISO(),
      dueDate: document.getElementById('inv-due').value || '',
      clientId: custId ? (isNaN(parseInt(custId, 10)) ? custId : parseInt(custId, 10)) : null,
      clientName,
      clientTaxId: document.getElementById('inv-ctax').value.trim(),
      clientAddress: document.getElementById('inv-caddr').value.trim(),
      lineItems: cleanLines,
      subtotal,
      whtPct, vatPct,
      vat: tax.vat, wht: tax.wht, clientPays: tax.clientPays, youReceive: tax.youReceive,
      depositPct,
      status: document.getElementById('inv-status').value || 'draft',
      promptpayId: (typeof settings !== 'undefined' && settings && settings.promptpayId) ? settings.promptpayId : '',
      notes: document.getElementById('inv-notes').value.trim(),
      updatedAt: nowISO(),
    };

    try {
      if (isEdit) {
        base.id = editing.id;
        base.cuid = editing.cuid || cuid();
        if (editing.promptpayId) base.promptpayId = editing.promptpayId; // preserve issue-time snapshot
        await dbPut(STORE, base);
        toast('Invoice updated');
      } else {
        base.cuid = cuid();
        const newId = await dbAdd(STORE, base);
        base.id = newId;
        toast('Invoice ' + base.number + ' created');
        // Engagement linking: let app.js link invoiceId onto the session + advance.
        if (formFromJobId != null && typeof window.onEngagementInvoiceCreated === 'function') {
          try { window.onEngagementInvoiceCreated(newId, formFromJobId); } catch (e) { /* non-fatal */ }
        }
        formFromJobId = null;
      }
    } catch (err) {
      console.error(err);
      toast('Could not save invoice');
      return;
    }
    closeModal('inv-form-modal');
    renderInvoices();
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

  async function deleteInvoice(id) {
    if (!confirm('Delete this invoice? This cannot be undone.')) return;
    try { await dbDel(STORE, id); } catch (e) { console.error(e); }
    closeModal('inv-form-modal');
    closeModal('inv-detail-modal');
    toast('Invoice deleted');
    renderInvoices();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  INVOICE DETAIL (view + QR + print + actions)
  // ══════════════════════════════════════════════════════════════════════
  async function openInvoiceDetail(id) {
    const inv = await dbGet(STORE, id);
    if (!inv || inv.uid !== uidNow()) { toast('Invoice not found'); return; }

    closeModal('inv-detail-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'inv-detail-modal';

    const linesHtml = (inv.lineItems || []).map(li =>
      `<tr>
        <td style="padding:6px 0;color:var(--text2)">${esc(li.description || '—')}</td>
        <td class="tnum" style="padding:6px 8px;text-align:right;color:var(--text3)">${esc(fmt(n(li.qty), n(li.qty) % 1 ? 2 : 0))} × ${esc(money2(n(li.unitPrice)))}</td>
        <td class="tnum" style="padding:6px 0;text-align:right;font-weight:700">${esc(money2(n(li.qty) * n(li.unitPrice)))}</td>
      </tr>`).join('');

    const deposit = n(inv.clientPays) * (n(inv.depositPct) / 100);
    const trow = (label, val, strong) =>
      `<div style="display:flex;justify-content:space-between;margin:3px 0;${strong ? 'font-weight:800;color:var(--brand);font-size:15px' : 'font-size:13px;color:var(--text2)'}">
        <span>${label}</span><span class="tnum">${esc(val)}</span></div>`;

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Invoice detail">
        <div class="modal-handle"></div>
        <div class="modal-title" style="display:flex;align-items:center;gap:10px">
          ${esc(inv.number || 'Invoice')} ${statusChip(inv.status)}
        </div>
        <div style="padding:0 20px 8px">
          <div style="font-size:14px;font-weight:700;color:var(--text)">${esc(inv.clientName || 'No client')}</div>
          ${inv.clientAddress ? `<div style="font-size:12px;color:var(--text3)">${esc(inv.clientAddress)}</div>` : ''}
          ${inv.clientTaxId ? `<div style="font-size:12px;color:var(--text3)">Tax ID: ${esc(inv.clientTaxId)}</div>` : ''}
          <div style="font-size:12px;color:var(--text3);margin-top:4px">
            Issued ${esc(fmtInvDate(inv.issueDate))}${inv.dueDate ? ' · Due ' + esc(fmtInvDate(inv.dueDate)) : ''}
          </div>
        </div>
        <div style="padding:0 20px 8px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">${linesHtml}</table>
        </div>
        <div style="margin:6px 20px 10px;background:var(--brand-tint);border-radius:var(--radius-sm);padding:14px 16px">
          ${trow('Subtotal', money2(inv.subtotal))}
          ${trow(`VAT (${fmt(n(inv.vatPct), 2)}%)`, '+ ' + money2(inv.vat))}
          ${trow(`WHT (${fmt(n(inv.whtPct), 2)}%)`, '- ' + money2(inv.wht))}
          <div style="border-top:1px solid var(--border-mid);margin:6px 0"></div>
          ${trow('Client pays', money2(inv.clientPays), true)}
          ${trow('You receive', money2(inv.youReceive))}
          ${n(inv.depositPct) > 0 ? trow(`Deposit (${fmt(n(inv.depositPct), 0)}%)`, money2(deposit)) : ''}
        </div>
        ${inv.notes ? `<div style="padding:0 20px 8px;font-size:12px;color:var(--text3)">${esc(inv.notes)}</div>` : ''}

        <div id="inv-qr-wrap" style="padding:6px 20px 10px;text-align:center"></div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 16px 10px">
          <button type="button" id="inv-d-edit" style="padding:13px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">Edit</button>
          <button type="button" id="inv-d-print" style="padding:13px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">Print / PDF</button>
        </div>
        <div style="padding:0 16px 4px">
          <label for="inv-d-status" style="display:block;font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px">Change status</label>
          <select id="inv-d-status" style="width:100%;padding:11px;border:1px solid var(--border);border-radius:9px;font-family:inherit;font-size:14px;background:var(--card);color:var(--text)">
            ${['draft', 'sent', 'paid', 'overdue'].map(s => `<option value="${s}"${s === inv.status ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn-danger" id="inv-d-close" style="border-color:var(--border-mid);color:var(--text3);margin-top:12px">Close</button>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.add('open');

    // PromptPay QR
    renderPromptPayInto(document.getElementById('inv-qr-wrap'), inv);

    overlay.querySelector('#inv-d-edit').addEventListener('click', () => { closeModal('inv-detail-modal'); openInvoiceEdit(inv); });
    overlay.querySelector('#inv-d-print').addEventListener('click', () => printInvoice(inv));
    overlay.querySelector('#inv-d-close').addEventListener('click', () => closeModal('inv-detail-modal'));
    overlay.querySelector('#inv-d-status').addEventListener('change', async (e) => {
      inv.status = e.target.value;
      inv.updatedAt = nowISO();
      try { await dbPut(STORE, inv); toast('Status: ' + inv.status); } catch (er) { console.error(er); }
      const chip = overlay.querySelector('.modal-title .chip');
      if (chip) chip.outerHTML = statusChip(inv.status);
      renderInvoices();
    });
  }

  function closeModal(idStr) {
    const el = document.getElementById(idStr);
    if (el) el.remove();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PromptPay: EMVCo payload + QR render
  // ══════════════════════════════════════════════════════════════════════
  function renderPromptPayInto(wrap, inv) {
    if (!wrap) return;
    const rawId = (typeof settings !== 'undefined' && settings && settings.promptpayId)
      ? settings.promptpayId
      : (inv.promptpayId || '');
    const target = normalizePromptPay(rawId);
    if (!target) {
      wrap.innerHTML = `<div style="background:var(--marigold-tint);border-radius:var(--radius-sm);padding:14px;font-size:13px;color:var(--marigold-ink)">
        Set your PromptPay ID (phone or 13-digit national ID) in <b>More → Settings</b> to show a scannable payment QR.</div>`;
      return;
    }
    const amount = n(inv.clientPays);
    let payload;
    try {
      payload = buildPromptPayPayload(target, amount);
    } catch (e) {
      wrap.innerHTML = `<div style="font-size:12px;color:var(--overdue)">Could not build PromptPay payload.</div>`;
      return;
    }

    wrap.innerHTML = `
      <div style="display:inline-block;background:#fff;padding:14px;border-radius:14px;border:1px solid var(--border)">
        <canvas id="inv-qr-canvas" style="display:block;image-rendering:pixelated"></canvas>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-top:6px">Scan with any Thai banking app · PromptPay</div>
      <div class="tnum" style="font-size:16px;font-weight:800;color:var(--text);margin-top:2px">${esc(money2(amount))}</div>`;

    try {
      const modules = qrGenerate(payload, ECL_M);
      drawQr(document.getElementById('inv-qr-canvas'), modules, 6, 4);
    } catch (e) {
      console.error('QR render failed', e);
      const c = document.getElementById('inv-qr-canvas');
      if (c) c.replaceWith(Object.assign(document.createElement('div'), { textContent: 'QR unavailable', style: 'font-size:12px;color:var(--overdue)' }));
    }
  }

  // Normalize a PromptPay proxy id → {tag, value}.
  //  tag '01' mobile: '00' + '66' + 9-digit NSN, left-padded to 13 chars.
  //  tag '02' national ID: 13 digits.
  //  tag '03' e-wallet: 15 digits.
  function normalizePromptPay(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 15) return { tag: '03', value: digits };
    // 13-digit '0066'-prefixed value is the app's normalized mobile form → mobile (tag 01).
    if (digits.length === 13 && digits.startsWith('0066')) return { tag: '01', value: digits };
    // 13-digit non-'00' value is a real Thai national ID (never begins with '00') → tag 02.
    if (digits.length === 13 && !digits.startsWith('00')) return { tag: '02', value: digits };
    // Treat as a Thai mobile number.
    let nsn = digits;
    if (nsn.length === 10 && nsn.charAt(0) === '0') nsn = nsn.slice(1);      // 0812345678 -> 812345678
    else if (nsn.length === 11 && nsn.slice(0, 2) === '66') nsn = nsn.slice(2); // 66812345678 -> 812345678
    else if (nsn.length === 12 && nsn.slice(0, 3) === '660') nsn = nsn.slice(3);
    if (nsn.length !== 9) return null; // not a recognizable mobile / id
    let value = '66' + nsn;            // 66812345678 (11)
    value = ('0000000000000' + value).slice(-13); // -> 0066812345678
    return { tag: '01', value: value };
  }

  function tlv(id, value) {
    const len = String(value.length).padStart(2, '0');
    return id + len + value;
  }

  function buildPromptPayPayload(target, amount) {
    const f00 = tlv('00', '01');           // payload format indicator
    const f01 = tlv('01', '12');           // dynamic (amount present)
    const merchant = tlv('00', 'A000000677010111') + tlv(target.tag, target.value);
    const f29 = tlv('29', merchant);       // merchant account info (PromptPay)
    const f53 = tlv('53', '764');          // currency THB
    const f54 = tlv('54', Number(amount).toFixed(2)); // amount, 2 decimals
    const f58 = tlv('58', 'TH');           // country
    let s = f00 + f01 + f29 + f53 + f54 + f58 + '6304';
    return s + crc16ccitt(s);
  }

  // CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
  function crc16ccitt(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) & 0xFF) << 8;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  QR CODE ENCODER  (byte mode; reference algorithm, self-contained)
  //  Based on the public-domain Nayuki QR Code generator algorithm.
  // ══════════════════════════════════════════════════════════════════════
  // ECC level: {ordinal, formatBits}
  const ECL_L = { o: 0, f: 1 }, ECL_M = { o: 1, f: 0 }, ECL_Q = { o: 2, f: 3 }, ECL_H = { o: 3, f: 2 };

  const ECC_CODEWORDS_PER_BLOCK = [
    // 0 is unused (version starts at 1); Version 1..40
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
  ];
  const NUM_EC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
  ];

  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[ecl.o][ver] * NUM_EC_BLOCKS[ecl.o][ver];
  }

  // GF(256) multiply with QR primitive 0x11D
  function rsMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    const result = [];
    for (let i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = rsMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= rsMul(coef, factor); });
    }
    return result;
  }

  function addEccAndInterleave(data, ver, ecl) {
    const numBlocks = NUM_EC_BLOCKS[ecl.o][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.o][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShort = numBlocks - rawCodewords % numBlocks;
    const shortLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const div = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - blockEccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortLen - blockEccLen || j >= numShort) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function alignPatternPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const size = ver * 4 + 17;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function qrGenerate(text, ecl) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF);

    // Choose smallest version that fits
    let ver;
    for (ver = 1; ; ver++) {
      const cap = getNumDataCodewords(ver, ecl) * 8;
      const ccbits = ver <= 9 ? 8 : 16;
      const needed = 4 + ccbits + bytes.length * 8;
      if (needed <= cap) break;
      if (ver >= 40) throw new Error('Data too long for QR');
    }
    const ccbits = ver <= 9 ? 8 : 16;
    const capacity = getNumDataCodewords(ver, ecl) * 8;

    // Bit buffer
    const bb = [];
    const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
    append(0x4, 4);                 // byte mode indicator
    append(bytes.length, ccbits);   // char count
    for (const b of bytes) append(b, 8);
    append(0, Math.min(4, capacity - bb.length)); // terminator
    while (bb.length % 8 !== 0) bb.push(0);
    for (let pad = 0xEC; bb.length < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);

    // Bits -> data codeword bytes
    const dataCw = [];
    for (let i = 0; i < bb.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bb[i + j];
      dataCw.push(v);
    }

    const allCw = addEccAndInterleave(dataCw, ver, ecl);
    return buildMatrix(ver, ecl, allCw);
  }

  function buildMatrix(ver, ecl, codewords) {
    const size = ver * 4 + 17;
    const modules = [];
    const isFn = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    const setFn = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark; isFn[y][x] = true;
    };

    // Timing patterns
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

    // Finder patterns
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // Alignment patterns
    const ap = alignPatternPositions(ver);
    const na = ap.length;
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        const cx = ap[i], cy = ap[j];
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // Reserve format & version areas (drawn properly later)
    drawFormat(ecl, 0, size, setFn); // dummy, marks function cells
    drawVersion(ver, size, setFn);

    // Draw data codewords (zigzag)
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let jj = 0; jj < 2; jj++) {
          const x = right - jj;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < codewords.length * 8) {
            modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    // Mask selection
    let bestMask = 0, minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(modules, isFn, size, m);
      drawFormat(ecl, m, size, (x, y, d) => { modules[y][x] = d; });
      const p = penalty(modules, size);
      if (p < minPenalty) { minPenalty = p; bestMask = m; }
      applyMask(modules, isFn, size, m); // undo
    }
    applyMask(modules, isFn, size, bestMask);
    drawFormat(ecl, bestMask, size, (x, y, d) => { modules[y][x] = d; });

    return modules;
  }

  function drawFormat(ecl, mask, size, put) {
    const data = (ecl.f << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    // top-left, split around finder
    for (let i = 0; i <= 5; i++) put(8, i, getBit(bits, i));
    put(8, 7, getBit(bits, 6));
    put(8, 8, getBit(bits, 7));
    put(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, getBit(bits, i));
    // second copy
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, getBit(bits, i));
    put(8, size - 8, true); // dark module
  }

  function drawVersion(ver, size, setFn) {
    if (ver < 7) return;
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, color);
      setFn(b, a, color);
    }
  }

  function applyMask(modules, isFn, size, mask) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFn[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  function penalty(modules, size) {
    let result = 0;
    // Rows
    for (let y = 0; y < size; y++) {
      let color = false, run = 0;
      let hist = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          finderAddHistory(run, hist, size);
          if (!color) result += finderCount(hist) * 40;
          color = modules[y][x]; run = 1;
        }
      }
      result += finderTerminate(color, run, hist, size) * 40;
    }
    // Columns
    for (let x = 0; x < size; x++) {
      let color = false, run = 0;
      let hist = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          finderAddHistory(run, hist, size);
          if (!color) result += finderCount(hist) * 40;
          color = modules[y][x]; run = 1;
        }
      }
      result += finderTerminate(color, run, hist, size) * 40;
    }
    // 2x2 blocks
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
    // Balance
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
  function finderAddHistory(run, hist, size) {
    if (hist[0] === 0) run += size; // white border before first run
    hist.pop();
    hist.unshift(run);
  }
  function finderCount(hist) {
    const n0 = hist[1];
    const core = n0 > 0 && hist[2] === n0 && hist[3] === n0 * 3 && hist[4] === n0 && hist[5] === n0;
    return (core && hist[0] >= n0 * 4 && hist[6] >= n0 ? 1 : 0)
      + (core && hist[6] >= n0 * 4 && hist[0] >= n0 ? 1 : 0);
  }
  function finderTerminate(color, run, hist, size) {
    if (color) { finderAddHistory(run, hist, size); run = 0; }
    run += size;
    finderAddHistory(run, hist, size);
    return finderCount(hist);
  }

  function drawQr(canvas, modules, scale, quiet) {
    if (!canvas) return;
    const nMod = modules.length;
    const dim = (nMod + quiet * 2) * scale;
    canvas.width = dim; canvas.height = dim;
    canvas.style.width = dim + 'px';
    canvas.style.height = dim + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < nMod; y++) {
      for (let x = 0; x < nMod; x++) {
        if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PRINT / PDF  (print-optimized DOM + window.print(); scoped print CSS)
  // ══════════════════════════════════════════════════════════════════════
  function printInvoice(inv) {
    const fromName = esc((typeof sellerBusinessName === 'function') ? sellerBusinessName() : 'Freelanz');
    // Optional seller tax ID/address — shown only when filled in under
    // Settings > Business info, mirroring how client tax ID/address below
    // only show when the client profile has them.
    const sellerBits = [];
    if (typeof settings !== 'undefined' && settings) {
      if (settings.sellerAddress) sellerBits.push(esc(settings.sellerAddress));
      if (settings.sellerTaxId) sellerBits.push('Tax ID: ' + esc(settings.sellerTaxId));
    }

    const rows = (inv.lineItems || []).map(li => {
      const amt = n(li.qty) * n(li.unitPrice);
      return `<tr>
        <td>${esc(li.description || '—')}</td>
        <td class="num">${esc(fmt(n(li.qty), n(li.qty) % 1 ? 2 : 0))}</td>
        <td class="num">${esc(money2(n(li.unitPrice)))}</td>
        <td class="num">${esc(money2(amt))}</td>
      </tr>`;
    }).join('');

    const deposit = n(inv.clientPays) * (n(inv.depositPct) / 100);

    // Remove any previous print root
    const prev = document.getElementById('inv-print-root');
    if (prev) prev.remove();
    const prevStyle = document.getElementById('inv-print-style');
    if (prevStyle) prevStyle.remove();

    const style = document.createElement('style');
    style.id = 'inv-print-style';
    style.textContent = `
      #inv-print-root{ display:none; }
      @media print{
        body > *{ display:none !important; }
        #inv-print-root{ display:block !important; position:static; }
        @page{ margin:16mm; }
      }
      #inv-print-root{ color:#111; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
      #inv-print-root .pi-wrap{ max-width:720px; margin:0 auto; padding:24px; }
      #inv-print-root h1{ font-size:26px; margin:0 0 2px; }
      #inv-print-root .pi-head{ display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #111; padding-bottom:12px; margin-bottom:16px; }
      #inv-print-root .pi-muted{ color:#555; font-size:13px; }
      #inv-print-root table{ width:100%; border-collapse:collapse; margin:8px 0 12px; font-size:14px; }
      #inv-print-root th,#inv-print-root td{ text-align:left; padding:8px 6px; border-bottom:1px solid #ddd; }
      #inv-print-root th.num,#inv-print-root td.num{ text-align:right; }
      #inv-print-root .pi-tot{ width:280px; margin-left:auto; font-size:14px; }
      #inv-print-root .pi-tot .r{ display:flex; justify-content:space-between; padding:3px 0; }
      #inv-print-root .pi-tot .grand{ font-weight:800; font-size:16px; border-top:2px solid #111; margin-top:4px; padding-top:6px; }
      #inv-print-root .pi-status{ display:inline-block; padding:3px 10px; border:1px solid #111; border-radius:6px; font-size:12px; text-transform:uppercase; }
      #inv-print-root .pi-notes{ margin-top:20px; font-size:12px; color:#555; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'inv-print-root';
    root.innerHTML = `
      <div class="pi-wrap">
        <div class="pi-head">
          <div>
            <h1>Invoice</h1>
            <div class="pi-muted">${esc(inv.number || '')}</div>
            <div class="pi-muted">Issued ${esc(fmtInvDate(inv.issueDate))}${inv.dueDate ? ' · Due ' + esc(fmtInvDate(inv.dueDate)) : ''}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:800;font-size:16px">${fromName}</div>
            ${sellerBits.map(b => `<div class="pi-muted">${b}</div>`).join('')}
            <div class="pi-status">${esc(inv.status || 'draft')}</div>
          </div>
        </div>
        <div style="margin-bottom:14px">
          <div class="pi-muted">Bill to</div>
          <div style="font-weight:700;font-size:15px">${esc(inv.clientName || '')}</div>
          ${inv.clientAddress ? `<div class="pi-muted">${esc(inv.clientAddress)}</div>` : ''}
          ${inv.clientTaxId ? `<div class="pi-muted">Tax ID: ${esc(inv.clientTaxId)}</div>` : ''}
        </div>
        <table>
          <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="pi-tot">
          <div class="r"><span>Subtotal</span><span>${esc(money2(inv.subtotal))}</span></div>
          <div class="r"><span>VAT (${esc(fmt(n(inv.vatPct), 2))}%)</span><span>+ ${esc(money2(inv.vat))}</span></div>
          <div class="r"><span>WHT (${esc(fmt(n(inv.whtPct), 2))}%)</span><span>- ${esc(money2(inv.wht))}</span></div>
          <div class="r grand"><span>Client pays</span><span>${esc(money2(inv.clientPays))}</span></div>
          <div class="r"><span>You receive</span><span>${esc(money2(inv.youReceive))}</span></div>
          ${n(inv.depositPct) > 0 ? `<div class="r"><span>Deposit (${esc(fmt(n(inv.depositPct), 0))}%)</span><span>${esc(money2(deposit))}</span></div>` : ''}
        </div>
        ${inv.notes ? `<div class="pi-notes">${esc(inv.notes)}</div>` : ''}
      </div>`;
    document.body.appendChild(root);

    const cleanup = () => {
      root.remove(); style.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => { window.print(); }, 60);
    // Safety cleanup if afterprint never fires
    setTimeout(cleanup, 60000);
  }

})();
