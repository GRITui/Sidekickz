/* Sidekick — app/dataClient.js
 *
 * Phase 1 of the local-first -> backend migration, extended in Phase 2b to
 * the 11 more stores Phase 2 fanned crudHandler out to server-side. Still
 * deliberately a MIRROR, not a replacement: local IndexedDB stays every
 * registered account's one source of truth for reads AND writes in this
 * phase (exactly as it is for guest mode, unchanged) — this file only
 * pushes a best-effort copy of writes to the new backend alongside the
 * existing local write, plus the one-time bulk upload of whatever already
 * exists locally (clients only, so far).
 *
 * Phase 2b's mirror calls are wired into each store's main Save/Delete
 * action only (saveJob/deleteJob, saveInvoice/deleteInvoice, ...) — NOT
 * into every granular in-place mutation a record can go through (a job's
 * Pipeline stage move, a milestone/sub-task/timer edit, a persona-tracker
 * field tweak on a client, ...). That's the same scope boundary Phase 1
 * already drew for `clients` (saveCustomer/deleteCustomer mirror; the
 * persona-tracker helpers that edit a client in place, e.g.
 * saveClientListItemField(), do not) — the mirror covers the record as it
 * stood at its last full save, not a live replica of every subsequent edit.
 *
 * Why mirror instead of cutting reads over now: every other IndexedDB
 * store (jobs, packages, progressLogs, ...) references a client by its
 * local autoincrement `id` (job.clientId, package.clientId, ...), not by
 * `cuid`. Making `clients` backend-authoritative in Phase 1 would mean
 * abandoning that local `id` as the addressing key everywhere it's
 * referenced — a much bigger, cross-store change than this slice is
 * scoped for. Mirroring by `cuid` (which every clients record already
 * carries) sidesteps that entirely: local `id` keeps meaning exactly what
 * it always has, for every store that isn't part of this migration yet.
 * Cutting `clients` reads over to the server is explicitly Phase 4, once
 * Phase 2/3 have fanned this same pattern out to the stores that reference
 * a client by id and migrated those references too.
 *
 * No build step, so this loads as a plain classic <script> (not a module)
 * — see index.html, loaded once before app.js. Exposes one global,
 * `SidekickBackend`, rather than free-floating function names, so it reads
 * clearly at every call site in app.js that this is the backend-mirror
 * layer, not another local helper.
 */
(function () {
  // Same-origin as the app in local dev (python http.server serving app/),
  // cross-origin (GitHub Pages -> Vercel) in production — see lib/cors.js
  // for the allowlist this API enforces on the other end. Overridable via
  // window.__SIDEKICK_API_BASE for tests/local dev against `vercel dev`.
  const API_BASE = window.__SIDEKICK_API_BASE || 'https://sidekickz.vercel.app';
  const TOKEN_KEY = 'sidekick_backend_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function apiFetch(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) return { ok: false, status: 401, data: { error: 'Not signed in to cloud backup' } };
      headers.authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method, headers, body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      return { ok: false, status: 0, data: { error: 'Network error — could not reach the cloud backup service' } };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  async function register({ username, salt, hash, iters, firstName }) {
    const r = await apiFetch('/api/auth-register', { method: 'POST', auth: false, body: { username, salt, hash, iters, firstName } });
    if (r.ok) setToken(r.data.token);
    return r;
  }
  async function login({ username, password }) {
    const r = await apiFetch('/api/auth-login', { method: 'POST', auth: false, body: { username, password } });
    if (r.ok) setToken(r.data.token);
    return r;
  }
  // LINE-authenticated accounts have no password — see api/auth-register-
  // line.js's header for why this is a separate call from register().
  async function registerLine(lineToken) {
    const r = await apiFetch('/api/auth-register-line', { method: 'POST', auth: false, body: { lineToken } });
    if (r.ok) setToken(r.data.token);
    return r;
  }
  async function session() {
    if (!getToken()) return { ok: false, status: 401, data: {} };
    return apiFetch('/api/auth-session');
  }
  function logout() { clearToken(); }
  function isEnabled() { return !!getToken(); }

  // ── Billing (Phase 0) ────────────────────────────────────────────────
  // Both just hand back a Stripe-hosted URL for the caller to redirect to
  // — see api/billing-checkout.js/api/billing-portal.js for why nothing
  // card-related is ever built or handled client-side here.
  async function billingCheckout(plan) {
    return apiFetch('/api/billing-checkout', { method: 'POST', body: { plan } });
  }
  async function billingPortal() {
    return apiFetch('/api/billing-portal', { method: 'POST' });
  }

  // ── LINE business connection + booking slots (generic multi-tenant) ────
  // See api/line-channel-connect.js/api/booking-slots.js — this account's
  // own LINE Official Account connection and the time windows it offers up
  // on its public booking page (app/book.html).
  async function lineChannelStatus() {
    return apiFetch('/api/line-channel-connect');
  }
  async function lineChannelConnect({ channelId, channelSecret, freelancerLineUserId }) {
    return apiFetch('/api/line-channel-connect', { method: 'POST', body: { channelId, channelSecret, freelancerLineUserId } });
  }
  async function lineChannelDisconnect() {
    return apiFetch('/api/line-channel-connect', { method: 'DELETE' });
  }
  async function bookingSlotsList() {
    return apiFetch('/api/booking-slots');
  }
  async function bookingSlotCreate({ startsAt, endsAt }) {
    return apiFetch('/api/booking-slots', { method: 'POST', body: { startsAt, endsAt } });
  }
  async function bookingSlotDelete(id) {
    return apiFetch(`/api/booking-slots?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ── Team (Phase 2) ──────────────────────────────────────────────────────
  // See api/team-invite.js/api/team-join.js/api/team-members.js — a Team
  // plan's shared-single-identity org: the owner's own data, with other
  // accounts (admin/staff) granted access to it.
  async function teamCheckout(seats) {
    return apiFetch('/api/billing-checkout', { method: 'POST', body: { plan: 'team', seats } });
  }
  async function teamInvite(role) {
    return apiFetch('/api/team-invite', { method: 'POST', body: { role } });
  }
  async function teamJoin(token) {
    return apiFetch('/api/team-join', { method: 'POST', body: { token } });
  }
  async function teamMembersList() {
    return apiFetch('/api/team-members');
  }
  async function teamMemberRemove(memberCuid) {
    return apiFetch(`/api/team-members?memberCuid=${encodeURIComponent(memberCuid)}`, { method: 'DELETE' });
  }

  // ── clients mirror ────────────────────────────────────────────────────
  // Always tries create first; a 409 (this cuid already exists server-side
  // — e.g. this record was already uploaded, or already mirrored from a
  // previous save) falls back to an update. Fire-and-forget from the
  // caller's point of view: local IndexedDB is already the write of
  // record by the time this runs, so a failure here just means this one
  // record's cloud copy is stale until the next save or the next full
  // migrateUpload() — it never blocks or reverts the local save.
  function toClientPayload(c) {
    return {
      cuid: c.cuid, name: c.name, phone: c.phone, email: c.email, tags: c.tags,
      notes: c.notes, tax_id: c.taxId, billing_address: c.billingAddress, member_no: c.memberNo,
    };
  }
  async function mirrorClientSave(c) {
    if (!isEnabled() || !c.cuid) return;
    const payload = toClientPayload(c);
    const created = await apiFetch('/api/clients', { method: 'POST', body: payload });
    if (created.ok || created.status !== 409) return;
    await apiFetch(`/api/clients?cuid=${encodeURIComponent(c.cuid)}`, { method: 'PUT', body: payload });
  }
  async function mirrorClientDelete(cuid) {
    if (!isEnabled() || !cuid) return;
    await apiFetch(`/api/clients?cuid=${encodeURIComponent(cuid)}`, { method: 'DELETE' });
  }

  // ── one-time bulk upload (existing local data, or a guest converting) ──
  async function migrateUpload(clients) {
    return apiFetch('/api/migrate-upload', { method: 'POST', body: { clients: clients.map(toClientPayload) } });
  }

  // ── Phase 2b: mirror wiring for the 11 stores Phase 2 fanned crudHandler
  // out to (schema + API only, no client-side wiring) ───────────────────
  // Same create-then-fallback-to-update shape as mirrorClientSave/
  // mirrorClientDelete above, generalized so each of the 9 more cuid-keyed
  // stores below doesn't hand-roll the same fetch dance. `packages` gets a
  // save mirror even though nothing in app.js currently deletes a package
  // (no delete call site exists yet) — for parity/future use, harmless
  // either way since mirrorDelete is simply never called for it today.
  function createMirror(apiPath, toPayload) {
    async function mirrorSave(record) {
      if (!isEnabled() || !record || !record.cuid) return;
      const payload = toPayload(record);
      const created = await apiFetch(`/api/${apiPath}`, { method: 'POST', body: payload });
      if (created.ok || created.status !== 409) return;
      await apiFetch(`/api/${apiPath}?cuid=${encodeURIComponent(record.cuid)}`, { method: 'PUT', body: payload });
    }
    async function mirrorDelete(recordCuid) {
      if (!isEnabled() || !recordCuid) return;
      await apiFetch(`/api/${apiPath}?cuid=${encodeURIComponent(recordCuid)}`, { method: 'DELETE' });
    }
    return { mirrorSave, mirrorDelete };
  }

  const jobsMirror = createMirror('jobs', j => ({
    cuid: j.cuid, date: j.date, client_name: j.client, client_id: j.clientId,
    service_id: j.serviceId, service_name: j.serviceName, job_type: j.jobType,
    amount: j.amount, tip: j.tip, expense: j.expense, count: j.count, notes: j.notes,
    net_amount: j.netAmount, stage_order: j.stageOrder, stage: j.stage, complete: j.complete,
    invoice_id: j.invoiceId, quote_doc_id: j.quoteDocId, package_id: j.packageId,
    sub_tasks: j.subTasks, milestones: j.milestones, time_entries: j.timeEntries,
    timer_started_at: j.timerStartedAt,
  }));

  const servicesMirror = createMirror('services', s => ({
    cuid: s.cuid, name: s.name, rate: s.rate, unit: s.unit, usage_qty: s.usageQty,
  }));

  const invoicesMirror = createMirror('invoices', i => ({
    cuid: i.cuid, number: i.number, issue_date: i.issueDate, due_date: i.dueDate,
    client_id: i.clientId, client_name: i.clientName, client_tax_id: i.clientTaxId,
    client_address: i.clientAddress, line_items: i.lineItems, subtotal: i.subtotal,
    wht_pct: i.whtPct, vat_pct: i.vatPct, vat: i.vat, wht: i.wht,
    client_pays: i.clientPays, you_receive: i.youReceive, deposit_pct: i.depositPct,
    status: i.status, payment_channels: i.paymentChannels, notes: i.notes,
  }));

  const documentsMirror = createMirror('documents', d => ({
    cuid: d.cuid, type: d.type, title: d.title, client_id: d.clientId,
    client_name: d.clientName, invoice_id: d.invoiceId, fields: d.fields,
    content: d.content, number: d.number, issue_date: d.issueDate,
  }));

  // Local IndexedDB store is still named 'bookings' (app/bookings.js) — the
  // api-path/table rename to app_bookings/app-bookings.js is a backend-only
  // detail to avoid colliding with the LINE pilot's own `bookings` table
  // (see sql/schema-core.sql), not something the client needs to know about.
  const bookingsMirror = createMirror('app-bookings', b => ({
    cuid: b.cuid, customer_id: b.customerId, title: b.title, date: b.date,
    start_time: b.startTime, duration_min: b.durationMin, travel_buffer_min: b.travelBufferMin,
    location: b.location, notes: b.notes, status: b.status,
    job_cuid: b.jobCuid,
  }));

  const followupsMirror = createMirror('followups', f => ({
    cuid: f.cuid, key: f.key, dismissed: f.dismissed, snoozed_until: f.snoozedUntil,
  }));

  // Local field is `order` (app/portfolio.js), not `orderIndex` — mapped to
  // the schema's `order_index` column name here, at the boundary.
  const portfolioMirror = createMirror('portfolio', p => ({
    cuid: p.cuid, title: p.title, description: p.description, tags: p.tags,
    image_data_url: p.imageDataUrl, order_index: p.order,
  }));

  const researchMirror = createMirror('research', r => ({
    cuid: r.cuid, title: r.title, category: r.category, body: r.body, is_premium: r.isPremium,
  }));

  const packagesMirror = createMirror('packages', p => ({
    cuid: p.cuid, client_id: p.clientId, total_sessions: p.totalSessions, price: p.price,
    purchased_date: p.purchasedDate, expires_at: p.expiresAt, notes: p.notes,
  }));

  const progressLogsMirror = createMirror('progress-logs', p => ({
    cuid: p.cuid, client_id: p.clientId, date: p.date, weight: p.weight, notes: p.notes,
  }));

  // Bespoke, not createMirror(): api/settings.js's row key is (user_cuid,
  // key), no cuid at all (see that file's own header for why). The local
  // IndexedDB 'settings' store multiplexes every local account's rows in
  // one store via a uid-prefixed key (e.g. 'guest:lang' or '3:lang') — the
  // server row is already scoped per-account by the bearer session, so the
  // prefix is stripped before mirroring rather than sent verbatim.
  async function mirrorSettingSave(prefixedKey, value) {
    if (!isEnabled()) return;
    const sep = prefixedKey.indexOf(':');
    const bareKey = sep >= 0 ? prefixedKey.slice(sep + 1) : prefixedKey;
    await apiFetch(`/api/settings?key=${encodeURIComponent(bareKey)}`, { method: 'PUT', body: { value } });
  }

  window.SidekickBackend = {
    isEnabled, register, login, registerLine, session, logout, migrateUpload,
    billingCheckout, billingPortal,
    lineChannelStatus, lineChannelConnect, lineChannelDisconnect,
    bookingSlotsList, bookingSlotCreate, bookingSlotDelete,
    teamCheckout, teamInvite, teamJoin, teamMembersList, teamMemberRemove,
    mirrorClientSave, mirrorClientDelete,
    mirrorJobSave: jobsMirror.mirrorSave, mirrorJobDelete: jobsMirror.mirrorDelete,
    mirrorServiceSave: servicesMirror.mirrorSave, mirrorServiceDelete: servicesMirror.mirrorDelete,
    mirrorInvoiceSave: invoicesMirror.mirrorSave, mirrorInvoiceDelete: invoicesMirror.mirrorDelete,
    mirrorDocumentSave: documentsMirror.mirrorSave, mirrorDocumentDelete: documentsMirror.mirrorDelete,
    mirrorBookingSave: bookingsMirror.mirrorSave, mirrorBookingDelete: bookingsMirror.mirrorDelete,
    mirrorFollowupSave: followupsMirror.mirrorSave,
    mirrorPortfolioSave: portfolioMirror.mirrorSave, mirrorPortfolioDelete: portfolioMirror.mirrorDelete,
    mirrorResearchSave: researchMirror.mirrorSave, mirrorResearchDelete: researchMirror.mirrorDelete,
    mirrorPackageSave: packagesMirror.mirrorSave,
    mirrorProgressLogSave: progressLogsMirror.mirrorSave, mirrorProgressLogDelete: progressLogsMirror.mirrorDelete,
    mirrorSettingSave,
  };
})();
