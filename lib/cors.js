/* Sidekick — lib/cors.js
 *
 * The core-data API (api/clients.js, api/auth-*.js, api/migrate-upload.js)
 * is called cross-origin: GitHub Pages is canonical prod for the app itself
 * (root + the /gym/ mirror, both https://gritui.github.io), while this API
 * only runs on Vercel. Reuses the exact origin allowlist
 * api/line-login-start.js already validates its `returnTo` redirect against
 * — same three deployments, same trust boundary — rather than a wildcard,
 * since these endpoints (unlike the public, unauthenticated booking pilot
 * ones) carry authenticated, tenant-scoped data.
 */
const ALLOWED_ORIGINS = [
  'https://gritui.github.io',
  'https://sidekickz.vercel.app',
];

// Local/dev-only extension, e.g. `http://localhost:8825` while running the
// app against a local dev-server.js mirror of this API — never set in any
// real deployment, so production's allowlist is exactly the two origins
// above regardless of this.
if (process.env.CORS_EXTRA_ORIGIN) ALLOWED_ORIGINS.push(process.env.CORS_EXTRA_ORIGIN);

// Resolves a request's Origin header against the same allowlist CORS uses,
// falling back to the first allowed origin when absent/unrecognized. Shared
// by anything that needs to build a same-origin redirect URL from a
// cross-origin request (e.g. api/billing-checkout.js's Stripe
// success_url/cancel_url) without trusting a client-supplied redirect
// target — same allowlist-not-wildcard trust boundary as CORS itself.
export function resolveOrigin(request) {
  const origin = request.headers.get('origin');
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export function corsHeaders(request) {
  return {
    'access-control-allow-origin': resolveOrigin(request),
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'origin',
  };
}

// Call first in every handler; returns a ready-to-send 204 for an OPTIONS
// preflight, or null for every other method (meaning: keep going).
export function handlePreflight(request) {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
