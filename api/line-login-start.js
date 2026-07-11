/* Sidekick — api/line-login-start.js
 *
 * Entry point for the "Log in with LINE" button (app/login.html). Redirects
 * the browser straight to LINE's authorize page — nothing is persisted here,
 * the signed `state` carries the per-attempt nonce forward to
 * api/line-login-callback.js (see lib/lineLogin.js's header for why).
 */
import { signState, buildAuthorizeUrl } from '../lib/lineLogin.js';

export default async function handler() {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  const callbackUrl = process.env.LINE_LOGIN_CALLBACK_URL;
  const stateSecret = process.env.LINE_LOGIN_STATE_SECRET;
  if (!channelId || !callbackUrl || !stateSecret) {
    return new Response('LINE Login is not configured on this deployment.', { status: 500 });
  }

  const nonce = crypto.randomUUID();
  const state = await signState(nonce, stateSecret);
  const url = buildAuthorizeUrl({ channelId, callbackUrl, state, nonce });
  return Response.redirect(url, 302);
}

export const config = { runtime: 'edge' };
