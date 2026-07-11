/* Sidekick — api/line-webhook.js (LINE integration, Step 1: first-contact acknowledgment)
 *
 * Receives LINE Messaging API webhook events and replies to a user's first
 * message with a canned link to the booking page. Deliberately stateless —
 * no database read/write here, since LINE's per-event replyToken makes a
 * reply possible without persisting anything. Step 0 (the actual booking
 * page + pipeline entry) lives in api/booking-availability.js and
 * api/booking-request.js, backed by Neon — this file doesn't touch that.
 *
 * Pilot/single-tenant: one Channel wired via env vars, not a generic
 * per-freelancer "connect your own LINE OA" flow — that's separate, larger
 * work (a real per-user credential store), tracked but not started here.
 *
 * Written as a Web API (Request/Response) handler rather than a classic
 * Vercel (req, res) handler. That's deliberate: verifying LINE's webhook
 * signature requires hashing the exact raw bytes of the request body, and
 * Vercel's Node (req, res) helper for plain (non-Next.js) functions has
 * documented rough edges exposing that raw body. The Request/Response
 * signature gives a reliable `await request.text()` for the untouched raw
 * body instead.
 *
 * NOT YET LIVE-TESTED — this repo has no Vercel deploy access from this
 * session, so this has only been checked against LINE's documented request/
 * response shapes and a local HMAC unit check (see session notes), not
 * exercised against a real webhook delivery.
 */
import { verifyLineSignature, getLineAccessToken, lineReply } from '../lib/line.js';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const channelId = process.env.LINE_CHANNEL_ID;
  const bookingUrl = process.env.LINE_BOOKING_URL || 'https://gritui.github.io/Sidekickz/';
  if (!channelSecret || !channelId) {
    return new Response(JSON.stringify({ error: 'LINE channel is not configured on this deployment' }), { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-line-signature');
  if (!(await verifyLineSignature(rawBody, signature, channelSecret))) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  try {
    if (events.some(e => e.type === 'message' && e.replyToken)) {
      const accessToken = await getLineAccessToken(channelId, channelSecret);
      for (const event of events) {
        if (event.type === 'message' && event.replyToken) {
          await lineReply(accessToken, event.replyToken, [{
            type: 'text',
            text: `Thanks for reaching out! Here's my services & open times — book a slot any time:\n${bookingUrl}`,
          }]);
        }
      }
    }
  } catch (err) {
    // LINE expects a fast 200 regardless, or it retries the whole batch —
    // log and acknowledge rather than fail the delivery.
    console.error('line-webhook handler error', err);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

export const config = { runtime: 'edge' };
