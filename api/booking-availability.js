/* Sidekick — api/booking-availability.js
 *
 * Public, unauthenticated by design — this is what the self-service
 * booking page reads to show services + open slots. No client login,
 * matching the rest of this endpoint's page (see the LINE fork-comparison
 * work: this has to work for a stranger who has never touched Sidekick).
 *
 * Treats an expired hold as available again on read, rather than needing a
 * cron job to sweep them — see booking-request.js for where holds are set.
 */
import { db } from '../lib/db.js';

export default async function handler(request) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const sql = db();
    const [services, slots] = await Promise.all([
      sql`select id, name, price_thb from services where active = true order by id`,
      sql`
        select id, starts_at, ends_at
        from availability_slots
        where status = 'open'
           or (status = 'held' and hold_expires_at < now())
        order by starts_at
      `,
    ]);
    return new Response(JSON.stringify({ services, slots }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    console.error('booking-availability handler error', err);
    return new Response(JSON.stringify({ error: 'Could not load availability' }), { status: 502 });
  }
}

export const config = { runtime: 'edge' };
