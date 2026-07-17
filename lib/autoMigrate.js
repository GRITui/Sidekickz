/* Sidekick — lib/autoMigrate.js
 *
 * P5 Phase 1: auto-migrate on cold start. After this ships, merging a PR IS
 * the migration — the first request any Edge isolate serves after a deploy
 * applies sql/schema-core.sql itself, through the exact same connection
 * every handler already gets from db() (lib/db.js wraps it — see there).
 * api/admin-migrate.js (SETUP_TOKEN + x-setup-token) becomes an optional
 * manual fallback/status view, not the primary path — see its own header.
 *
 * ── Lock choice: pg_advisory_lock (session) vs pg_advisory_xact_lock ──────
 * lib/db.js's db() is built on @neondatabase/serverless's neon() — its own
 * type declarations describe it as running "a single SQL query (no session
 * or transactions)" per call, and lib/migrate.js's header independently
 * notes the same thing ("Neon's HTTP driver executes ONE statement per
 * call"). That means a *session*-scoped pg_advisory_lock taken in one
 * sql() call has no guaranteed session affinity with whatever backend
 * connection a later, separate sql() call happens to land on — the driver
 * makes no promise the lock is still held by the time the next call runs.
 *
 * The driver's one real multi-statement primitive, sql.transaction(), DOES
 * bundle queries into a single actual Postgres transaction — the variant
 * that would reliably hold pg_advisory_xact_lock across statements. But
 * Neon documents it as *non-interactive*: the array of queries is fixed
 * upfront, with no way to read one query's result and decide, in JS,
 * whether to include the next. That rules it out for this flow specifically
 * — double-checked locking (re-read the stamp only once the lock is held,
 * branch on it) and reuse of lib/migrate.js's runMigration (whose contract
 * is "catch each statement's error and keep going," which a single
 * server-side transaction can't do — one aborted statement poisons the
 * rest of that same transaction) both need real interactivity.
 *
 * Given that trade-off, this file uses the SESSION lock as a best-effort
 * throttle, not a correctness requirement: every statement in
 * sql/schema-core.sql is `create/alter ... if not exists`, and the version
 * stamp write below is an upsert — so even a missed or doubly-acquired
 * lock (two isolates racing the migration seconds apart, right after a
 * deploy) converges to the identical correct end state. A held lock only
 * trims that rare, cheap duplicate work; it is not what keeps the database
 * correct — idempotency is.
 */
import { SCHEMA_SQL } from './schemaSql.js';
import { SCHEMA_VERSION, splitSqlStatements, runMigration } from './migrate.js';

const LOCK_SQL = `select pg_advisory_lock(hashtext('sidekick_schema'))`;
const UNLOCK_SQL = `select pg_advisory_unlock(hashtext('sidekick_schema'))`;

// Exported so api/admin-migrate.js's GET status view can report
// `stampedVersion` without duplicating this relation-may-not-exist-yet
// handling.
export async function getStampedVersion(sql) {
  try {
    const rows = await sql(`select value from schema_meta where key = 'version'`);
    return rows[0] ? rows[0].value : null;
  } catch (err) {
    // A pre-Phase-1 database (or a brand-new one, mid-migration) simply
    // doesn't have schema_meta yet — that reads as "unstamped," not a
    // failure worth surfacing.
    if (/relation .* does not exist/i.test(err.message)) return null;
    throw err;
  }
}

// Exported so api/admin-migrate.js's POST can stamp on a successful manual
// apply too (same convention, same table, same upsert).
export async function stampVersion(sql, version) {
  await sql(
    `insert into schema_meta (key, value) values ('version', $1)
     on conflict (key) do update set value = excluded.value`,
    [version]
  );
}

async function defaultLockFn(sql, criticalSectionFn) {
  await sql(LOCK_SQL);
  try {
    return await criticalSectionFn();
  } finally {
    // Best-effort unlock (see file header): if this call lands on a
    // different backend connection than the one that acquired the lock,
    // this is a harmless no-op against whatever session it does hit.
    await sql(UNLOCK_SQL).catch(() => {});
  }
}

// createEnsureSchema({ getStatements, lockFn }) — the testable factory.
// Both params are injectable seams: `getStatements()` swaps in a fake
// statement list (no need for a real schema file in tests), `lockFn(sql,
// criticalSectionFn)` swaps in a fake lock (no need for a real advisory
// lock / real concurrency in tests). The production `ensureSchema` export
// below is just this factory called with its real defaults.
export function createEnsureSchema({ getStatements, lockFn } = {}) {
  const statementsFn = getStatements || (() => splitSqlStatements(SCHEMA_SQL));
  const lock = lockFn || defaultLockFn;

  return async function ensureSchemaImpl(sql) {
    const before = await getStampedVersion(sql);
    if (before === SCHEMA_VERSION) {
      return { applied: false, reason: 'already-current' };
    }

    return lock(sql, async () => {
      // Double-checked locking: another isolate/request may have finished
      // the migration in the window between our unlocked read above and
      // actually acquiring the lock. Re-read now that we hold it.
      const inside = await getStampedVersion(sql);
      if (inside === SCHEMA_VERSION) {
        return { applied: false, reason: 'already-current-inside-lock' };
      }

      const statements = statementsFn();
      const result = await runMigration(sql, statements);
      if (result.errors.length) {
        // Do NOT stamp on a partial/failed apply — the next request (in
        // this isolate or another) must see the database as still stale
        // and retry, not skip straight past a real problem.
        throw new Error(
          `auto-migrate: ${result.errors.length} of ${result.total} statement(s) failed ` +
          `(first: ${JSON.stringify(result.errors[0])})`
        );
      }
      await stampVersion(sql, SCHEMA_VERSION);
      return { applied: true, applied_count: result.applied, total: result.total };
    });
  };
}

// ── Per-isolate memoization ────────────────────────────────────────────────
// One in-flight promise shared by every concurrent caller — the first
// caller starts the real work, every other concurrent caller (called
// synchronously, before the first one has had a chance to resolve —
// `memo` is assigned before any `await` inside it can run) just awaits the
// SAME promise instead of racing its own attempt. A SUCCESSFUL result is
// cached forever after (the schema doesn't change again until the next
// deploy spins up a fresh isolate). A FAILED attempt clears the memo so
// the *next* call retries — a transient DB hiccup on cold start must not
// permanently wedge the caller into either "believes it's migrated" (skips
// forever, wrong) or "instantly rethrows forever" (never recovers without
// a redeploy, also wrong).
//
// Exported as a standalone helper (not inlined into `ensureSchema` below)
// so tests/test-auto-migrate.mjs can build its own isolated memoized
// instances around fake statements/locks, instead of fighting over the one
// process-wide `ensureSchema` singleton between test cases.
export function memoize(asyncFn) {
  let memo = null;
  function memoized(arg) {
    if (!memo) {
      memo = asyncFn(arg).catch((err) => {
        memo = null; // clear so the next call retries instead of staying wedged
        throw err;
      });
    }
    return memo;
  }
  memoized.reset = () => { memo = null; };
  return memoized;
}

// AUTO_MIGRATE=off is handled one layer up, in lib/db.js — db() simply
// never calls this function at all when the kill switch is set, so there's
// nothing to check in here. Keeping the switch in exactly one place (the
// choke point that decides whether to wire this in) avoids two pieces of
// code disagreeing about whether auto-migrate is "on."
export const ensureSchema = memoize(createEnsureSchema());

// Test-only: resets the process-wide singleton's memo between independent
// test cases in the same process. Production never calls this — one
// isolate lives and dies without ever wanting to "forget" a success.
export function __resetMemoForTests() {
  ensureSchema.reset();
}
