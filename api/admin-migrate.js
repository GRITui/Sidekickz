/* Sidekick — api/admin-migrate.js
 *
 * P5 Phase 1: sql/schema-core.sql is now applied AUTOMATICALLY, on the
 * first request any Edge isolate serves after a deploy (lib/autoMigrate.js,
 * wired in at the db() choke point in lib/db.js) — merging a PR IS the
 * migration now. This endpoint is what's left: an OPTIONAL manual
 * fallback/status view, for when you want to force a re-apply without
 * waiting for a real request to trigger it, or want to check
 * "did it land?" without reading server logs.
 *
 * Still exists to kill a real operational trap this project has hit: the
 * Vercel project has had TWO Neon databases attached, and a hand-run
 * `psql -f schema-core.sql` against the wrong one looks successful while
 * leaving every server feature broken (the 2026-07-13 incident). Running
 * the migration through this endpoint (same as the automatic path) makes
 * wrong-database impossible — it can only ever touch the database the
 * deployed code actually reads.
 *
 * SECURITY: disabled unless the SETUP_TOKEN env var is set, and every
 * request must carry it in the x-setup-token header (constant-time
 * compare). DDL behind a bearer-style secret is acceptable for a fallback
 * tool precisely because the SQL is idempotent and additive-only (the
 * schema file's own convention — no drops, no data mutations).
 *
 *   status: curl https://<api>/api/admin-migrate -H "x-setup-token: $T"
 *   apply : curl -X POST (same URL/header)
 *
 * GET reports which required tables/columns are missing (and the database
 * NAME — never the connection string), plus the code's SCHEMA_VERSION and
 * whatever version is actually stamped on the database, so "did it land,
 * and is it current?" is answerable in one call. POST force-applies every
 * statement and returns the same status afterward, plus per-statement
 * errors if any, and — on a clean run — stamps schema_meta the same way
 * the automatic path does, so a subsequent request's auto-migrate check
 * sees it's current and skips straight past.
 */
import { db } from '../lib/db.js';
import { constantTimeEqual } from '../lib/lineLogin.js';
import { SCHEMA_SQL } from '../lib/schemaSql.js';
import { splitSqlStatements, schemaStatus, runMigration, SCHEMA_VERSION } from '../lib/migrate.js';
import { getStampedVersion, stampVersion } from '../lib/autoMigrate.js';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// `getSql` swaps in an in-memory fake for tests (same factory-injection
// seam as api/cron-reminders.js's createCronRemindersHandler and
// api/booking-requests.js's createBookingRequestsHandler) — the default
// export below is just this called with the real db(), so production
// behavior is unchanged.
export function createAdminMigrateHandler(opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const token = process.env.SETUP_TOKEN;
    // Unset token = endpoint doesn't exist, effectively. 404 (not 403) so an
    // unconfigured deployment reveals nothing about this route's purpose.
    if (!token) return json({ error: 'Not found' }, 404);

    const supplied = request.headers.get('x-setup-token') || '';
    if (!constantTimeEqual(supplied, token)) {
      return json({ error: 'Forbidden' }, 403);
    }

    try {
      const sql = getSql();   // throws if DATABASE_URL is unset — that's a 502, not a crash
      if (request.method === 'GET') {
        const [status, stampedVersion] = await Promise.all([schemaStatus(sql), getStampedVersion(sql)]);
        return json({ ...status, codeVersion: SCHEMA_VERSION, stampedVersion }, 200);
      }
      if (request.method === 'POST') {
        const statements = splitSqlStatements(SCHEMA_SQL);
        const result = await runMigration(sql, statements);
        if (!result.errors.length) {
          await stampVersion(sql, SCHEMA_VERSION);
        }
        const status = await schemaStatus(sql);
        const stampedVersion = await getStampedVersion(sql);
        return json({ ...result, status, codeVersion: SCHEMA_VERSION, stampedVersion }, result.errors.length ? 207 : 200);
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (err) {
      console.error('admin-migrate error', err.message);
      return json({ error: 'Migration request failed' }, 502);
    }
  };
}

export default createAdminMigrateHandler();

export const config = { runtime: 'edge' };
