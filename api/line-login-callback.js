/* Sidekick — api/line-login-callback.js
 *
 * LINE redirects here after the user approves (or cancels) the login. On
 * success, hands the verified LINE profile (sub/name/picture — no tokens,
 * nothing secret) to the client as a URL fragment on login.html, which never
 * reaches this server or any server log. app/app.js's bootLogin() reads it
 * once and creates/logs into a local IndexedDB account keyed by
 * `line:<sub>` — there is no server-side user record to create, matching the
 * rest of the app's local-first model.
 */
import { verifyState, exchangeCodeForToken, verifyIdToken } from '../lib/lineLogin.js';

function redirectToLogin(origin, params) {
  return Response.redirect(`${origin}/login.html#${new URLSearchParams(params).toString()}`, 302);
}

export default async function handler(request) {
  const { searchParams, origin } = new URL(request.url);
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET;
  const callbackUrl = process.env.LINE_LOGIN_CALLBACK_URL;
  const stateSecret = process.env.LINE_LOGIN_STATE_SECRET;
  if (!channelId || !channelSecret || !callbackUrl || !stateSecret) {
    return new Response('LINE Login is not configured on this deployment.', { status: 500 });
  }

  if (searchParams.get('error')) {
    return redirectToLogin(origin, { line_error: searchParams.get('error') });
  }

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  if (!code || !state) return redirectToLogin(origin, { line_error: 'missing_params' });

  const nonce = await verifyState(state, stateSecret);
  if (!nonce) return redirectToLogin(origin, { line_error: 'invalid_state' });

  let claims;
  try {
    const token = await exchangeCodeForToken({ code, channelId, channelSecret, callbackUrl });
    claims = await verifyIdToken(token.id_token, { channelId, channelSecret, nonce });
  } catch (err) {
    console.error('line-login-callback failed', err);
    return redirectToLogin(origin, { line_error: 'login_failed' });
  }

  const profile = { sub: claims.sub, name: claims.name || '', picture: claims.picture || '' };
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(profile))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return redirectToLogin(origin, { line: encoded });
}

export const config = { runtime: 'edge' };
