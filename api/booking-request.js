/* Sidekick — api/booking-request.js
 *
 * The one write path for Step 0 (self-service booking). A client picks a
 * slot on the public booking page and submits this — no chatbot, no LINE
 * message event, which is exactly why the client-side confirmation happens
 * in this response (see below) instead of a LINE reply: there is no
 * replyToken to reply with, since nothing was ever sent to LINE.
 *
 * Soft-hold, not instant-confirm and not request-and-wait: the slot is
 * marked 'held' the moment this succeeds (feels immediate to the client),
 * the freelancer gets pushed an alert, and the hold auto-expires if she
 * never confirms — see hold_expires_at in schema.sql. The UPDATE below is
 * the actual double-booking guard: a single statement with the current
 * state in its WHERE clause is atomic in Postgres on its own, no explicit
 * transaction needed — two simultaneous requests for the same slot can't
 * both match it.
 */
import { db } from '../lib/db.js';
import { getLineAccessToken, linePush } from '../lib/line.js';

const HOLD_MINUTES = 15;

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const slotId = Number(body.slotId);
  const serviceId = Number(body.serviceId);
  const clientName = typeof body.clientName === 'string' ? body.clientName.trim().slice(0, 100) : '';
  const clientLineUserId = typeof body.clientLineUserId === 'string' ? body.clientLineUserId.slice(0, 100) : null;

  if (!Number.isInteger(slotId) || !Number.isInteger(serviceId) || !clientName) {
    return new Response(JSON.stringify({ error: 'slotId, serviceId, and clientName are required' }), { status: 400 });
  }

  const sql = db();

  let held;
  try {
    held = await sql`
      update availability_slots
      set status = 'held', hold_expires_at = now() + make_interval(mins => ${HOLD_MINUTES})
      where id = ${slotId}
        and (status = 'open' or (status = 'held' and hold_expires_at < now()))
      returning id, starts_at, ends_at
    `;
  } catch (err) {
    console.error('booking-request hold update failed', err);
    return new Response(JSON.stringify({ error: 'Could not reach the database' }), { status: 502 });
  }

  if (held.length === 0) {
    return new Response(JSON.stringify({ error: 'That slot is no longer available — please pick another.' }), { status: 409 });
  }
  const slot = held[0];

  let booking;
  try {
    const [service] = await sql`select id, name, price_thb from services where id = ${serviceId} and active = true`;
    if (!service) {
      return new Response(JSON.stringify({ error: 'That service is not available.' }), { status: 400 });
    }
    [booking] = await sql`
      insert into bookings (slot_id, service_id, client_name, client_line_user_id, status)
      values (${slotId}, ${serviceId}, ${clientName}, ${clientLineUserId}, 'requested')
      returning id
    `;

    // Best-effort — a failed notification shouldn't undo an already-held
    // slot and already-written booking; the freelancer still sees it next
    // time she opens the app either way.
    const channelId = process.env.LINE_CHANNEL_ID;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const freelancerLineUserId = process.env.LINE_FREELANCER_USER_ID;
    if (channelId && channelSecret && freelancerLineUserId) {
      const accessToken = await getLineAccessToken(channelId, channelSecret);
      await linePush(accessToken, freelancerLineUserId, [{
        type: 'text',
        text: `New booking request: ${clientName} — ${service.name} — ${new Date(slot.starts_at).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })}. Confirm it in Sidekick.`,
      }]);
    }

    return new Response(JSON.stringify({
      ok: true,
      bookingId: booking.id,
      service: service.name,
      startsAt: slot.starts_at,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    console.error('booking-request handler error', err);
    return new Response(JSON.stringify({ error: 'Could not complete the booking' }), { status: 502 });
  }
}

export const config = { runtime: 'edge' };
