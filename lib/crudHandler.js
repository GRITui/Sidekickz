/* Sidekick — lib/crudHandler.js
 *
 * Shared CRUD handler factory for the backend-migration API. One call to
 * `createResourceHandler` produces a single Vercel edge-function handler
 * (GET list / POST create / PUT update / DELETE) for one Postgres table,
 * scoped to the caller's own rows.
 *
 * Row-scoping is the one rule every resource endpoint must never break:
 * `user_cuid` always comes from the verified bearer session
 * (requireSession, lib/auth.js), NEVER from a client-supplied body/query
 * field. That's what makes cross-account data leakage structurally
 * impossible rather than something each handler has to remember to check.
 *
 * `db()` (lib/db.js) is called lazily inside the handler, not the module
 * factory, matching its existing lazy-singleton shape — and is injectable
 * via opts.getSql so tests can swap in an in-memory fake without a live
 * Neon connection (see test/fakeSql.js).
 */
import { db } from './db.js';
import { requireSession } from './auth.js';
import { corsHeaders, handlePreflight } from './cors.js';
import { canWrite } from './entitlements.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

// Builds `col1 = $2, col2 = $3, ...` for whichever of `fields` are present
// on `body`, starting the placeholder count at `startIndex`. Absent fields
// are left untouched (not nulled) — an update only ever specifies what
// changed, matching how the client's own save functions already build
// their payloads (e.g. saveCustomer() spreading `...(prev || {})` first).
function buildSetClause(fields, body, startIndex) {
  const cols = [];
  const params = [];
  let i = startIndex;
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      cols.push(`${f} = $${i}`);
      params.push(body[f] ?? null);
      i += 1;
    }
  }
  return { clause: cols.join(', '), params, next: i };
}

/**
 * @param {string} table - trusted, hardcoded table name (never user input)
 * @param {string[]} fields - allowed writable columns, in no particular order
 * @param {object} [opts]
 * @param {() => Function} [opts.getSql] - override for tests; defaults to db()
 */
export function createResourceHandler(table, fields, opts = {}) {
  const getSql = opts.getSql || db;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    const secret = process.env.SESSION_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500, request);

    const session = await requireSession(request, secret);
    if (!session) return json({ error: 'Not authenticated' }, 401, request);
    const { userCuid } = session;

    const sql = getSql();
    const url = new URL(request.url);
    const cuid = url.searchParams.get('cuid');

    try {
      if (request.method === 'GET') {
        const rows = await sql(
          `select * from ${table} where user_cuid = $1 order by updated_at desc`,
          [userCuid]
        );
        return json({ rows }, 200, request);
      }

      // Every write (POST/PUT/DELETE) requires an unlocked account — GET
      // above stays open regardless, per the trial-expiry product decision
      // (downgrade to locked/read-only, not full lockout). One extra
      // lookup per write; deliberately not folded into the session token,
      // since a Stripe webhook can flip subscription_status between
      // requests and a long-lived 30-day token would otherwise go stale.
      const [user] = await sql(
        `select plan, subscription_status, trial_ends_at from users where cuid = $1`,
        [userCuid]
      );
      if (!canWrite(user)) {
        return json({ error: 'Subscription required', code: 'locked' }, 402, request);
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body.cuid !== 'string' || !body.cuid) {
          return json({ error: 'Missing cuid' }, 400, request);
        }
        const cols = ['cuid', 'user_cuid', ...fields, 'updated_at'];
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const values = [body.cuid, userCuid, ...fields.map(f => body[f] ?? null), new Date().toISOString()];
        const rows = await sql(
          `insert into ${table} (${cols.join(', ')}) values (${placeholders.join(', ')})
           on conflict (cuid) do nothing
           returning *`,
          values
        );
        if (!rows.length) return json({ error: 'A record with this id already exists' }, 409, request);
        return json({ row: rows[0] }, 201, request);
      }

      if (request.method === 'PUT') {
        if (!cuid) return json({ error: 'Missing ?cuid=' }, 400, request);
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: 'Invalid body' }, 400, request);
        const { clause, params } = buildSetClause(fields, body, 3);
        if (!clause) return json({ error: 'No updatable fields provided' }, 400, request);
        const rows = await sql(
          `update ${table} set ${clause}, updated_at = now()
           where cuid = $1 and user_cuid = $2
           returning *`,
          [cuid, userCuid, ...params]
        );
        if (!rows.length) return json({ error: 'Not found' }, 404, request);
        return json({ row: rows[0] }, 200, request);
      }

      if (request.method === 'DELETE') {
        if (!cuid) return json({ error: 'Missing ?cuid=' }, 400, request);
        const rows = await sql(
          `delete from ${table} where cuid = $1 and user_cuid = $2 returning cuid`,
          [cuid, userCuid]
        );
        if (!rows.length) return json({ error: 'Not found' }, 404, request);
        return json({ deleted: true }, 200, request);
      }

      return json({ error: 'Method not allowed' }, 405, request);
    } catch (err) {
      // Never include `body`/field values in the log line — this table's
      // fields include PII-adjacent data on other resources (e.g. a future
      // settings/paymentChannels endpoint), so keep the habit from day one.
      console.error(`${table} handler error`, err.message);
      return json({ error: 'Request failed' }, 502, request);
    }
  };
}
