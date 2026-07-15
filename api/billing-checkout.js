/* Sidekick — api/billing-checkout.js
 *
 * Starts a real subscription: creates (or reuses) a Stripe Customer for the
 * caller's account, then a Stripe-hosted Checkout Session for the chosen
 * plan, and hands back its URL for the client to redirect to. Stripe's own
 * hosted page collects the card — this endpoint never sees one, so this app
 * stays out of PCI scope entirely, same reasoning as everything else here
 * that defers to a hosted flow rather than building a custom form.
 *
 * 'team' is deliberately not accepted yet — seat-based billing needs the
 * organizations/members data model from Phase 2, not built in this pass.
 *
 * Requires STRIPE_PRICE_BASIC / STRIPE_PRICE_PRO env vars, set to real
 * Stripe Price IDs created by hand in the Stripe Dashboard (Products →
 * add a recurring monthly THB price for each plan) — there is no API call
 * in this codebase that creates Prices, matching this project's existing
 * "schema/config applied by hand, no automation for one-time setup" habit
 * (sql/schema-core.sql, the LINE channel setup, etc.).
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight, resolveOrigin } from '../lib/cors.js';
import { stripeClient } from '../lib/stripe.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

const PRICE_ENV_BY_PLAN = { basic: 'STRIPE_PRICE_BASIC', pro: 'STRIPE_PRICE_PRO' };

export default async function handler(request) {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
  const session = await requireSession(request, secret);
  if (!session) return json({ error: 'Not authenticated' }, 401, request);

  const body = await request.json().catch(() => null);
  const plan = body && body.plan;
  const priceEnvKey = PRICE_ENV_BY_PLAN[plan];
  if (!priceEnvKey) return json({ error: 'plan must be "basic" or "pro"' }, 400, request);
  const priceId = process.env[priceEnvKey];
  if (!priceId) return json({ error: `Server misconfigured — ${priceEnvKey} is not set` }, 500, request);

  const sql = db();
  try {
    const [user] = await sql(
      `select cuid, username, stripe_customer_id from users where cuid = $1`,
      [session.userCuid]
    );
    if (!user) return json({ error: 'Account not found' }, 404, request);

    const stripe = stripeClient();
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        // `username` doubles as the login identifier for password accounts
        // (see api/auth-register.js) — not guaranteed to be a real email,
        // but it's the only contact-ish field this app collects today.
        email: user.username.includes('@') ? user.username : undefined,
        metadata: { userCuid: user.cuid },
      });
      customerId = customer.id;
      await sql(`update users set stripe_customer_id = $1 where cuid = $2`, [customerId, user.cuid]);
    }

    const origin = resolveOrigin(request);
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.cuid,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      metadata: { userCuid: user.cuid, plan },
      subscription_data: { metadata: { userCuid: user.cuid, plan } },
    });

    return json({ url: checkoutSession.url }, 200, request);
  } catch (err) {
    console.error('billing-checkout handler error', err.message);
    return json({ error: 'Could not start checkout' }, 502, request);
  }
}

export const config = { runtime: 'edge' };
