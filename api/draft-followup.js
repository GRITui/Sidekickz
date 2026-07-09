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
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

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
