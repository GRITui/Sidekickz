// Sidekick — lib/crudHandler.js: the toParam() fix for the array/jsonb
// parameter bug found during the M1 live smoke test (2026-07-19).
//
// @neondatabase/serverless (like the `pg` driver it wraps) serializes a
// bare JS ARRAY parameter as a Postgres ARRAY LITERAL, not JSON — every
// embedded-array jsonb field this API stores (jobs' sub_tasks/options/
// items, invoices' line_items/payment_channels/slips, settings.value,
// order_requests.items, ...) broke on any real POST/PUT with a live
// Postgres connection, invisibly, because every OTHER test in this repo
// fakes `sql` and never exercises real driver parameter serialization.
// This suite exists specifically to catch a regression of that class of
// bug: it asserts the exact values `sql()` receives, not just that the
// call succeeded.
process.env.SESSION_SECRET = 'test-session-secret';

import { createResourceHandler, toParam } from '../lib/crudHandler.js';
import { signSession } from '../lib/auth.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── toParam() unit behavior ─────────────────────────────────────────────
assert(toParam(null) === null, 'null passes through unchanged');
assert(toParam(undefined) === undefined, 'undefined passes through unchanged (caller nullish-coalesces before calling)');
assert(toParam('hello') === 'hello', 'a string passes through unchanged');
assert(toParam(42) === 42, 'a number passes through unchanged');
assert(toParam(true) === true, 'a boolean passes through unchanged');
assert(toParam([1, 2, 3]) === '[1,2,3]', 'an array is JSON-stringified, not left as a bare array');
assert(toParam([{ a: 1 }, { b: 2 }]) === '[{"a":1},{"b":2}]', 'an array of objects is JSON-stringified');
assert(toParam({ a: 1 }) === '{"a":1}', 'a plain object is JSON-stringified too (defensively — the driver already handles this case, but one rule beats two)');
assert(toParam([]) === '[]', 'an empty array still gets stringified (not skipped as falsy)');

// ── End-to-end through createResourceHandler: assert what sql() actually receives ──
const calls = [];
async function fakeSql(text, params) {
  calls.push({ text, params });
  if (/select plan, subscription_status/.test(text)) {
    return [{ plan: 'pro', subscription_status: 'active', trial_ends_at: null }];
  }
  if (/^\s*insert into invoices/i.test(text)) {
    return [{ cuid: params[0], ...Object.fromEntries(FIELDS.map((f, i) => [f, params[i + 2]])) }];
  }
  if (/^\s*select \* from invoices/i.test(text)) return [];
  return [];
}
const FIELDS = ['number', 'line_items', 'payment_channels', 'client_pays'];
const handler = createResourceHandler('invoices', FIELDS, { getSql: () => fakeSql });

const token = await signSession({ userCuid: 'owner-1' }, process.env.SESSION_SECRET);
const lineItems = [{ description: 'Design work', qty: 2, unitPrice: 500 }];
const paymentChannels = [{ id: 'pp1', type: 'promptpay', label: 'PromptPay', detail: '0812345678' }];

const req = new Request('https://x/api/invoices', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ cuid: 'inv-1', number: 'INV-001', line_items: lineItems, payment_channels: paymentChannels, client_pays: 1000 }),
});
const res = await handler(req);
assert(res.status === 201, `POST with array-shaped jsonb fields succeeds (got ${res.status})`);

const insertCall = calls.find(c => /^\s*insert into invoices/i.test(c.text));
assert(!!insertCall, 'the insert statement was actually issued');
if (insertCall) {
  const lineItemsParam = insertCall.params[3]; // cuid, user_cuid, number, line_items, ...
  const paymentChannelsParam = insertCall.params[4];
  assert(typeof lineItemsParam === 'string', `line_items param sent to sql() is a JSON string, not a bare array (got ${typeof lineItemsParam})`);
  assert(lineItemsParam === JSON.stringify(lineItems), 'line_items param is exactly JSON.stringify(the array) — round-trips losslessly');
  assert(typeof paymentChannelsParam === 'string', `payment_channels param sent to sql() is a JSON string, not a bare array (got ${typeof paymentChannelsParam})`);
  assert(JSON.parse(lineItemsParam)[0].description === 'Design work', 'the stringified param parses back to the original data');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
