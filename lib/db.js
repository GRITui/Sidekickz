/* Sidekick — lib/db.js
 *
 * Single shared Neon connection point. Uses @neondatabase/serverless's
 * HTTP-based driver deliberately, not a traditional TCP `pg` client — that's
 * what avoids the connection-pool exhaustion problem a bursty serverless
 * caller would hit against a traditional Postgres (the exact reason a
 * Hostinger-hosted MySQL was ruled out earlier for this piece).
 *
 * Reads DATABASE_URL, the exact env var name Neon's own Vercel integration
 * auto-provisions (pooled connection) — not a name invented here.
 *
 * P5 Phase 1 (auto-migrate on cold start): db() is the ONE place every
 * handler gets its sql client from, which makes it the natural choke point
 * to guarantee sql/schema-core.sql is applied before any handler's first
 * real query runs — no per-handler changes needed anywhere. The returned
 * function's first invocation (per isolate) awaits
 * lib/autoMigrate.js's ensureSchema(); every invocation after that is one
 * `.then()` on an already-resolved promise (ensureSchema's own memo — see
 * that file), so there's no steady-state overhead. ensureSchema is always
 * given the RAW client (never the wrapped one returned here), so the
 * queries auto-migrate itself issues don't recurse back through this same
 * wrapper.
 *
 * Kill switch: set AUTO_MIGRATE=off (see .env.example) to skip this
 * entirely and hand handlers the raw client, unwrapped — e.g. to rule
 * auto-migrate in/out while investigating an incident, without a redeploy
 * (Vercel env var changes still need a redeploy to take effect, but this
 * keeps the escape hatch a one-line env change rather than a code revert).
 */
import { neon } from '@neondatabase/serverless';
import { ensureSchema } from './autoMigrate.js';

// Exported (not just used internally by db()) so tests can exercise the
// wrapping behavior itself — memoization, call counts, the kill switch —
// against a fake sql client and a fake/real ensureSchemaFn, with no
// DATABASE_URL or network involved. db() below is just this called with
// the real neon() client and the real ensureSchema.
export function wrapWithAutoMigrate(rawSql, ensureSchemaFn) {
  if (process.env.AUTO_MIGRATE === 'off') return rawSql;
  return (...args) => ensureSchemaFn(rawSql).then(() => rawSql(...args));
}

let raw = null;
let wrapped = null;

export function db() {
  if (!raw) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — connect the Neon integration in the Vercel dashboard first.');
    raw = neon(url);
  }
  if (!wrapped) {
    wrapped = wrapWithAutoMigrate(raw, ensureSchema);
  }
  return wrapped;
}
