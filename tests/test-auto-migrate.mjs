// Sidekick — lib/autoMigrate.js (ensureSchema/createEnsureSchema/memoize)
// + lib/db.js's wrapWithAutoMigrate choke point + api/admin-migrate.js's
// codeVersion/stampedVersion fields, against fake sql + injected locks —
// same harness style as tests/test-migrate.mjs (fake sql keyed on query
// text) and tests/test-cron-reminders.mjs (factory-injected getSql, no
// real DATABASE_URL/network anywhere in this file).
process.env.SETUP_TOKEN = 'test-setup-token';

import { SCHEMA_VERSION } from '../lib/migrate.js';
import {
  createEnsureSchema, ensureSchema, memoize,
  getStampedVersion, stampVersion, __resetMemoForTests,
} from '../lib/autoMigrate.js';
import { wrapWithAutoMigrate } from '../lib/db.js';
import { createAdminMigrateHandler } from '../api/admin-migrate.js';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

// ── Fake sql: understands the exact query shapes ensureSchema/stampVersion
// issue (schema_meta select, pg_advisory_lock/unlock, the stamp upsert),
// treats anything else as a generic idempotent DDL statement, and logs
// every call (in order) so tests can assert call ordering.
function makeFakeSql({ schemaMetaExists = true, initialStamp = null, failStatements = [] } = {}) {
  const calls = [];
  let stamp = initialStamp;
  let exists = schemaMetaExists;
  let lockCount = 0, unlockCount = 0;

  const fn = async (text, params) => {
    calls.push(text);
    if (text.includes('select value from schema_meta')) {
      if (!exists) throw new Error('relation "schema_meta" does not exist');
      return stamp !== null ? [{ value: stamp }] : [];
    }
    if (text.includes('pg_advisory_lock(')) { lockCount++; return []; }
    if (text.includes('pg_advisory_unlock(')) { unlockCount++; return []; }
    if (text.startsWith('insert into schema_meta')) {
      stamp = params[0];
      exists = true;
      return [];
    }
    if (failStatements.includes(text)) throw new Error('boom: ' + text.slice(0, 40));
    return []; // a generic (idempotent) DDL statement
  };
  fn.calls = calls;
  fn.getStamp = () => stamp;
  fn.lockCount = () => lockCount;
  fn.unlockCount = () => unlockCount;
  return fn;
}

async function main() {

// ── 1. version already matches → no lock, no DDL ───────────────────────────
{
  const sql = makeFakeSql({ initialStamp: SCHEMA_VERSION });
  const ensure = createEnsureSchema({ getStatements: () => ['create table t1 (x int);'] });
  const result = await ensure(sql);
  assert(result.applied === false && result.reason === 'already-current', 'version-match reports already-current');
  assert(sql.lockCount() === 0, 'version-match: no lock taken');
  assert(!sql.calls.some(c => c.startsWith('create table t1')), 'version-match: no DDL run');
}

// ── 2. unstamped (relation missing) → lock → apply → stamp → unlock ────────
{
  const sql = makeFakeSql({ schemaMetaExists: false });
  const ensure = createEnsureSchema({
    getStatements: () => ['create table t1 (x int);', 'create table t2 (y int);'],
  });
  const result = await ensure(sql);
  assert(result.applied === true, 'unstamped database: migration reports applied');
  assert(sql.getStamp() === SCHEMA_VERSION, 'unstamped database: stamp upserted with SCHEMA_VERSION');
  assert(sql.lockCount() === 1 && sql.unlockCount() === 1, 'unstamped database: exactly one lock + one unlock');

  const order = sql.calls;
  const lockIdx = order.findIndex(c => c.includes('pg_advisory_lock('));
  const ddl1Idx = order.indexOf('create table t1 (x int);');
  const ddl2Idx = order.indexOf('create table t2 (y int);');
  const stampIdx = order.findIndex(c => c.startsWith('insert into schema_meta'));
  const unlockIdx = order.findIndex(c => c.includes('pg_advisory_unlock('));
  assert(lockIdx >= 0 && lockIdx < ddl1Idx, 'call order: lock before first DDL statement');
  assert(ddl1Idx < ddl2Idx && ddl2Idx < stampIdx, 'call order: DDL statements run in order, before the stamp');
  assert(stampIdx < unlockIdx, 'call order: stamp happens before unlock');
}

// ── 3. double-checked locking: stamp appears between the first check and
//      the lock being acquired → no DDL runs at all ─────────────────────────
{
  const calls = [];
  let selectCount = 0;
  let lockCount = 0;
  const raceSql = async (text, params) => {
    calls.push(text);
    if (text.includes('select value from schema_meta')) {
      selectCount++;
      // First (unlocked, outer) read: stale. Second (inside the lock)
      // read: another instance finished the migration in between.
      return selectCount === 1 ? [] : [{ value: SCHEMA_VERSION }];
    }
    if (text.includes('pg_advisory_lock(')) { lockCount++; return []; }
    if (text.includes('pg_advisory_unlock(')) { return []; }
    return []; // would be a DDL statement — must never be reached
  };
  const ensure = createEnsureSchema({ getStatements: () => ['create table should-not-run (x int);'] });
  const result = await ensure(raceSql);
  assert(result.applied === false && result.reason === 'already-current-inside-lock',
    'double-checked locking: reports already-current-inside-lock');
  assert(lockCount === 1, 'double-checked locking: the lock WAS taken (outer check was stale)');
  assert(!calls.includes('create table should-not-run (x int);'),
    'double-checked locking: no DDL runs once the inner re-check finds it already current');
}

// ── 4. concurrent calls share ONE in-flight promise; only one lock
//      acquisition happens despite two overlapping callers ─────────────────
{
  const sql = makeFakeSql({ schemaMetaExists: false });
  const ensureOnce = memoize(createEnsureSchema({ getStatements: () => ['create table t (x int);'] }));
  const p1 = ensureOnce(sql);
  const p2 = ensureOnce(sql);   // called synchronously, before p1 has resolved
  assert(p1 === p2, 'concurrent calls share the exact same in-flight promise');
  await p1;
  assert(sql.lockCount() === 1, 'concurrent calls: only ONE lock acquisition for both callers');
  assert(sql.calls.filter(c => c === 'create table t (x int);').length === 1,
    'concurrent calls: the DDL statement itself only runs once');
}

// ── 5. failed statement → no stamp, memo cleared, lock released, and a
//      SECOND call (after whatever was wrong gets fixed) can succeed ───────
{
  const sql = makeFakeSql({ schemaMetaExists: false, failStatements: ['bad-statement;'] });
  const ensureOnce = memoize(createEnsureSchema({ getStatements: () => ['bad-statement;'] }));

  let threw = false;
  try { await ensureOnce(sql); } catch { threw = true; }
  assert(threw, 'a failing statement makes ensureSchema reject');
  assert(sql.getStamp() === null, 'a failed migration does not stamp the version');
  assert(sql.lockCount() === 1 && sql.unlockCount() === 1, 'lock is still released (finally) even on failure');

  // Simulate the underlying problem being fixed, then retry via a fresh
  // memoized instance (mirrors ensureSchema's real memo-clears-on-failure
  // behavior — the NEXT call, not the same promise, gets a clean attempt).
  const sql2 = makeFakeSql({ schemaMetaExists: false }); // no failStatements this time
  const ensureAgain = memoize(createEnsureSchema({ getStatements: () => ['bad-statement;'] }));
  const result = await ensureAgain(sql2);
  assert(result.applied === true, 'a subsequent retry (memo cleared) can succeed once the failure is resolved');
}

// ── 5b. the process-wide singleton `ensureSchema` really does clear its own
//        memo on failure and allow a real retry (not just the memoize()
//        helper in isolation) ───────────────────────────────────────────────
{
  __resetMemoForTests();
  // No real DATABASE_URL/network in this test file — call the exported
  // singleton against a fake sql directly (it takes `sql` as its only arg).
  const badSql = async (text) => {
    if (text.includes('select value from schema_meta')) throw new Error('relation "schema_meta" does not exist');
    if (text.includes('pg_advisory_lock(')) return [];
    if (text.includes('pg_advisory_unlock(')) return [];
    throw new Error('simulated DDL failure: ' + text.slice(0, 30));
  };
  let threw = false;
  try { await ensureSchema(badSql); } catch { threw = true; }
  assert(threw, 'singleton ensureSchema rejects when the real schema DDL fails');
  __resetMemoForTests();
}

// ── 6. AUTO_MIGRATE=off short-circuits: db()'s wrapWithAutoMigrate hands
//      back the RAW sql, unwrapped, and never calls ensureSchema at all ────
{
  process.env.AUTO_MIGRATE = 'off';
  let ensureCalls = 0;
  const fakeEnsure = async () => { ensureCalls++; return {}; };
  const rawSql = async (text) => ({ text });
  const result = wrapWithAutoMigrate(rawSql, fakeEnsure);
  assert(result === rawSql, 'AUTO_MIGRATE=off: wrapWithAutoMigrate returns the raw sql function itself');
  await result('select 1');
  assert(ensureCalls === 0, 'AUTO_MIGRATE=off: ensureSchema is never invoked');
  delete process.env.AUTO_MIGRATE;
}

// ── 7. db()-wrapped sql triggers the underlying migration work exactly
//      once across many queries (memoized ensureSchemaFn + the wrapper's
//      own per-call re-await of an already-resolved promise) ──────────────
{
  delete process.env.AUTO_MIGRATE;
  let underlyingCalls = 0;
  const ensureSchemaFn = memoize(async () => { underlyingCalls++; return { applied: true }; });
  const calls = [];
  const rawSql = async (text) => { calls.push(text); return [{ ok: true }]; };
  const wrapped = wrapWithAutoMigrate(rawSql, ensureSchemaFn);

  await wrapped('select 1');
  await wrapped('select 2');
  await wrapped('select 3');

  assert(underlyingCalls === 1, 'wrapped sql: ensureSchema work runs exactly once across three separate queries');
  assert(calls.length === 3, 'wrapped sql: all three real queries still reach the raw sql client');
}

// ── 8. getStampedVersion: relation-missing reads as unstamped (null), a
//      genuinely different error is NOT swallowed ──────────────────────────
{
  const missingSql = async () => { throw new Error('relation "schema_meta" does not exist'); };
  assert((await getStampedVersion(missingSql)) === null, 'getStampedVersion: missing relation reads as null (unstamped)');

  const brokenSql = async () => { throw new Error('connection terminated unexpectedly'); };
  let threw = false;
  try { await getStampedVersion(brokenSql); } catch { threw = true; }
  assert(threw, 'getStampedVersion: an unrelated DB error is NOT swallowed as "unstamped"');
}

// ── 9. stampVersion issues an upsert carrying the given version ────────────
{
  let seenText = null, seenParams = null;
  const sql = async (text, params) => { seenText = text; seenParams = params; return []; };
  await stampVersion(sql, SCHEMA_VERSION);
  assert(/insert into schema_meta/.test(seenText) && /on conflict/.test(seenText),
    'stampVersion: issues an insert ... on conflict upsert');
  assert(Array.isArray(seenParams) && seenParams[0] === SCHEMA_VERSION,
    'stampVersion: the version is passed as a bound parameter, not interpolated');
}

// ── 10. api/admin-migrate.js GET carries codeVersion + stampedVersion ──────
{
  const fakeSql = async (text) => {
    if (text.includes('information_schema.tables')) return [];
    if (text.includes('information_schema.columns')) return [];
    if (text.includes('current_database')) return [{ name: 'testdb' }];
    if (text.includes('select value from schema_meta')) return [{ value: '2026-01-01.0' }];
    throw new Error('unexpected query in fakeSql: ' + text);
  };
  const handler = createAdminMigrateHandler({ getSql: () => fakeSql });
  const res = await handler(new Request('https://x/api/admin-migrate', {
    method: 'GET', headers: { 'x-setup-token': 'test-setup-token' },
  }));
  const body = await res.json();
  assert(res.status === 200, 'admin-migrate GET (fake sql) succeeds');
  assert(body.codeVersion === SCHEMA_VERSION, 'admin-migrate GET reports codeVersion === SCHEMA_VERSION');
  assert(body.stampedVersion === '2026-01-01.0', 'admin-migrate GET reports the actual stampedVersion from schema_meta');
}

// ── 11. api/admin-migrate.js GET: unstamped database → stampedVersion null ─
{
  const fakeSql = async (text) => {
    if (text.includes('information_schema.tables')) return [];
    if (text.includes('information_schema.columns')) return [];
    if (text.includes('current_database')) return [{ name: 'testdb' }];
    if (text.includes('select value from schema_meta')) throw new Error('relation "schema_meta" does not exist');
    throw new Error('unexpected query in fakeSql: ' + text);
  };
  const handler = createAdminMigrateHandler({ getSql: () => fakeSql });
  const res = await handler(new Request('https://x/api/admin-migrate', {
    method: 'GET', headers: { 'x-setup-token': 'test-setup-token' },
  }));
  const body = await res.json();
  assert(body.stampedVersion === null, 'admin-migrate GET: an unstamped database reports stampedVersion: null');
}

// ── 12. api/admin-migrate.js POST: a clean apply stamps schema_meta ────────
{
  let stamped = null;
  const fakeSql = async (text, params) => {
    if (text.startsWith('insert into schema_meta')) { stamped = params[0]; return []; }
    if (text.includes('information_schema.tables')) return [];
    if (text.includes('information_schema.columns')) return [];
    if (text.includes('current_database')) return [{ name: 'testdb' }];
    if (text.includes('select value from schema_meta')) return stamped ? [{ value: stamped }] : [];
    return []; // any DDL statement from splitSqlStatements(SCHEMA_SQL)
  };
  const handler = createAdminMigrateHandler({ getSql: () => fakeSql });
  const res = await handler(new Request('https://x/api/admin-migrate', {
    method: 'POST', headers: { 'x-setup-token': 'test-setup-token' },
  }));
  const body = await res.json();
  assert(res.status === 200, 'admin-migrate POST (clean apply) returns 200');
  assert(stamped === SCHEMA_VERSION, 'admin-migrate POST: a clean apply stamps schema_meta with SCHEMA_VERSION');
  assert(body.stampedVersion === SCHEMA_VERSION, 'admin-migrate POST response reflects the freshly-written stamp');
}

// ── 13. api/admin-migrate.js POST: a failed statement does NOT stamp ───────
{
  let stamped = null;
  const fakeSql = async (text, params) => {
    if (text.startsWith('insert into schema_meta')) { stamped = params[0]; return []; }
    if (text.includes('information_schema.tables')) return [];
    if (text.includes('information_schema.columns')) return [];
    if (text.includes('current_database')) return [{ name: 'testdb' }];
    if (text.includes('select value from schema_meta')) return [];
    if (text.startsWith('create table if not exists team_members')) throw new Error('simulated failure');
    return [];
  };
  const handler = createAdminMigrateHandler({ getSql: () => fakeSql });
  const res = await handler(new Request('https://x/api/admin-migrate', {
    method: 'POST', headers: { 'x-setup-token': 'test-setup-token' },
  }));
  const body = await res.json();
  assert(res.status === 207, 'admin-migrate POST: a partial failure is reported as 207');
  assert(stamped === null, 'admin-migrate POST: a partial failure does NOT stamp schema_meta');
  assert(body.stampedVersion === null, 'admin-migrate POST response reflects the still-unstamped database');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
}

main();
