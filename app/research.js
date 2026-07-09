/* Freelanz — research.js  (M5 RESEARCH LIBRARY + subscription UI scaffold)
 *
 * OWNED BY the research/monetization agent. Loaded AFTER app.js (and the M2/M3
 * modules), so app.js globals (dbAll, dbAdd, dbPut, dbDel, dbGet, cuid, nowISO,
 * todayISO, htmlEsc, attrEsc, toast, switchScreen, settings, saveSetting,
 * currentUser, isGuest) are all available at call time.
 *
 * Public surface (kept on window):
 *   - renderResearch()      — fills #research-body
 *   - openResearchForm()    — create/edit article UI
 *
 * MONETIZATION STATUS (read this before wiring real payments): articles carry
 * an `isPremium` flag and the screen shows a "Subscribe" entry point, but there
 * is NO payment verification anywhere in this file — every article is fully
 * readable regardless of `isPremium`. This is deliberate: subscriptions need a
 * backend to verify payment state, and that work is paused (see the project
 * handshake doc). The `isPremium` flag and Subscribe button are UI scaffolding
 * only, ready to gate real content once a backend exists — do not remove them
 * when adding real payments, wire actual gating INTO them.
 *
 * Content itself is per-uid (like Services/Portfolio), not shared/global —
 * there is no backend to distribute shared content yet, so each user gets
 * their own editable copy seeded with a few example articles on first visit,
 * never re-seeded after that (same guard pattern as seedServicesIfEmpty in
 * app.js). English-only, light-mode.
 */
'use strict';

(function () {

  const esc = (s) => htmlEsc(s);
  const aesc = (s) => attrEsc(s);
  const STORE = 'research';
  const SEED_FLAG = 'researchSeeded';

  function uidNow() { return isGuest ? 'guest' : currentUser.id; }

  const SEED_ARTICLES = [
    {
      title: 'PromptPay 101: Getting Paid Instantly',
      category: 'Payments',
      isPremium: false,
      body: `PromptPay lets your clients pay you in seconds by scanning a QR code — no bank details to type in, no waiting days for a transfer to clear.\n\nFreelanz generates a PromptPay QR automatically on every invoice, built from your PromptPay ID (a phone number or Tax ID) set in More → PromptPay ID. When a client scans it in their banking app, the amount and your details are already filled in — they just confirm and pay.\n\nA few tips: double-check your PromptPay ID is correct before sending your first invoice (a wrong digit means a payment going to the wrong place). Mobile-number IDs and Tax-ID IDs use different QR formats, so let the app pick the right one rather than typing it manually elsewhere. And keep a habit of marking invoices "Paid" once you've confirmed the money landed — it keeps your follow-up queue accurate.`,
    },
    {
      title: 'Withholding Tax & VAT — What Freelancers Need to Know',
      category: 'Tax',
      isPremium: true,
      body: `Two taxes show up on most Thai freelance invoices, and it's easy to mix them up.\n\nWithholding Tax (WHT) is deducted BY YOUR CLIENT before they pay you — they withhold a percentage (commonly 3% for services) and remit it to the Revenue Department on your behalf. That amount counts toward your annual tax bill later, so keep the withholding certificate (50 ทวิ) your client gives you; you'll need it at filing time.\n\nVAT (Value Added Tax) is the opposite direction: if you're VAT-registered, you ADD it on top of your fee (commonly 7%) and the client pays you more, then you remit that VAT to the Revenue Department yourself. Most freelancers under a certain revenue threshold aren't VAT-registered and simply don't charge it.\n\nFreelanz's Tax screen and invoice form compute both automatically from the rates you set in More → Tax defaults, so you can see "Client pays" and "You receive" broken out clearly before you send anything. This is a general overview, not tax advice — confirm your specific rates and obligations with an accountant or the Revenue Department.`,
    },
    {
      title: '5 Things Every Freelance Contract Should Include',
      category: 'Contracts',
      isPremium: true,
      body: `A short, clear contract protects both you and your client — here are five things worth nailing down before you start work.\n\n1. Scope: exactly what you're delivering, and just as importantly, what you're NOT delivering. Vague scope is the #1 source of "just one more small thing" disputes.\n\n2. Payment terms: your fee, deposit (if any), due date, and what happens if payment is late.\n\n3. Revisions: how many rounds of changes are included before extra work is billed separately.\n\n4. Usage rights: who can use the final work, where, and for how long — especially important for photography, design, and content work.\n\n5. Cancellation: what happens, and who owes what, if either side needs to stop partway through.\n\nFreelanz's Docs screen can generate a starting contract from a customer's details in seconds — use it as a first draft, then adjust the specifics for the job. This is general guidance, not legal advice; for anything high-value or unusual, a quick read from a lawyer is worth it.`,
    },
  ];

  async function seedIfEmpty() {
    if (settings[SEED_FLAG]) return;                 // already seeded, even if user deleted everything since
    const uid = uidNow();
    const existing = (await dbAll(STORE)).filter(r => r.uid === uid);
    if (existing.length) { await saveSetting(SEED_FLAG, true); return; }   // never overwrite user data
    for (const a of SEED_ARTICLES) {
      await dbAdd(STORE, { uid, ...a, cuid: cuid(), createdAt: nowISO(), updatedAt: nowISO() });
    }
    await saveSetting(SEED_FLAG, true);
  }

  async function loadArticles() {
    const uid = uidNow();
    const rows = (await dbAll(STORE)).filter(r => r.uid === uid);
    rows.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  LIST SCREEN  →  #research-body
  // ══════════════════════════════════════════════════════════════════════
  async function renderResearch() {
    const el = document.getElementById('research-body');
    if (!el) return;

    let rows;
    try {
      await seedIfEmpty();
      rows = await loadArticles();
    } catch (err) {
      console.error('renderResearch', err);
      el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>Could not load research.</p></div>`;
      return;
    }

    const subscribeBanner = `
      <div style="background:var(--marigold-tint);border:1px solid var(--marigold);border-radius:var(--radius-sm);padding:14px 16px;margin:0 0 16px">
        <div style="font-weight:800;color:var(--marigold-ink);font-size:14px;margin-bottom:3px">⭐ Premium research</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:10px">In-depth guides marked "Premium" are unlocked for everyone while subscriptions are in preview — no payment needed yet.</div>
        <button type="button" id="rs-subscribe-btn" style="width:100%;padding:11px;border:1.5px solid var(--marigold);background:none;color:var(--marigold-ink);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:13px;cursor:pointer">Subscribe</button>
      </div>`;

    const addBtn = `<button type="button" id="rs-add-btn" class="btn-submit" style="width:100%;margin:0 0 16px">+ Add article</button>`;

    let listHtml;
    if (!rows.length) {
      listHtml = `<div class="empty"><div class="empty-icon">📚</div>
        <p>No research yet</p>
        <span>Add your own notes, or write-ups worth remembering for next time.</span>
      </div>`;
    } else {
      listHtml = '<div class="list-card">' + rows.map(a => `
        <div class="list-row" data-rs="${a.id}" tabindex="0" role="button">
          <div class="list-icon">📘</div>
          <div class="list-main">
            <div class="list-title">${esc(a.title)}</div>
            <div class="list-sub">${esc(a.category || 'General')}</div>
          </div>
          <div class="list-right">
            ${a.isPremium ? `<span style="background:var(--marigold-tint);color:var(--marigold-ink);border-radius:999px;padding:4px 9px;font-size:11px;font-weight:800">⭐ Premium</span>` : ''}
          </div>
        </div>`).join('') + '</div>';
    }

    el.innerHTML = subscribeBanner + addBtn + listHtml;

    const subBtn = document.getElementById('rs-subscribe-btn');
    if (subBtn) subBtn.addEventListener('click', () => {
      toast("Subscriptions aren't live yet — enjoy full access during preview");
    });
    const addBtnEl = document.getElementById('rs-add-btn');
    if (addBtnEl) addBtnEl.addEventListener('click', () => openResearchForm());

    el.querySelectorAll('[data-rs]').forEach(row => {
      const open = () => openArticleDetail(parseInt(row.getAttribute('data-rs'), 10));
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }
  window.renderResearch = renderResearch;

  function closeModal(idStr) {
    const el = document.getElementById(idStr);
    if (el) el.remove();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  DETAIL / READER  (dynamic modal)
  // ══════════════════════════════════════════════════════════════════════
  async function openArticleDetail(id) {
    const a = await dbGet(STORE, id);
    if (!a || a.uid !== uidNow()) { toast('Article not found'); return; }
    closeModal('rs-detail-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.id = 'rs-detail-modal';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-handle"></div>
        <div class="modal-title">
          ${esc(a.title)}
          ${a.isPremium ? `<span style="background:var(--marigold-tint);color:var(--marigold-ink);border-radius:999px;padding:3px 9px;font-size:11px;font-weight:800;margin-left:8px;vertical-align:middle">⭐ Premium</span>` : ''}
        </div>
        <div style="padding:2px 16px 4px;color:var(--text3);font-size:12px">${esc(a.category || 'General')}</div>
        <div style="padding:10px 16px 6px;white-space:pre-wrap;font-size:14px;line-height:1.55;color:var(--text)">${esc(a.body || '')}</div>
        <div style="display:flex;gap:8px;padding:14px 16px 2px">
          <button type="button" id="rs-d-edit" style="flex:1;padding:12px;border:1.5px solid var(--brand);background:none;color:var(--brand);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">Edit</button>
          <button type="button" id="rs-d-delete" style="flex:1;padding:12px;border:1.5px solid var(--overdue);background:none;color:var(--overdue);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:14px;cursor:pointer">Delete</button>
        </div>
        <button type="button" class="btn-danger" id="rs-d-close" style="border-color:var(--border-mid);color:var(--text3)">Close</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#rs-d-close').addEventListener('click', () => closeModal('rs-detail-modal'));
    overlay.querySelector('#rs-d-edit').addEventListener('click', () => { closeModal('rs-detail-modal'); openResearchEdit(a); });
    overlay.querySelector('#rs-d-delete').addEventListener('click', () => deleteArticle(a.id));
  }

  async function deleteArticle(id) {
    if (!confirm('Delete this article? This cannot be undone.')) return;
    try { await dbDel(STORE, id); } catch (e) { console.error(e); }
    closeModal('rs-detail-modal');
    toast('Article deleted');
    renderResearch();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADD / EDIT FORM  (dynamic modal)
  // ══════════════════════════════════════════════════════════════════════
  let editing = null;

  function openResearchForm() {
    editing = null;
    buildFormModal({ title: '', category: '', body: '', isPremium: false }, false);
  }
  window.openResearchForm = openResearchForm;

  function openResearchEdit(a) {
    editing = a;
    buildFormModal({ title: a.title || '', category: a.category || '', body: a.body || '', isPremium: !!a.isPremium }, true);
  }

  function buildFormModal(v, isEdit) {
    closeModal('rs-form-modal');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.id = 'rs-form-modal';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-handle"></div>
        <div class="modal-title">${isEdit ? 'Edit article' : 'New article'}</div>
        <div class="form-section">
          <div class="field"><label for="rs-title">Title</label>
            <input type="text" id="rs-title" value="${aesc(v.title)}" placeholder="e.g. How I price rush jobs"></div>
          <div class="field"><label for="rs-category">Category</label>
            <input type="text" id="rs-category" value="${aesc(v.category)}" placeholder="e.g. Pricing, Tax, Contracts"></div>
          <div class="field"><label for="rs-body">Notes</label>
            <textarea id="rs-body" rows="8" placeholder="Write your notes here...">${esc(v.body)}</textarea></div>
          <label style="display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px;color:var(--text2);cursor:pointer">
            <input type="checkbox" id="rs-premium" ${v.isPremium ? 'checked' : ''} style="width:17px;height:17px">
            Mark as Premium (visual only during preview — not gated yet)
          </label>
        </div>
        <button type="button" class="btn-submit" id="rs-save">${isEdit ? 'Save changes' : 'Add article'}</button>
        ${isEdit ? `<button type="button" class="btn-danger" id="rs-del">Delete article</button>` : ''}
        <button type="button" class="btn-danger" id="rs-cancel" style="border-color:var(--border-mid);color:var(--text3)">Cancel</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#rs-save').addEventListener('click', () => saveArticle(isEdit));
    overlay.querySelector('#rs-cancel').addEventListener('click', () => closeModal('rs-form-modal'));
    if (isEdit) overlay.querySelector('#rs-del').addEventListener('click', () => deleteArticle(editing.id));
  }

  function markErr(inputId, msg) {
    const input = document.getElementById(inputId);
    if (!input) { toast(msg); return; }
    const wrap = input.closest('.field') || input.parentElement;
    wrap.classList.add('field-invalid');
    if (!wrap.querySelector('.field-err')) {
      const e = document.createElement('div');
      e.className = 'field-err';
      e.style.cssText = 'color:var(--overdue);font-size:12px;margin-top:4px';
      e.textContent = msg;
      wrap.appendChild(e);
    }
    input.addEventListener('input', () => { wrap.classList.remove('field-invalid'); const err = wrap.querySelector('.field-err'); if (err) err.remove(); }, { once: true });
  }

  async function saveArticle(isEdit) {
    document.querySelectorAll('#rs-form-modal .field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('#rs-form-modal .field-err').forEach(el => el.remove());

    const title = document.getElementById('rs-title').value.trim();
    const category = document.getElementById('rs-category').value.trim();
    const body = document.getElementById('rs-body').value.trim();
    const isPremium = document.getElementById('rs-premium').checked;

    let bad = false;
    if (!title) { markErr('rs-title', 'Enter a title'); bad = true; }
    if (!body) { markErr('rs-body', 'Add some notes'); bad = true; }
    if (bad) return;

    const uid = uidNow();
    const base = { uid, title, category, body, isPremium, updatedAt: nowISO() };

    try {
      if (isEdit) {
        base.id = editing.id;
        base.cuid = editing.cuid || cuid();
        base.createdAt = editing.createdAt || nowISO();
        await dbPut(STORE, base);
        toast('Article updated');
      } else {
        base.cuid = cuid();
        base.createdAt = nowISO();
        await dbAdd(STORE, base);
        toast('Article added');
      }
    } catch (err) {
      console.error(err);
      toast('Could not save article');
      return;
    }
    closeModal('rs-form-modal');
    renderResearch();
  }

})();
