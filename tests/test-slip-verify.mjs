// Sidekick — M4 Pass P2: lib/slipVerify.js's provider registry + adapter,
// and api/slip-verify.js's authenticated handler, against an in-memory fake
// sql (same style as tests/test-booking-confirm.mjs) and a stubbed
// globalThis.fetch (for the slipok adapter itself). Auth faked the same way
// test-booking-confirm.mjs does — a real signSession() token, checked by the
// real requireSession().
process.env.SESSION_SECRET = 'test-session-secret';

import { signSession } from '../lib/auth.js';
import { verifySlip } from '../lib/slipVerify.js';
import { createSlipVerifyHandler } from '../api/slip-verify.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const SECRET_KEY = 'sk_super_secret_do_not_leak_12345';
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ════════════════════════════════════════════════════════════════════════
//  lib/slipVerify.js — registry + slipok adapter
// ════════════════════════════════════════════════════════════════════════
async function testRegistry() {
  // ── Unknown provider never calls fetch, fails closed ───────────────────
  let fetchCalled = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  const r = await verifySlip({ provider: 'nonsense', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL });
  assert(r.status === 'error' && r.message === 'unknown provider', 'unknown provider -> {status:error, message:"unknown provider"}, got ' + JSON.stringify(r));
  assert(!fetchCalled, 'unknown provider never calls fetch');
  assert(!JSON.stringify(r).includes(SECRET_KEY), 'unknown-provider result never carries the apiKey');
  globalThis.fetch = savedFetch;
}

async function testSlipOkAdapter() {
  const savedFetch = globalThis.fetch;
  let lastUrl, lastOpts;
  function stub(responseBody, status) {
    globalThis.fetch = async (url, opts) => {
      lastUrl = url; lastOpts = opts;
      return {
        ok: (status || 200) < 400,
        status: status || 200,
        json: async () => responseBody,
      };
    };
  }

  // ── verified: success:true maps amount/ref/sender, request shape correct ─
  stub({ success: true, data: { amount: 1070, transRef: 'TRX123', sender: 'Somchai' } });
  let r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'branch-9', dataUrl: PNG_DATA_URL, expectedAmount: 1070 });
  assert(r.status === 'verified' && r.amount === 1070 && r.ref === 'TRX123' && r.sender === 'Somchai',
    'success:true -> verified with amount/ref/sender, got ' + JSON.stringify(r));
  assert(String(lastUrl).includes('/api/line/apikey/branch-9'), 'POSTs to the branch-scoped SlipOK URL, got ' + lastUrl);
  assert(lastOpts.method === 'POST', 'request is a POST');
  assert(lastOpts.headers && lastOpts.headers['x-authorization'] === SECRET_KEY, 'x-authorization header carries the raw apiKey, got ' + JSON.stringify(lastOpts.headers));
  assert(lastOpts.body instanceof FormData, 'body is multipart FormData, not JSON');
  assert(lastOpts.body.get('amount') === '1070', 'form carries the expectedAmount, got ' + lastOpts.body.get('amount'));
  const filesEntry = lastOpts.body.get('files');
  assert(filesEntry && typeof filesEntry === 'object' && filesEntry.size > 0, 'form carries the decoded image under "files", got ' + filesEntry);
  assert(!JSON.stringify(r).includes(SECRET_KEY), 'verified result never carries the apiKey');

  // ── amount omitted when expectedAmount is not provided ─────────────────
  stub({ success: true, data: { amount: 500 } });
  await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL });
  assert(lastOpts.body.get('amount') === null, 'no expectedAmount -> no amount field sent, got ' + lastOpts.body.get('amount'));

  // ── mismatch: code 1013 ─────────────────────────────────────────────────
  stub({ success: false, code: 1013, message: 'amount mismatch', data: { amount: 999 } }, 400);
  r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL, expectedAmount: 1070 });
  assert(r.status === 'mismatch' && r.amount === 999, 'code 1013 -> mismatch with the slip\'s own amount, got ' + JSON.stringify(r));

  // ── duplicate: code 1012 ────────────────────────────────────────────────
  stub({ success: false, code: 1012, message: 'duplicate slip' }, 400);
  r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL });
  assert(r.status === 'duplicate', 'code 1012 -> duplicate, got ' + JSON.stringify(r));

  // ── invalid: some other success:false ───────────────────────────────────
  stub({ success: false, code: 1099, message: 'could not read QR' }, 400);
  r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL });
  assert(r.status === 'invalid' && r.message === 'could not read QR', 'other success:false -> invalid, carries message, got ' + JSON.stringify(r));

  // ── network failure -> error, never throws ──────────────────────────────
  globalThis.fetch = async () => { throw new Error('network down, key=' + SECRET_KEY); };
  r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL });
  assert(r.status === 'error', 'network failure -> {status:error}, got ' + JSON.stringify(r));
  assert(!JSON.stringify(r).includes(SECRET_KEY), 'network-error result never leaks the apiKey (or any thrown message)');

  // ── malformed JSON response -> error ────────────────────────────────────
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: PNG_DATA_URL });
  assert(r.status === 'error', 'unparsable response body -> {status:error}, got ' + JSON.stringify(r));

  // ── bad dataUrl -> error, never even calls fetch ────────────────────────
  let calledOnBadUrl = false;
  globalThis.fetch = async () => { calledOnBadUrl = true; return { ok: true, json: async () => ({}) }; };
  r = await verifySlip({ provider: 'slipok', apiKey: SECRET_KEY, branchId: 'b1', dataUrl: 'not-a-data-url' });
  assert(r.status === 'error', 'malformed dataUrl -> {status:error}, got ' + JSON.stringify(r));
  assert(!calledOnBadUrl, 'malformed dataUrl never reaches fetch');

  globalThis.fetch = savedFetch;
}

// ════════════════════════════════════════════════════════════════════════
//  api/slip-verify.js — authenticated handler against a fake sql
// ════════════════════════════════════════════════════════════════════════
let users, invoices, teamMembers;
function resetDb() {
  users = [{ cuid: 'owner-1', plan: 'pro', subscription_status: 'active', trial_ends_at: null }];
  invoices = [
    {
      cuid: 'inv-1', user_cuid: 'owner-1', client_pays: 1070,
      slips: [
        { id: 'slip-1', dataUrl: PNG_DATA_URL, at: '2026-07-01T00:00:00Z', source: 'client' },
        { id: 'slip-2', dataUrl: PNG_DATA_URL, at: '2026-07-02T00:00:00Z', source: 'client' },
      ],
    },
    { cuid: 'inv-other-owner', user_cuid: 'owner-2', client_pays: 500, slips: [{ id: 'slip-x', dataUrl: PNG_DATA_URL, at: '2026-07-01T00:00:00Z' }] },
  ];
  teamMembers = [];
}

function fakeSql(text, params) {
  const t = text;
  const p = params || [];
  if (t.includes('from team_members where member_cuid')) {
    const row = teamMembers.find(m => m.member_cuid === p[0]);
    return Promise.resolve(row ? [{ org_owner_cuid: row.org_owner_cuid }] : []);
  }
  if (t.includes('select plan, subscription_status, trial_ends_at from users')) {
    return Promise.resolve(users.filter(u => u.cuid === p[0]));
  }
  if (t.includes('select cuid, client_pays, slips from invoices')) {
    const inv = invoices.find(i => i.cuid === p[0] && i.user_cuid === p[1]);
    return Promise.resolve(inv ? [{ cuid: inv.cuid, client_pays: inv.client_pays, slips: inv.slips }] : []);
  }
  if (t.includes('update invoices set slips')) {
    const inv = invoices.find(i => i.cuid === p[1]);
    if (inv) inv.slips = p[0];
    return Promise.resolve([]);
  }
  throw new Error('unexpected query in fakeSql: ' + t);
}

async function call(handler, body, token, extraHeaders) {
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request('https://x/api/slip-verify', {
    method: 'POST', headers, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req);
  const text = await res.text();
  return { status: res.status, text, data: text ? JSON.parse(text) : null };
}

async function testHandler() {
  const token = await signSession({ userCuid: 'owner-1' }, process.env.SESSION_SECRET);
  const staffToken = await signSession({ userCuid: 'staff-1' }, process.env.SESSION_SECRET);

  const fakeVerify = async ({ provider, apiKey, branchId, dataUrl, expectedAmount }) => {
    fakeVerify.lastCall = { provider, apiKey, branchId, dataUrl, expectedAmount };
    return { status: 'verified', amount: expectedAmount, ref: 'TRX-1', sender: 'Somchai' };
  };
  const handler = createSlipVerifyHandler({ getSql: () => fakeSql, verify: fakeVerify });

  // ── No session -> 401 ────────────────────────────────────────────────
  resetDb();
  let r = await call(handler, { invoiceCuid: 'inv-1', slipId: 'slip-1', provider: 'slipok', apiKey: 'k', branchId: 'b' }, 'not-a-token', { 'x-forwarded-for': '5.5.5.1' });
  assert(r.status === 401, 'no valid session -> 401, got ' + r.status);

  // ── Missing fields -> 400 ────────────────────────────────────────────
  r = await call(handler, { invoiceCuid: 'inv-1' }, token, { 'x-forwarded-for': '5.5.5.2' });
  assert(r.status === 400, 'missing slipId/provider/apiKey/branchId -> 400, got ' + r.status);

  // ── Happy path: verify() is called with expectedAmount = client_pays,
  //    slip written with a verify field, apiKey never echoed back ────────
  r = await call(handler, { invoiceCuid: 'inv-1', slipId: 'slip-1', provider: 'slipok', apiKey: SECRET_KEY, branchId: 'branch-9' }, token, { 'x-forwarded-for': '5.5.5.3' });
  assert(r.status === 200 && r.data.ok === true, 'happy path -> 200 ok, got ' + r.status + ' ' + r.text);
  assert(fakeVerify.lastCall.expectedAmount === 1070, 'verify() called with expectedAmount = invoice.client_pays, got ' + fakeVerify.lastCall.expectedAmount);
  assert(fakeVerify.lastCall.provider === 'slipok' && fakeVerify.lastCall.branchId === 'branch-9', 'verify() called with provider/branchId from the request body');
  assert(fakeVerify.lastCall.dataUrl === PNG_DATA_URL, 'verify() called with the matching slip\'s own dataUrl');
  assert(r.data.verify && r.data.verify.status === 'verified' && r.data.verify.amount === 1070 && r.data.verify.ref === 'TRX-1' && r.data.verify.at,
    'response carries the verify result shape {status, amount, ref, at}, got ' + JSON.stringify(r.data.verify));
  assert(!r.text.includes(SECRET_KEY), 'response body never echoes the apiKey back');
  const storedSlip = invoices.find(i => i.cuid === 'inv-1').slips.find(s => s.id === 'slip-1');
  assert(storedSlip.verify && storedSlip.verify.status === 'verified', 'the matching slip entry is written with the verify field, got ' + JSON.stringify(storedSlip));
  const otherSlip = invoices.find(i => i.cuid === 'inv-1').slips.find(s => s.id === 'slip-2');
  assert(!otherSlip.verify, 'the OTHER slip on the same invoice is left untouched, got ' + JSON.stringify(otherSlip));

  // ── Wrong owner: a session for owner-1 can't touch owner-2's invoice ───
  r = await call(handler, { invoiceCuid: 'inv-other-owner', slipId: 'slip-x', provider: 'slipok', apiKey: 'k', branchId: 'b' }, token, { 'x-forwarded-for': '5.5.5.4' });
  assert(r.status === 404, 'invoice belonging to another owner -> 404, got ' + r.status);

  // ── Unknown invoice cuid -> 404 ──────────────────────────────────────
  r = await call(handler, { invoiceCuid: 'does-not-exist', slipId: 'slip-1', provider: 'slipok', apiKey: 'k', branchId: 'b' }, token, { 'x-forwarded-for': '5.5.5.5' });
  assert(r.status === 404, 'unknown invoice cuid -> 404, got ' + r.status);

  // ── Unknown slip id on a real invoice -> 404 ─────────────────────────
  r = await call(handler, { invoiceCuid: 'inv-1', slipId: 'does-not-exist', provider: 'slipok', apiKey: 'k', branchId: 'b' }, token, { 'x-forwarded-for': '5.5.5.6' });
  assert(r.status === 404, 'unknown slip id -> 404, got ' + r.status);

  // ── Team member resolves to the owner's invoice ──────────────────────
  resetDb();
  teamMembers = [{ org_owner_cuid: 'owner-1', member_cuid: 'staff-1' }];
  r = await call(handler, { invoiceCuid: 'inv-1', slipId: 'slip-1', provider: 'slipok', apiKey: 'k', branchId: 'b' }, staffToken, { 'x-forwarded-for': '5.5.5.7' });
  assert(r.status === 200, 'staff resolves to the owner\'s invoice (resolveDataOwner), got ' + r.status + ' ' + r.text);

  // ── Locked account blocks writes ─────────────────────────────────────
  resetDb();
  users[0].subscription_status = 'canceled';
  r = await call(handler, { invoiceCuid: 'inv-1', slipId: 'slip-1', provider: 'slipok', apiKey: 'k', branchId: 'b' }, token, { 'x-forwarded-for': '5.5.5.8' });
  assert(r.status === 402 && r.data.code === 'locked', 'locked account -> 402 locked, got ' + r.status + ' ' + r.text);

  // ── GET not allowed ───────────────────────────────────────────────────
  resetDb();
  const getReq = new Request('https://x/api/slip-verify', { method: 'GET', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '5.5.5.9' } });
  const getRes = await handler(getReq);
  assert(getRes.status === 405, 'GET -> 405, got ' + getRes.status);

  // ── Rate limit: 10/min per IP, 11th request in the window -> 429 ─────
  resetDb();
  const rlIp = '6.6.6.1';
  let last;
  for (let i = 0; i < 10; i++) {
    last = await call(handler, { invoiceCuid: 'inv-1', slipId: 'slip-1', provider: 'slipok', apiKey: 'k', branchId: 'b' }, token, { 'x-forwarded-for': rlIp });
  }
  assert(last.status === 200, '10th request within the window still succeeds, got ' + last.status);
  const eleventh = await call(handler, { invoiceCuid: 'inv-1', slipId: 'slip-1', provider: 'slipok', apiKey: 'k', branchId: 'b' }, token, { 'x-forwarded-for': rlIp });
  assert(eleventh.status === 429 && eleventh.data.code === 'rate_limited', '11th request within the window -> 429 rate_limited, got ' + eleventh.status + ' ' + eleventh.text);
}

async function main() {
  await testRegistry();
  await testSlipOkAdapter();
  await testHandler();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
