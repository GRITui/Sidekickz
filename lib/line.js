/* Sidekick — lib/line.js
 *
 * Shared LINE Messaging API helpers, used by both api/line-webhook.js
 * (Step 1: first-contact acknowledgment, triggered by a real inbound
 * message, so it can use the free Reply API) and api/booking-request.js
 * (Step 0: the self-service booking page, which is a plain web form with
 * no LINE replyToken available, so it can only ever push, never reply).
 *
 * Pilot/single-tenant: one Channel via env vars (LINE_CHANNEL_ID,
 * LINE_CHANNEL_SECRET), not a per-freelancer credential store.
 */
import { constantTimeEqual } from './lineLogin.js';

export async function verifyLineSignature(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return constantTimeEqual(expected, signatureHeader);
}

let cachedToken = null; // { value, expiresAt } — reused across warm invocations only
export async function getLineAccessToken(channelId, channelSecret) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: channelId,
      client_secret: channelSecret,
    }),
  });
  if (!res.ok) throw new Error(`LINE token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

// Free — only usable within the response window of a real inbound LINE event.
export async function lineReply(accessToken, replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error('LINE reply failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}

// Counts against the Messaging API's monthly quota — proactive, not tied to
// an inbound event. This is the only option for alerting the freelancer
// about a booking that came from the web page, not a LINE message.
export async function linePush(accessToken, toUserId, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (!res.ok) console.error('LINE push failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}
