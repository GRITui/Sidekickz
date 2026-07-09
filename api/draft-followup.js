/* Freelanz — api/draft-followup.js (M-AI, Vercel serverless function)
 *
 * The ONE place in this project that talks to the network for anything
 * beyond static assets. Everything else is local-first by design; this
 * endpoint is opt-in (the user taps "Draft message") and sends only the
 * follow-up's reason + customer name — never the local database.
 *
 * The AI Gateway key lives ONLY in Vercel's server-side environment
 * variables (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY) and is never sent to
 * or readable by the client. Configure these in the Vercel project's
 * Settings → Environment Variables — never commit them, never paste them
 * in chat (rotate immediately if one ever is).
 */
// Best-effort in-memory sliding-window rate limit, keyed per client IP.
// NOTE: serverless instances are ephemeral and NOT shared, so this only
// throttles bursts that hit one warm instance — for durable, cross-instance
// limits use a shared store such as Vercel KV / Upstash Redis in production.
const RATE_LIMIT = 10;          // max requests…
const RATE_WINDOW_MS = 60_000;  // …per IP per minute
function rateLimited(ip) {
  const store = (globalThis.__flzRate = globalThis.__flzRate || new Map());
  const now = Date.now();
  const hits = (store.get(ip) || []).filter(ts => now - ts < RATE_WINDOW_MS);
  hits.push(now);
  store.set(ip, hits);
  return hits.length > RATE_LIMIT;
}

export default async function handler(req, res) {
  // CORS: only ever advertise the single configured origin (never '*') so other
  // sites can't read this endpoint's responses from a browser.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.origin;
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  // Origin enforcement: once ALLOWED_ORIGIN is configured, reject any browser
  // request whose Origin header doesn't match it. (Same-origin requests may omit
  // Origin, so a missing header is allowed; pre-deploy the var may be unset.)
  if (allowedOrigin && origin && origin !== allowedOrigin) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (rateLimited(ip)) { res.status(429).json({ error: 'Too many requests, please slow down' }); return; }

  const body = req.body || {};
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : '';
  const customerName = typeof body.customerName === 'string' ? body.customerName.slice(0, 100) : '';
  const tone = body.tone === 'firm' ? 'firm' : 'friendly';
  if (!reason || !customerName) {
    res.status(400).json({ error: 'reason and customerName are required' });
    return;
  }

  const baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!authToken && !apiKey) {
    res.status(500).json({ error: 'AI Gateway is not configured on this deployment' });
    return;
  }

  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  else headers['x-api-key'] = apiKey;

  const prompt = `Write a short follow-up message (2-3 sentences, plain text, no greeting or signature) a freelancer can send to their client "${customerName}". Context: ${reason}. Tone: ${tone === 'firm' ? 'polite but firm — a clear nudge' : 'warm and casual'}.`;

  try {
    const upstream = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-5',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!upstream.ok) {
      console.error('AI Gateway error', upstream.status, await upstream.text().catch(() => ''));
      res.status(502).json({ error: 'AI Gateway request failed' });
      return;
    }
    const data = await upstream.json();
    const draft = (data.content && data.content[0] && data.content[0].text) || '';
    if (!draft) { res.status(502).json({ error: 'AI Gateway returned an empty draft' }); return; }
    res.status(200).json({ draft: draft.trim() });
  } catch (err) {
    console.error('draft-followup handler error', err);
    res.status(502).json({ error: 'Could not reach the AI Gateway' });
  }
}
