// Sidekick — LIVE deployment smoke test (M1 go-live gate).
//
// Runs the whole revenue loop against the real deployed API, end to end,
// printing PASS/FAIL per step. Zero dependencies — Node 18+ only (built-in
// fetch + WebCrypto). Run it from any machine that can reach the deployment
// (the Claude Code sandbox's egress policy can't, which is why this exists
// as a script rather than an agent-run check):
//
//   node tests/smoke-live.mjs                        # default target
//   node tests/smoke-live.mjs https://your.deploy    # explicit target
//
// What it does (and deliberately does NOT do):
//   - Registers ONE throwaway account (smoke_<timestamp>, random password) —
//     left behind on purpose; it's a 15-day-trial row with a handful of
//     smoke rows attached, harmless and identifiable by name.
//   - Creates a client, a product, an invoice; uploads a 1x1 slip via the
//     PUBLIC invoice page API; places a PUBLIC shop order and confirms it.
//   - Creates a Stripe Checkout SESSION (never completes it — nothing is
//     charged in any mode) to prove the Stripe wiring.
//   - Probes LINE Login start (expects the 302 to access.line.me — proves
//     the env quartet), cron-reminders arming, and admin-migrate gating,
//     without any secrets.
const BASE = (process.argv[2] || 'https://sidekickz.vercel.app').replace(/\/+$/, '');

let pass = 0, fail = 0, warn = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('PASS  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg + (extra ? ' — ' + extra : '')); }
};
const note = (msg) => { warn++; console.log('WARN  ' + msg); };

const j = async (res) => { try { return await res.json(); } catch { return null; } };
const api = (path, { method = 'GET', body, token, redirect } = {}) =>
  fetch(BASE + path, {
    method,
    redirect: redirect || 'follow',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

// Same PBKDF2-SHA256/100k/hex derivation app.js performs in the browser.
async function hashPassword(password, salt, iters) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iters }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const cuid = () => 'smk' + hex(11);

// A real, tiny JPEG data URL (1x1 white) — small enough to paste, big enough
// to satisfy the ^data:image\/(jpeg|png|webp);base64, validation.
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

(async () => {
  console.log(`\nSidekick live smoke → ${BASE}\n`);

  // ── 1. Register (proves: API up, DATABASE_URL, SESSION_SECRET, and the
  //       P5 auto-migrate cold-start path — this insert only works if the
  //       schema applied itself) ─────────────────────────────────────────
  const username = 'smoke_' + Date.now();
  const password = hex(12);
  const salt = hex(16), iters = 100000;
  const hash = await hashPassword(password, salt, iters);
  let res = await api('/api/auth-register', { method: 'POST', body: { username, salt, hash, iters, firstName: 'Smoke Test' } });
  let data = await j(res);
  // 201 Created is the API's real contract (see api/auth-register.js) — a
  // strict ===200 here was this script's own bug, not the API's.
  ok(res.status === 201 && data?.token && data?.user?.cuid, `register ${username} → 201 + session token`, `${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);
  if (!data?.token) { console.log('\nCannot continue without a session — fix the failure above first.'); process.exit(1); }
  const token = data.token, userCuid = data.user.cuid;

  // ── 2. Session check ──────────────────────────────────────────────────
  res = await api('/api/auth-session', { token });
  data = await j(res);
  ok(res.status === 200, 'auth-session accepts the token', `${res.status}`);

  // ── 3. Authed CRUD: client, product, invoice ─────────────────────────
  const clientCuid = cuid();
  res = await api('/api/clients', { method: 'POST', token, body: { cuid: clientCuid, name: 'Smoke Client', phone: '0800000000' } });
  ok(res.ok, 'create client (authed CRUD + plan gate lets a trial write)', `${res.status} ${JSON.stringify(await j(res))?.slice(0, 160)}`);

  const svcCuid = cuid();
  res = await api('/api/services', { method: 'POST', token, body: { cuid: svcCuid, name: 'Smoke Protein Pack', rate: 150, unit: 'pack', kind: 'product', sku: 'SMK-1', stock_qty: 5 } });
  ok(res.ok, 'create product (M3-L1 catalog columns live)', `${res.status}`);

  const invCuid = cuid();
  res = await api('/api/invoices', { method: 'POST', token, body: {
    cuid: invCuid, number: 'SMK-0001', issue_date: new Date().toISOString().slice(0, 10),
    client_name: 'Smoke Client', client_cuid: clientCuid, status: 'sent',
    line_items: [{ description: 'Smoke Protein Pack', qty: 2, unitPrice: 150 }],
    subtotal: 300, client_pays: 300, you_receive: 300,
    payment_channels: [{ id: 'smk', type: 'promptpay', label: 'PromptPay', detail: '0800000000' }],
  } });
  ok(res.ok, 'create invoice (slips/stock_decremented_at columns live)', `${res.status}`);

  // ── 4. PUBLIC invoice page API + client slip upload (M2b) ────────────
  res = await api('/api/invoice-public?i=' + invCuid);
  data = await j(res);
  ok(res.status === 200 && data?.number === 'SMK-0001' && data?.slipCount === 0 && data?.slips === undefined,
    'public invoice GET: whitelist shape, no slip images', `${res.status} ${JSON.stringify(data)?.slice(0, 160)}`);
  res = await api('/api/invoice-public', { method: 'POST', body: { i: invCuid, dataUrl: TINY_JPEG } });
  data = await j(res);
  ok(res.status === 200 && data?.slipCount === 1, 'public slip upload → slipCount 1', `${res.status} ${JSON.stringify(data)?.slice(0, 120)}`);
  res = await api('/api/invoice-public?i=' + hex(12));
  ok(res.status === 404, 'unknown invoice cuid → generic 404', `${res.status}`);

  // ── 5. PUBLIC storefront + order confirm (M3-L3) ─────────────────────
  res = await api('/api/shop-public?u=' + userCuid);
  data = await j(res);
  ok(res.status === 200 && Array.isArray(data?.products) && data.products.some(p => p.cuid === svcCuid),
    'public shop GET lists the product', `${res.status} ${JSON.stringify(data)?.slice(0, 160)}`);
  res = await api('/api/shop-public', { method: 'POST', body: { u: userCuid, name: 'Smoke Buyer', contact: 'line:smoke', items: [{ cuid: svcCuid, qty: 2 }] } });
  data = await j(res);
  ok(res.status === 200 && data?.ok, 'public shop order accepted (server reprices)', `${res.status} ${JSON.stringify(data)?.slice(0, 120)}`);
  res = await api('/api/order-requests', { token });
  data = await j(res);
  const order = Array.isArray(data?.requests) ? data.requests[0] : (Array.isArray(data) ? data[0] : null);
  ok(!!order, 'authed order-requests lists the pending order', `${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);
  if (order) {
    res = await api('/api/order-requests', { method: 'POST', token, body: { id: order.id, action: 'confirm' } });
    ok(res.ok, 'order confirm flips atomically', `${res.status}`);
    res = await api('/api/order-requests', { method: 'POST', token, body: { id: order.id, action: 'confirm' } });
    ok(res.status === 409, 'second confirm → 409 (race guard)', `${res.status}`);
  }

  // ── 6. Booking public read ───────────────────────────────────────────
  res = await api('/api/booking-availability?u=' + userCuid);
  ok(res.status === 200, 'public booking-availability responds', `${res.status}`);

  // ── 7. Stripe checkout session (created, never completed) ────────────
  res = await api('/api/billing-checkout', { method: 'POST', token, body: { plan: 'pro' } });
  data = await j(res);
  ok(res.status === 200 && typeof data?.url === 'string' && /stripe/.test(data.url),
    'billing-checkout returns a Stripe Checkout URL (nothing charged)', `${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);

  // ── 8. LINE Login quartet ────────────────────────────────────────────
  res = await api('/api/line-login-start', { redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  ok(res.status === 302 && loc.includes('access.line.me') && loc.includes('client_id='),
    'line-login-start 302s to access.line.me with a client_id (quartet set)', `${res.status} ${loc.slice(0, 120)}`);

  // ── 9. Cron + admin gating (no secrets used) ─────────────────────────
  res = await api('/api/cron-reminders');
  if (res.status === 403) ok(true, 'cron-reminders armed (403 without bearer = CRON_SECRET set)');
  else if (res.status === 404) note('cron-reminders answers 404 — CRON_SECRET is NOT set; reminders are off');
  else ok(false, 'cron-reminders gating', `unexpected ${res.status}`);
  res = await api('/api/admin-migrate');
  ok(res.status === 404 || res.status === 403, 'admin-migrate gated (404 unset / 403 token-armed)', `${res.status}`);

  // ── 10. Stripe webhook endpoint alive (rejects unsigned) ─────────────
  res = await api('/api/stripe-webhook', { method: 'POST', body: {} });
  ok(res.status >= 400 && res.status < 500, 'stripe-webhook rejects an unsigned POST (endpoint alive)', `${res.status}`);

  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
  console.log(`Throwaway account left behind: ${username} (identifiable, harmless).`);
  if (fail === 0) console.log('\nLive API smoke: GREEN. Remaining browser-only checks: LINE login tap-through, Stripe test-card checkout completion, and the PWA UI itself.');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('Smoke crashed:', e); process.exit(1); });
