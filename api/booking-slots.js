/* Sidekick — api/booking-slots.js
 *
 * Authenticated CRUD for an account's own availability_slots — the time
 * windows they're offering up on their public booking page (app/book.html).
 * Distinct from api/booking-availability.js (public, read-only, shows only
 * the still-open ones) and from api/app-bookings.js (their own in-app
 * scheduling calendar, an unrelated feature) — this is the management side
 * of the slots table itself.
 *
 * Hand-written rather than lib/crudHandler.js's createResourceHandler():
 * availability_slots uses a server-assigned bigint identity id, not a
 * client-generated cuid, so the shared factory's cuid-keyed insert/update/
 * delete shape doesn't fit.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);
  const { userCuid } = session;
  const sql = db();

  try {
    if (request.method === 'GET') {
      const rows = await sql(
        `select id, starts_at, ends_at, status from availability_slots where user_cuid = $1 order by starts_at`,
        [userCuid]
      );
      return json({ rows }, 200, request);
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const startsAt = body && body.startsAt;
      const endsAt = body && body.endsAt;
      if (!startsAt || !endsAt) return json({ error: 'startsAt and endsAt are required' }, 400, request);
      const rows = await sql(
        `insert into availability_slots (user_cuid, starts_at, ends_at)
         values ($1, $2, $3)
         returning id, starts_at, ends_at, status`,
        [userCuid, startsAt, endsAt]
      ).catch(() => { throw Object.assign(new Error('endsAt must be after startsAt'), { code: 'bad_range' }); });
      return json({ row: rows[0] }, 201, request);
    }

    if (request.method === 'DELETE') {
      const id = Number(new URL(request.url).searchParams.get('id'));
      if (!Number.isInteger(id)) return json({ error: 'Missing or invalid ?id=' }, 400, request);
      const rows = await sql(`delete from availability_slots where id = $1 and user_cuid = $2 returning id`, [id, userCuid]);
      if (!rows.length) return json({ error: 'Not found' }, 404, request);
      return json({ deleted: true }, 200, request);
    }

    return json({ error: 'Method not allowed' }, 405, request);
  } catch (err) {
    const message = err && err.code === 'bad_range' ? err.message : 'Request failed';
    console.error('booking-slots handler error', err.message);
    return json({ error: message }, err && err.code === 'bad_range' ? 400 : 502, request);
  }
}

export const config = { runtime: 'edge' };
