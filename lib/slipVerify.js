/* Sidekick — lib/slipVerify.js
 *
 * Provider-pluggable bank-slip verification seam for M4 Pass P2. Callers
 * (api/slip-verify.js) never branch on provider name themselves — they call
 * verifySlip({provider, ...}) and get back one normalized {status, ...}
 * shape regardless of which real API answered. Adding a second provider
 * later is "add another entry to PROVIDERS", not "touch every caller".
 *
 * Today only 'slipok' is wired up, against SlipOK's own SDK-documented
 * contract (verified 2026-07-17): a slip IMAGE is verified via
 *   POST https://api.slipok.com/api/line/apikey/{branchId}
 *   header: x-authorization: <apiKey>
 *   body:   multipart/form-data, image under a `files` field, plus an
 *           `amount` field when the caller already knows the expected
 *           total — SlipOK itself then flags an amount mismatch (code
 *           1013) rather than this app comparing floats on its own.
 * (SlipOK also supports a QR-string `data` field variant for scanned
 * payload strings — not used here, since every slip this app ever holds is
 * a photographed/screenshotted image, never a raw QR string.)
 *
 * Response mapping (SlipOK's own status codes):
 *   success:true              -> {status:'verified', amount, ref, sender}
 *   success:false, code 1013  -> {status:'mismatch', amount}   (amount sent didn't match the slip)
 *   success:false, code 1012  -> {status:'duplicate'}           (this slip was already verified before)
 *   success:false, other      -> {status:'invalid', message}
 *   network/HTTP/parse failure-> {status:'error'}
 *
 * NEVER logs or returns the apiKey anywhere — every error path folds down
 * to a plain {status:'error'} (or, for an unknown provider, a fixed
 * {status:'error', message:'unknown provider'}), never the caught error's
 * own message, which could in principle echo request details back.
 */

// data:<mime>;base64,<payload> -> a Blob, for the multipart 'files' field.
// Edge runtime (Vercel) and modern Node both expose global atob/Blob, so
// nothing here is imported — same "no new dependency" habit as the rest of
// this codebase.
function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const [, mime, b64] = match;
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function verifySlipOK({ apiKey, branchId, dataUrl, expectedAmount }) {
  if (!apiKey || !branchId) return { status: 'error' };
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return { status: 'error' };

  const ext = (blob.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const form = new FormData();
  form.append('files', blob, `slip.${ext}`);
  if (expectedAmount != null) form.append('amount', String(expectedAmount));

  let res;
  try {
    res = await fetch(`https://api.slipok.com/api/line/apikey/${encodeURIComponent(branchId)}`, {
      method: 'POST',
      headers: { 'x-authorization': apiKey },
      body: form,
    });
  } catch {
    return { status: 'error' };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 'error' };
  }
  if (!body || typeof body !== 'object') return { status: 'error' };

  if (body.success === true) {
    const data = body.data || {};
    return {
      status: 'verified',
      amount: data.amount != null ? data.amount : null,
      ref: data.transRef || null,
      sender: data.sender || null,
    };
  }

  const code = body.code;
  const data = body.data || {};
  if (code === 1013) return { status: 'mismatch', amount: data.amount != null ? data.amount : null };
  if (code === 1012) return { status: 'duplicate' };
  if (body.success === false) return { status: 'invalid', message: typeof body.message === 'string' ? body.message : null };

  return { status: 'error' };
}

const PROVIDERS = {
  slipok: verifySlipOK,
};

/**
 * @param {{provider:string, apiKey:string, branchId:string, dataUrl:string, expectedAmount?:number}} args
 * @returns {Promise<{status:string, amount?:number|null, ref?:string|null, sender?:string|null, message?:string|null}>}
 */
export async function verifySlip({ provider, apiKey, branchId, dataUrl, expectedAmount }) {
  const impl = PROVIDERS[provider];
  if (!impl) return { status: 'error', message: 'unknown provider' };
  try {
    return await impl({ apiKey, branchId, dataUrl, expectedAmount });
  } catch {
    return { status: 'error' };
  }
}
