/* Sidekick — app/dataClient.js
 *
 * Phase 1 of the local-first -> backend migration. Deliberately a MIRROR,
 * not a replacement: local IndexedDB stays every registered account's one
 * source of truth for reads AND writes in this phase (exactly as it is for
 * guest mode, unchanged) — this file only pushes a best-effort copy of
 * `clients` writes to the new backend alongside the existing local write,
 * plus the one-time bulk upload of whatever already exists locally.
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
  async function session() {
    if (!getToken()) return { ok: false, status: 401, data: {} };
    return apiFetch('/api/auth-session');
  }
  function logout() { clearToken(); }
  function isEnabled() { return !!getToken(); }

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

  window.SidekickBackend = {
    isEnabled, register, login, session, logout, migrateUpload,
    mirrorClientSave, mirrorClientDelete,
  };
})();
