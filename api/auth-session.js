/* Sidekick — api/auth-session.js
 *
 * "Whoami" for the bearer token app/dataClient.js holds — used at boot to
 * confirm the stored token is still valid and to refresh the user's
 * profile fields (firstName etc.) without requiring a fresh login. Logout
 * is stateless by design (no server-side session store): the client just
 * discards its token, matching how session teardown already works for
 * local accounts (`localStorage.removeItem(SESSION_KEY)`).
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { isLocked, trialDaysLeft } from '../lib/entitlements.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);

  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const sql = db();
  try {
    const rows = await sql`
      select cuid, username, first_name, migrated_at, plan, subscription_status, trial_ends_at, current_period_end, stripe_customer_id
      from users where cuid = ${session.userCuid}
    `;
    const user = rows[0];
    if (!user) return json({ error: 'Not authenticated' }, 401, request);
    return json({
      user: {
        cuid: user.cuid,
        username: user.username,
        firstName: user.first_name,
        migrated: user.migrated_at != null,
        plan: user.plan,
        subscriptionStatus: user.subscription_status,
        trialEndsAt: user.trial_ends_at,
        currentPeriodEnd: user.current_period_end,
        trialDaysLeft: trialDaysLeft(user),
        locked: isLocked(user),
        hasStripeCustomer: user.stripe_customer_id != null,
      },
    }, 200, request);
  } catch (err) {
    console.error('auth-session handler error', err.message);
    return json({ error: 'Could not load session' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
