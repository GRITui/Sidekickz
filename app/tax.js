/* Sidekick — tax.js  (M2 TAX ENGINE, + M4 Pass P4 annual roll-up)
 *
 * OWNED BY the tax-engine agent. The M2 per-invoice calculator below fills
 * #tax-body only, English-only inline UI, and does not touch app.js's I18N
 * dict. Light-mode tokens only (consumes the existing var(--...) design
 * tokens from styles.css — no new colors).
 *
 * M4 Pass P4 adds a second, report-only block — the annual ภ.ง.ด.90/94
 * filing-prep roll-up — filling #tax-rollup-body, its own sibling
 * container inside the same #docs-tax-details area index.html gives tax.js.
 * Unlike the calculator above, the roll-up IS localized (t()/I18N, prefix
 * taxr_) since it's read by freelancers doing real paperwork, not just
 * running napkin math. Loaded after app.js (see index.html's <script>
 * order), so app.js's globals — t, curLang, todayISO, tlDaysBetween, money,
 * fmtDate, curSym, dbAll, jobs, jobEarned, isGuest, currentUser — are all
 * available at call time via the shared top-level script scope (same
 * convention invoices.js documents at the top of its own file).
 *
 * Public surface (kept per the M2 contract, exposed on window):
 *   - computeTax(subtotal, whtPct, vatPct) -> {vat, wht, clientPays, youReceive}
 *   - renderTax()  — fills #tax-body (empty container it owns)
 * M4 Pass P4 additions (also exposed on window):
 *   - computeAnnualTax(netIncome) -> {total, bands:[{from,to,rate,taxable,tax}]}
 *   - renderTaxRollup()  — fills #tax-rollup-body (async: reads dbAll('invoices') + the jobs global)
 */
'use strict';

// ─── pure math ──────────────────────────────────────────────────────────
// Rounds to 2dp using an epsilon nudge to dodge classic FP artifacts
// (e.g. 1.005 * 100 landing on 100.49999999999999).
function taxRound2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// TH convention (contract): VAT and WHT are both computed on the pre-tax
// subtotal (the service base). clientPays = subtotal + vat (what the client
// transfers); youReceive = subtotal + vat - wht (client withholds WHT and
// remits it to the Revenue Department on your behalf). Pure function: no
// NaN/negative inputs can escape as NaN/negative outputs.
function computeTax(subtotal, whtPct, vatPct) {
  let s = Number(subtotal); if (!isFinite(s) || s < 0) s = 0;
  let w = Number(whtPct);   if (!isFinite(w) || w < 0) w = 0;
  let v = Number(vatPct);   if (!isFinite(v) || v < 0) v = 0;

  const vat = taxRound2(s * (v / 100));
  const wht = taxRound2(s * (w / 100));
  const clientPays = taxRound2(s + vat);
  const youReceive = taxRound2(clientPays - wht);
  return { vat, wht, clientPays, youReceive };
}
window.computeTax = computeTax;

// ─── calculator state (session-only; re-seeded from settings on first render) ──
const WHT_PRESETS = [0, 1, 2, 3, 5];
let taxState = null;

function taxDefaultState() {
  const whtDefault = (settings && settings.wht != null) ? Number(settings.wht) : 3;
  const vatDefault = (settings && settings.vat != null) ? Number(settings.vat) : 7;
  return {
    amount: '',
    whtPct: isFinite(whtDefault) ? whtDefault : 3,
    vatOn: vatDefault > 0,
    vatPct: isFinite(vatDefault) && vatDefault > 0 ? vatDefault : 7,
  };
}

function taxEnsureStyles() {
  if (document.getElementById('tax-styles')) return;
  const style = document.createElement('style');
  style.id = 'tax-styles';
  style.textContent = `
#tax-body{display:block;}
.tx-card{background:var(--card);border:0.5px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin:0 0 14px;}
.tx-label{font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;display:block;}
.tx-amount-wrap{display:flex;align-items:baseline;gap:8px;border-bottom:1px solid var(--border);padding-bottom:10px;}
.tx-amount-sym{font-size:22px;font-weight:800;color:var(--text3);}
#tx-amount{flex:1;border:none;outline:none;background:transparent;font-family:inherit;font-size:28px;font-weight:800;
  color:var(--text);padding:2px 0;min-width:0;}
.tx-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.tx-row:last-child{margin-bottom:0;}
.tx-row-title{font-size:14px;font-weight:700;color:var(--text2);}
.tx-chip-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.tx-chip{border:1.5px solid var(--border-mid);background:var(--card);color:var(--text2);font-family:inherit;
  font-size:13px;font-weight:700;padding:8px 13px;border-radius:20px;cursor:pointer;transition:all .12s;}
.tx-chip.active{background:var(--brand);border-color:var(--brand);color:#fff;}
.tx-chip:focus-visible,.tx-custom-input:focus-visible,#tx-amount:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand);}
.tx-custom-wrap{display:flex;align-items:center;gap:4px;border:1.5px solid var(--border-mid);border-radius:20px;padding:6px 6px 6px 12px;}
.tx-custom-input{width:44px;border:none;outline:none;background:transparent;font-family:inherit;font-size:13px;
  font-weight:700;color:var(--text);padding:2px 0;-moz-appearance:textfield;}
.tx-custom-input::-webkit-outer-spin-button,.tx-custom-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.tx-custom-input:focus-visible{border-radius:9px;}
.tx-custom-suffix{font-size:12px;font-weight:700;color:var(--text3);padding-right:4px;}
.tx-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0;}
.tx-switch input{position:absolute;inset:0;opacity:0;width:44px;height:24px;margin:0;cursor:pointer;}
.tx-switch-track{width:44px;height:24px;background:var(--border-mid);border-radius:12px;position:relative;transition:background .15s;}
.tx-switch input:checked + .tx-switch-track{background:var(--brand);}
.tx-switch input:focus-visible + .tx-switch-track{box-shadow:0 0 0 2px var(--brand);}
.tx-switch-thumb{position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;
  transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.25);}
.tx-switch input:checked + .tx-switch-track .tx-switch-thumb{left:22px;}
.tx-vat-pct{display:flex;align-items:center;gap:10px;margin-top:12px;}
.tx-vat-pct.disabled{opacity:.4;pointer-events:none;}
.tx-breakdown-line{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:14px;color:var(--text2);}
.tx-breakdown-line.sub{color:var(--text3);font-size:13px;}
.tx-breakdown-line .v{font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;}
.tx-breakdown-line .v.neg{color:var(--overdue);}
.tx-breakdown-line .v.pos{color:var(--paid);}
.tx-divider{height:1px;background:var(--border);margin:2px 0;}
.tx-final{display:flex;justify-content:space-between;align-items:baseline;padding-top:10px;}
.tx-final .lbl{font-size:14px;font-weight:800;color:var(--text);}
.tx-final .amt{font-size:26px;font-weight:800;color:var(--brand);letter-spacing:-.5px;font-variant-numeric:tabular-nums;}
.tx-note{font-size:12px;line-height:1.5;color:var(--text3);padding:2px 2px 0;}
.tx-btn{width:100%;padding:14px;background:var(--brand-tint);color:var(--brand);border:1.5px solid transparent;
  border-radius:var(--radius-sm);font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;transition:background .12s;}
.tx-btn:active{background:color-mix(in srgb,var(--brand) 20%,var(--brand-tint));}
.tx-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--brand);}
`;
  document.head.appendChild(style);
}

function taxChipActive(v) {
  return Math.abs(Number(taxState.whtPct) - v) < 1e-9;
}

function taxSelectWht(v) {
  taxState.whtPct = v;
  document.querySelectorAll('#tx-wht-chips .tx-chip').forEach(btn => {
    const on = Math.abs(Number(btn.dataset.val) - v) < 1e-9;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const custom = document.getElementById('tx-wht-custom');
  if (custom) custom.value = v;
  taxUpdateBreakdown();
}
window.taxSelectWht = taxSelectWht;

function taxOnWhtCustom(v) {
  const n = parseFloat(v);
  taxState.whtPct = isFinite(n) && n >= 0 ? n : 0;
  document.querySelectorAll('#tx-wht-chips .tx-chip').forEach(btn => {
    const on = Math.abs(Number(btn.dataset.val) - taxState.whtPct) < 1e-9;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  taxUpdateBreakdown();
}
window.taxOnWhtCustom = taxOnWhtCustom;

function taxToggleVat(checked) {
  taxState.vatOn = !!checked;
  const wrap = document.getElementById('tx-vat-pct-wrap');
  const input = document.getElementById('tx-vat-pct');
  if (wrap) wrap.classList.toggle('disabled', !checked);
  if (input) input.disabled = !checked;
  taxUpdateBreakdown();
}
window.taxToggleVat = taxToggleVat;

function taxOnVatPct(v) {
  const n = parseFloat(v);
  taxState.vatPct = isFinite(n) && n >= 0 ? n : 0;
  taxUpdateBreakdown();
}
window.taxOnVatPct = taxOnVatPct;

function taxOnAmountInput(v) {
  const n = parseFloat(v);
  taxState.amount = isFinite(n) && n >= 0 ? n : 0;
  taxUpdateBreakdown();
}
window.taxOnAmountInput = taxOnAmountInput;

// Trims trailing .0 for a clean "3%" instead of "3.0%" while still showing
// decimals a user actually typed (e.g. "2.5%").
function taxOptNum(n) {
  const num = Number(n) || 0;
  return (Math.round(num * 100) / 100).toString();
}

function taxUpdateBreakdown() {
  const subtotal = Number(taxState.amount) || 0;
  const whtPct = Number(taxState.whtPct) || 0;
  const vatPct = taxState.vatOn ? (Number(taxState.vatPct) || 0) : 0;
  const r = computeTax(subtotal, whtPct, vatPct);

  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  set('tx-out-fee', money(subtotal, 2));
  set('tx-out-vat-lbl', `+ VAT (${taxOptNum(vatPct)}%)`);
  set('tx-out-vat', '+ ' + money(r.vat, 2));
  set('tx-out-clientpays', money(r.clientPays, 2));
  set('tx-out-wht-lbl', `− WHT (${taxOptNum(whtPct)}%)`);
  set('tx-out-wht', '− ' + money(r.wht, 2));
  set('tx-out-receive', money(r.youReceive, 2));
}

function taxUseInInvoice() {
  const subtotal = Number(taxState.amount) || 0;
  if (!(subtotal > 0)) { toast('Enter an amount first'); return; }
  switchScreen('invoices');
  if (typeof openInvoiceForm === 'function') openInvoiceForm();
  const vatPct = taxState.vatOn ? (Number(taxState.vatPct) || 0) : 0;
  toast(`Add a line item of ${money(subtotal, 2)} — WHT ${taxOptNum(taxState.whtPct)}%, VAT ${taxOptNum(vatPct)}%`);
}
window.taxUseInInvoice = taxUseInInvoice;

// ─── screen renderer ────────────────────────────────────────────────────
function renderTax() {
  const el = document.getElementById('tax-body');
  if (!el) return;

  if (!taxState) taxState = taxDefaultState();
  taxEnsureStyles();

  const chipsHtml = WHT_PRESETS.map(v =>
    `<button type="button" class="tx-chip${taxChipActive(v) ? ' active' : ''}" data-val="${v}" aria-pressed="${taxChipActive(v) ? 'true' : 'false'}" onclick="taxSelectWht(${v})">${v}%</button>`
  ).join('');

  el.innerHTML = `
    <div class="tx-card">
      <span class="tx-label">Fee amount (before tax)</span>
      <div class="tx-amount-wrap">
        <span class="tx-amount-sym">${curSym()}</span>
        <input id="tx-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00"
          aria-label="Fee amount before tax" value="${taxState.amount === '' ? '' : taxState.amount}"
          oninput="taxOnAmountInput(this.value)">
      </div>
    </div>

    <div class="tx-card">
      <span class="tx-label">Withholding tax (WHT)</span>
      <div class="tx-chip-row" id="tx-wht-chips" role="group" aria-label="WHT percent presets">
        ${chipsHtml}
        <div class="tx-custom-wrap">
          <input id="tx-wht-custom" class="tx-custom-input" type="number" min="0" max="100" step="0.1"
            aria-label="Custom WHT percent" value="${taxState.whtPct}" oninput="taxOnWhtCustom(this.value)">
          <span class="tx-custom-suffix">%</span>
        </div>
      </div>
    </div>

    <div class="tx-card">
      <div class="tx-row">
        <span class="tx-row-title">Charge VAT</span>
        <label class="tx-switch">
          <input type="checkbox" id="tx-vat-on" ${taxState.vatOn ? 'checked' : ''} aria-label="Charge VAT" onchange="taxToggleVat(this.checked)">
          <span class="tx-switch-track"><span class="tx-switch-thumb"></span></span>
        </label>
      </div>
      <div class="tx-vat-pct${taxState.vatOn ? '' : ' disabled'}" id="tx-vat-pct-wrap">
        <span class="tx-custom-suffix" style="padding-right:0;">VAT rate</span>
        <div class="tx-custom-wrap">
          <input id="tx-vat-pct" class="tx-custom-input" type="number" min="0" max="100" step="0.1"
            aria-label="VAT percent" value="${taxState.vatPct}" ${taxState.vatOn ? '' : 'disabled'} oninput="taxOnVatPct(this.value)">
          <span class="tx-custom-suffix">%</span>
        </div>
      </div>
    </div>

    <div class="tx-card">
      <span class="tx-label">Breakdown</span>
      <div class="tx-breakdown-line"><span>Fee</span><span class="v" id="tx-out-fee">${money(0, 2)}</span></div>
      <div class="tx-breakdown-line sub"><span id="tx-out-vat-lbl">+ VAT (${taxOptNum(taxState.vatOn ? taxState.vatPct : 0)}%)</span><span class="v pos" id="tx-out-vat">+ ${money(0, 2)}</span></div>
      <div class="tx-divider"></div>
      <div class="tx-breakdown-line"><span>Client pays</span><span class="v" id="tx-out-clientpays">${money(0, 2)}</span></div>
      <div class="tx-breakdown-line sub"><span id="tx-out-wht-lbl">− WHT (${taxOptNum(taxState.whtPct)}%)</span><span class="v neg" id="tx-out-wht">− ${money(0, 2)}</span></div>
      <div class="tx-divider"></div>
      <div class="tx-final"><span class="lbl">You receive</span><span class="amt" id="tx-out-receive">${money(0, 2)}</span></div>
    </div>

    <button type="button" class="tx-btn" onclick="taxUseInInvoice()">Use in new invoice →</button>

    <p class="tx-note">Estimate only, not tax advice. WHT and VAT rates vary by service type and client status — confirm with an accountant or the Revenue Department before filing.</p>
  `;

  taxUpdateBreakdown();
}
window.renderTax = renderTax;

// ═══════════════════════════════════════════════════════════════════════
//  M4 Pass P4 — Thai annual tax roll-up (ภ.ง.ด.90/94), report-only.
//  Fills #tax-rollup-body, a second block living inside the same
//  #docs-tax-details area the calculator above owns. Localized via app.js's
//  t()/I18N (prefix taxr_) — see the file header for why this block differs
//  from the English-only calculator above.
// ═══════════════════════════════════════════════════════════════════════

// ─── rate constants — web-verified 2026-07-17 (Revenue Department, rd.go.th) ──
// Everything below reads from this one table — update it here when rates
// change and the whole roll-up follows.
//   Progressive PIT brackets (THB, annual net/taxable income):
//     0%   up to 150,000        20%  750,001 – 1,000,000
//     5%   150,001 – 300,000    25%  1,000,001 – 2,000,000
//     10%  300,001 – 500,000    30%  2,000,001 – 5,000,000
//     15%  500,001 – 750,000    35%  over 5,000,000
//   Standard expense deduction, by income category (or actual expenses):
//     40(2)   ค่ารับจ้าง/นายหน้า (commissions, freelance service fees) — 50%, CAPPED at ฿100,000
//     40(6)   วิชาชีพอิสระ (liberal professions)                        — 30%, no cap
//     40(7)(8) รับเหมา/ธุรกิจ (contracting / business)                  — 60%, no cap
//   Personal allowance: ฿60,000 — the ONLY allowance auto-applied here;
//     the UI label tells the user to add their own others (spouse,
//     children, parents, insurance, etc) themselves.
//   Filing windows: ภ.ง.ด.94 (§40(5)-(8) income earned Jan–Jun) is due
//     30 Sep of that same year, e-file extension to 8 Oct. ภ.ง.ด.90
//     (the annual return) is due 31 Mar of the FOLLOWING year, e-file
//     extension to 8 Apr.
const TAXR_BRACKETS = [
  { upTo: 150000,   rate: 0.00 },
  { upTo: 300000,   rate: 0.05 },
  { upTo: 500000,   rate: 0.10 },
  { upTo: 750000,   rate: 0.15 },
  { upTo: 1000000,  rate: 0.20 },
  { upTo: 2000000,  rate: 0.25 },
  { upTo: 5000000,  rate: 0.30 },
  { upTo: Infinity, rate: 0.35 },
];
const TAXR_DEDUCTION = {
  '40_2':   { pct: 0.50, cap: 100000 },
  '40_6':   { pct: 0.30, cap: null },
  '40_7_8': { pct: 0.60, cap: null },
};
const TAXR_ALLOWANCE = 60000;

// ─── pure math (exposed for reuse/testing, same spirit as computeTax) ──────
// Marginal progressive tax on `netIncome`. Walks the bracket table once,
// taxing only the slice of income that falls in each band — never the
// "apply top rate to everything" mistake. Returns the bands actually
// touched so the UI can render a band-by-band breakdown (freelancers
// distrust a single black-box number).
function computeAnnualTax(netIncome) {
  let net = Number(netIncome); if (!isFinite(net) || net < 0) net = 0;
  let prev = 0, total = 0;
  const bands = [];
  for (const b of TAXR_BRACKETS) {
    if (net <= prev) break;
    const top = Math.min(net, b.upTo);
    const taxable = taxRound2(top - prev);
    const tax = taxRound2(taxable * b.rate);
    bands.push({ from: prev, to: top, rate: b.rate, taxable, tax });
    total = taxRound2(total + tax);
    prev = b.upTo;
  }
  return { total, bands };
}
window.computeAnnualTax = computeAnnualTax;

// Expense deduction for the year: 'actual' ignores category entirely and
// just returns the actual-expense total the caller already summed; 'std'
// applies the category's flat percentage, capped for 40(2) only.
function taxrDeduction(category, mode, income, actualExpense) {
  if (mode === 'actual') return Math.max(0, taxRound2(Number(actualExpense) || 0));
  const cfg = TAXR_DEDUCTION[category] || TAXR_DEDUCTION['40_6'];
  const inc = Number(income) || 0;
  const raw = inc * cfg.pct;
  return taxRound2(cfg.cap != null ? Math.min(raw, cfg.cap) : raw);
}
window.taxrDeduction = taxrDeduction;

function taxrBEYear(y) { return Number(y) + 543; }

// Extracts the calendar year out of an ISO date string ('YYYY-MM-DD...').
function taxrYearOf(dateStr) {
  const y = parseInt(String(dateStr || '').slice(0, 4), 10);
  return isFinite(y) ? y : null;
}

// The one function that stands in for "today" throughout this block, so a
// test can pin the filing-deadline countdown to a fixed date without
// mocking the system clock: set window.__taxrToday to an ISO date string
// before calling renderTaxRollup(). Falls back to app.js's todayISO().
function taxrTodayISO() {
  if (window.__taxrToday) return window.__taxrToday;
  return (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10);
}
window.taxrTodayISO = taxrTodayISO;

// ─── data gathering ─────────────────────────────────────────────────────
// Paid invoices (for income + WHT credits) come straight from IndexedDB —
// mirrors invoices.js's loadInvoices()/renderInvoices() "liquid revenue"
// convention (status==='paid', youReceive is the cash actually received,
// wht is the credit withheld on your behalf). Cash engagements come from
// app.js's already-loaded `jobs` global (kept fresh by reload()), filtered
// to jobs actually marked paid (jobEarned() — a job-level flag, not a
// pipeline stage, see app.js TSK-014) with no linked invoice — an invoiced
// job's money is already counted above.
async function taxrGatherData() {
  const uid = (typeof isGuest !== 'undefined' && isGuest) ? 'guest' :
    (typeof currentUser !== 'undefined' && currentUser ? currentUser.id : null);
  let invRows = [];
  try {
    invRows = (await dbAll('invoices')).filter(r => r.uid === uid && r.status === 'paid');
  } catch (e) { invRows = []; }
  const allJobs = (typeof jobs !== 'undefined' && Array.isArray(jobs)) ? jobs : [];
  const cashJobs = allJobs.filter(j => j.invoiceId == null && typeof jobEarned === 'function' && jobEarned(j));
  return { invRows, cashJobs, allJobs };
}

// Every year that actually has data (paid-invoice or cash-job), plus the
// current year so a brand-new account still has something to select —
// sparse on purpose (the selector doesn't need to offer years with
// nothing in them, just reach back to the earliest one that does).
function taxrAvailableYears(invRows, cashJobs) {
  const set = new Set();
  invRows.forEach(r => { const y = taxrYearOf(r.issueDate); if (y != null) set.add(y); });
  cashJobs.forEach(j => { const y = taxrYearOf(j.date); if (y != null) set.add(y); });
  set.add(taxrYearOf(taxrTodayISO()) || new Date().getFullYear());
  return Array.from(set).sort((a, b) => b - a);
}

// All the per-year figures the render needs in one pass: invoice income +
// WHT credit + 50-Tawi received/total (only invoices with WHT withheld
// carry a Tawi certificate at all), cash-engagement income, and the
// actual-expense total (every job's expense field for the year, not just
// cash engagements — a job billed via invoice can still carry real costs).
function taxrComputeYearData(invRows, cashJobs, allJobs, year) {
  let invIncome = 0, whtCredit = 0, tawiTotal = 0, tawiReceived = 0;
  invRows.forEach(r => {
    if (taxrYearOf(r.issueDate) !== year) return;
    invIncome += Number(r.youReceive) || 0;
    const w = Number(r.wht) || 0;
    if (w > 0) {
      whtCredit += w;
      tawiTotal++;
      if (r.tawiStatus === 'received') tawiReceived++;
    }
  });
  let cashIncome = 0;
  cashJobs.forEach(j => {
    if (taxrYearOf(j.date) !== year) return;
    // isFinite, not truthy-OR: a legitimate netAmount of 0 (fee fully eaten
    // by expenses) must not fall back to the gross amount.
    cashIncome += Number.isFinite(Number(j.netAmount)) && j.netAmount != null
      ? Number(j.netAmount) : (Number(j.amount) || 0);
  });
  const actualExpense = allJobs
    .filter(j => taxrYearOf(j.date) === year)
    .reduce((s, j) => s + (Number(j.expense) || 0), 0);
  return {
    invIncome: taxRound2(invIncome), cashIncome: taxRound2(cashIncome),
    whtCredit: taxRound2(whtCredit), tawiTotal, tawiReceived,
    actualExpense: taxRound2(actualExpense),
  };
}

// ─── roll-up state (session-only, mirrors taxState above) ──────────────
let taxRollupState = null;
function taxRollupDefaultState() {
  return { year: taxrYearOf(taxrTodayISO()) || new Date().getFullYear(), category: '40_2', deductMode: 'std' };
}

function taxrOnYearChange(v) {
  taxRollupState.year = parseInt(v, 10);
  renderTaxRollup();
}
window.taxrOnYearChange = taxrOnYearChange;

function taxrOnCategoryChange(v) {
  taxRollupState.category = v;
  renderTaxRollup();
}
window.taxrOnCategoryChange = taxrOnCategoryChange;

function taxrOnDeductModeChange(v) {
  taxRollupState.deductMode = v;
  renderTaxRollup();
}
window.taxrOnDeductModeChange = taxrOnDeductModeChange;

function taxrEnsureStyles() {
  if (document.getElementById('tax-rollup-styles')) return;
  const style = document.createElement('style');
  style.id = 'tax-rollup-styles';
  style.textContent = `
#tax-rollup-body{display:block;margin-top:18px;padding-top:18px;border-top:1px solid var(--border);}
.txr-select{width:100%;padding:10px 12px;border:1.5px solid var(--border-mid);border-radius:var(--radius-sm);
  background:var(--card);color:var(--text);font-family:inherit;font-size:14px;font-weight:700;}
.txr-band-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text2);padding:4px 0;}
.txr-band-row .range{flex:1;color:var(--text3);font-variant-numeric:tabular-nums;}
.txr-band-row .rate{width:38px;flex-shrink:0;text-align:right;color:var(--text3);}
.txr-band-row .amt{width:84px;flex-shrink:0;text-align:right;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;}
.txr-chip-count{display:inline-block;background:var(--marigold-tint);color:var(--marigold-ink);font-size:11px;
  font-weight:800;padding:4px 9px;border-radius:12px;margin-left:8px;white-space:nowrap;}
.txr-hint{font-size:12px;line-height:1.4;color:var(--text3);margin:4px 0 0;}
.txr-disclaimer{background:var(--marigold-tint);color:var(--marigold-ink);font-size:12px;line-height:1.5;}
`;
  document.head.appendChild(style);
}

// ─── screen renderer ────────────────────────────────────────────────────
async function renderTaxRollup() {
  const el = document.getElementById('tax-rollup-body');
  if (!el) return;

  if (!taxRollupState) taxRollupState = taxRollupDefaultState();
  taxEnsureStyles();
  taxrEnsureStyles();

  const { invRows, cashJobs, allJobs } = await taxrGatherData();
  const years = taxrAvailableYears(invRows, cashJobs);
  if (!years.includes(taxRollupState.year)) taxRollupState.year = years[0];
  const year = taxRollupState.year;

  const yd = taxrComputeYearData(invRows, cashJobs, allJobs, year);
  const totalIncome = taxRound2(yd.invIncome + yd.cashIncome);
  const deduction = taxrDeduction(taxRollupState.category, taxRollupState.deductMode, totalIncome, yd.actualExpense);
  const netIncome = Math.max(0, taxRound2(totalIncome - deduction - TAXR_ALLOWANCE));
  const { total: taxTotal, bands } = computeAnnualTax(netIncome);
  const netResult = taxRound2(taxTotal - yd.whtCredit);
  const isRefund = netResult < 0;

  const lang = curLang();
  const yearOptions = years.map(y =>
    `<option value="${y}"${y === year ? ' selected' : ''}>${lang === 'th' ? taxrBEYear(y) : y}</option>`
  ).join('');

  const catOptions = ['40_2', '40_6', '40_7_8'].map(c =>
    `<option value="${c}"${c === taxRollupState.category ? ' selected' : ''}>${t('taxr_cat_' + c)}</option>`
  ).join('');

  const bandsHtml = bands.map(b =>
    `<div class="txr-band-row" data-rate="${b.rate}" data-tax="${b.tax}" data-from="${b.from}" data-to="${b.to}">
      <span class="range">${money(b.from, 0)}–${money(b.to, 0)}</span>
      <span class="rate">${Math.round(b.rate * 100)}%</span>
      <span class="amt">${money(b.tax, 2)}</span>
    </div>`
  ).join('') || `<div class="txr-band-row"><span class="range">${money(0, 0)}</span><span class="rate">0%</span><span class="amt">${money(0, 2)}</span></div>`;

  // Filing windows for the SELECTED year: ภ.ง.ด.94 (Jan–Jun income) is due
  // 30 Sep of the selected year itself; ภ.ง.ด.90 (the annual return) is due
  // 31 Mar of the FOLLOWING year. The countdown chip is keyed off "today"
  // (taxrTodayISO(), stubbable) regardless of which year is selected — pick
  // a past year and both windows have already closed, so no chip shows.
  const due94 = `${year}-09-30`, efile94 = `${year}-10-08`;
  const due90 = `${year + 1}-03-31`, efile90 = `${year + 1}-04-08`;
  const today = taxrTodayISO();
  const daysLeft94 = tlDaysBetween(today, due94);
  const daysLeft90 = tlDaysBetween(today, due90);
  const chip = (n, id) => (n >= 0 && n <= 60)
    ? `<span class="txr-chip-count" id="${id}">${t('taxr_days_left').replace('{n}', n)}</span>` : '';

  el.innerHTML = `
    <h3 style="font-size:15px;font-weight:800;color:var(--text);margin:4px 0 2px;">${t('taxr_title')}</h3>

    <div class="tx-card">
      <span class="tx-label" id="txr-year-label">${t('taxr_title')}</span>
      <select id="txr-year" class="txr-select" onchange="taxrOnYearChange(this.value)">${yearOptions}</select>
    </div>

    <div class="tx-card">
      <span class="tx-label">${t('taxr_income_total')}</span>
      <div class="tx-breakdown-line"><span>${t('taxr_income_invoices')}</span><span class="v" id="txr-income-invoices">${money(yd.invIncome, 2)}</span></div>
      <div class="tx-breakdown-line"><span>${t('taxr_income_cash')}</span><span class="v" id="txr-income-cash">${money(yd.cashIncome, 2)}</span></div>
      <div class="tx-divider"></div>
      <div class="tx-breakdown-line"><span style="font-weight:800;">${t('taxr_income_total')}</span><span class="v" id="txr-income-total" style="font-weight:800;">${money(totalIncome, 2)}</span></div>
    </div>

    <div class="tx-card">
      <span class="tx-label">${t('taxr_category_label')}</span>
      <select id="txr-category" class="txr-select" onchange="taxrOnCategoryChange(this.value)">${catOptions}</select>
      <div class="tx-chip-row" style="margin-top:12px;">
        <button type="button" class="tx-chip${taxRollupState.deductMode === 'std' ? ' active' : ''}" id="txr-deduct-std" onclick="taxrOnDeductModeChange('std')">${t('taxr_deduct_std')}</button>
        <button type="button" class="tx-chip${taxRollupState.deductMode === 'actual' ? ' active' : ''}" id="txr-deduct-actual" onclick="taxrOnDeductModeChange('actual')">${t('taxr_deduct_actual')}</button>
      </div>
      <div class="tx-breakdown-line" style="margin-top:12px;"><span>${t('taxr_deduction')}</span><span class="v" id="txr-deduction">${money(deduction, 2)}</span></div>
    </div>

    <div class="tx-card">
      <span class="tx-label">${t('taxr_est_tax')}</span>
      <div class="tx-breakdown-line sub"><span>${t('taxr_allowance')}</span><span class="v neg" id="txr-allowance">− ${money(TAXR_ALLOWANCE, 2)}</span></div>
      <div class="tx-divider"></div>
      <div class="tx-breakdown-line"><span style="font-weight:800;">${t('taxr_net_income')}</span><span class="v" id="txr-net-income" style="font-weight:800;">${money(netIncome, 2)}</span></div>
      <div id="txr-bands" style="margin:6px 0;">${bandsHtml}</div>
      <div class="tx-divider"></div>
      <div class="tx-breakdown-line"><span>${t('taxr_est_tax')}</span><span class="v" id="txr-tax-total">${money(taxTotal, 2)}</span></div>
      <div class="tx-breakdown-line sub"><span>${t('taxr_wht_credit')}</span><span class="v neg" id="txr-wht-credit">− ${money(yd.whtCredit, 2)}</span></div>
      <p class="txr-hint" id="txr-tawi-hint">${t('taxr_tawi_hint').replace('{n}', yd.tawiReceived).replace('{m}', yd.tawiTotal)}</p>
      <div class="tx-divider"></div>
      <div class="tx-final"><span class="lbl" id="txr-net-result-label">${isRefund ? t('taxr_refund') : t('taxr_net_due')}</span><span class="amt" id="txr-net-result" style="color:${isRefund ? 'var(--paid)' : 'var(--brand)'}">${money(Math.abs(netResult), 2)}</span></div>
    </div>

    <div class="tx-card">
      <span class="tx-label">${t('taxr_deadlines')}</span>
      <div class="tx-row" style="align-items:flex-start;flex-direction:column;gap:2px;">
        <div style="display:flex;align-items:center;flex-wrap:wrap;width:100%;">
          <span class="tx-row-title" style="font-weight:700;">${t('taxr_due_94')}</span>${chip(daysLeft94, 'txr-chip-94')}
        </div>
        <span class="txr-hint" id="txr-due-94-date">${fmtDate(due94)} · e-file ${fmtDate(efile94)}</span>
      </div>
      <div class="tx-divider"></div>
      <div class="tx-row" style="align-items:flex-start;flex-direction:column;gap:2px;margin-top:10px;">
        <div style="display:flex;align-items:center;flex-wrap:wrap;width:100%;">
          <span class="tx-row-title" style="font-weight:700;">${t('taxr_due_90')}</span>${chip(daysLeft90, 'txr-chip-90')}
        </div>
        <span class="txr-hint" id="txr-due-90-date">${fmtDate(due90)} · e-file ${fmtDate(efile90)}</span>
      </div>
    </div>

    <div class="tx-card txr-disclaimer" id="txr-disclaimer">${t('taxr_disclaimer')}</div>
  `;
}
window.renderTaxRollup = renderTaxRollup;
