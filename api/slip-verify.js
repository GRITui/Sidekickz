/* Sidekick — api/slip-verify.js
 *
 * M4 Pass P2: turns a client-uploaded payment slip (an image an invoice's
 * slips[] array already carries — see api/invoice-public.js's header) into
 * a machine-checked "does this actually match the bank record" result, via
 * whichever provider (today: SlipOK) the freelancer has configured in her
 * own Settings.
 *
 * Provider credentials (apiKey/branchId) are NEVER stored server-side —
 * they live in the freelancer's own local settings store (Settings ▸ Shop,
 * same per-account-secret convention as the LINE channel secret — see
 * api/line-channel-connect.js), and ride along on EVERY call from the
 * client. What IS persisted is the verification RESULT — written onto the
 * matching slips[] entry so it survives across devices/sessions, same
 * jsonb-embedded-array convention every other slip field already uses.
 *
 * Factory shape (opts.getSql/opts.verify) matches api/booking-requests.js's
 * seam, so tests/test-slip-verify.mjs can swap in an in-memory fake sql AND
 * a fake verify() without a live Neon connection or a real SlipOK account.
 */
import { db } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { corsHeaders, handlePreflight } from '../lib/cors.js';
import { canWrite } from '../lib/entitlements.js';
import { resolveDataOwner } from '../lib/teams.js';
import { rateLimit } from '../lib/rateLimit.js';
import { verifySlip } from '../lib/slipVerify.js';
import { toParam } from '../lib/crudHandler.js';

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(request) },
  });
}

export function createSlipVerifyHandler(opts = {}) {
  const getSql = opts.getSql || db;
  const verify = opts.verify || verifySlip;

  return async function handler(request) {
    const preflight = handlePreflight(request);
    if (preflight) return preflight;

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request);

    // Authenticated but still bounded — unlike a plain CRUD write, this
    // fans out to a real (often billed) third-party API call per request.
    const limited = rateLimit(request, { key: 'slip-verify', limit: 10, windowMs: 60_000 });
    if (limited) return limited;

    const secret = process.env.SESSION_SECRET;
    if (!secret) return json({ error: 'Server misconfigured' }, 500, request);
    const session = await requireSession(request, secret);
    if (!session) return json({ error: 'Not authenticated' }, 401, request);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, request);
    }

    const invoiceCuid = typeof body.invoiceCuid === 'string' ? body.invoiceCuid : '';
    const slipId = typeof body.slipId === 'string' ? body.slipId : '';
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const branchId = typeof body.branchId === 'string' ? body.branchId : '';
    if (!invoiceCuid || !slipId || !provider || !apiKey || !branchId) {
      return json({ error: 'invoiceCuid, slipId, provider, apiKey, and branchId are required' }, 400, request);
    }

    const sql = getSql();
    // A team member (admin/staff) verifies a slip on the org owner's own
    // invoice — same data-owner resolution as lib/crudHandler.js.
    const owner = await resolveDataOwner(sql, session.userCuid);

    try {
      // Same write-lock gate as lib/crudHandler.js/api/booking-requests.js,
      // checked against the resolved data owner: a locked account is
      // read-only, and writing a verify result onto slips[] is a write.
      const [user] = await sql(
        `select plan, subscription_status, trial_ends_at from users where cuid = $1`,
        [owner]
      );
      if (!canWrite(user)) {
        return json({ error: 'Subscription required', code: 'locked' }, 402, request);
      }

      // Scoped by BOTH cuid and owner in one WHERE clause — a cuid that
      // exists but belongs to someone else's invoice comes back empty, same
      // "no distinguishing detail" 404 as a cuid that doesn't exist at all.
      const [invoice] = await sql(
        `select cuid, client_pays, slips from invoices where cuid = $1 and user_cuid = $2`,
        [invoiceCuid, owner]
      );
      if (!invoice) return json({ error: 'Not found' }, 404, request);

      const slips = Array.isArray(invoice.slips) ? invoice.slips : [];
      const idx = slips.findIndex(s => s && s.id === slipId);
      if (idx === -1) return json({ error: 'Not found' }, 404, request);

      const result = await verify({
        provider, apiKey, branchId,
        dataUrl: slips[idx].dataUrl,
        expectedAmount: invoice.client_pays,
      });

      const verifyRecord = {
        status: result.status,
        amount: result.amount != null ? result.amount : null,
        ref: result.ref || null,
        at: new Date().toISOString(),
      };
      const nextSlips = slips.slice();
      nextSlips[idx] = { ...nextSlips[idx], verify: verifyRecord };

      await sql(`update invoices set slips = $1, updated_at = now() where cuid = $2`, [toParam(nextSlips), invoiceCuid]);

      // apiKey never echoed back — see file header.
      return json({ ok: true, verify: verifyRecord }, 200, request);
    } catch (err) {
      console.error('slip-verify handler error', err.message);
      return json({ error: 'Could not verify slip' }, 502, request);
    }
  };
}

export default createSlipVerifyHandler();
export const config = { runtime: 'edge' };
