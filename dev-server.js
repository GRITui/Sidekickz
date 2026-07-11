/* Sidekick — local dev server for M-AI testing, without needing a Vercel
 * deploy first. Zero dependencies (Node built-ins only).
 *
 * Serves app/ as static files and routes POST /api/draft-followup to the
 * REAL handler in api/draft-followup.js (unmodified — a tiny req/res shim
 * below adapts Vercel's (req, res) shape onto Node's raw http server, so
 * this is the exact same code that runs once deployed, not a copy).
 *
 * Reads env vars from a .env file at the repo root if present (never
 * committed — see .gitignore). Set your OWN key there; never paste it in
 * chat. Copy .env.example to .env and fill in the real values, then run:
 *   node dev-server.js
 * and open http://localhost:3000/
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  });
}
loadDotEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Adapts Vercel's (req, res) API onto Node's raw http.IncomingMessage/ServerResponse.
function vercelResShim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res; };
  return res;
}

async function serveStatic(req, res) {
  const APP_DIR = path.join(__dirname, 'app');
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(APP_DIR, reqPath);
  if (!filePath.startsWith(APP_DIR)) { res.statusCode = 403; res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('content-type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/draft-followup') {
    req.body = req.method === 'POST' ? await readJsonBody(req) : {};
    // require() on this ESM-syntax file returns the module namespace object
    // ({ default: fn }) under Node's auto-detect-module, not the fn directly.
    const mod = require('./api/draft-followup.js');
    const handler = mod.default || mod;
    await handler(req, vercelResShim(res));
    return;
  }
  await serveStatic(req, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sidekick dev server running at http://localhost:${PORT}/`);
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.log('NOTE: no ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY set — copy .env.example to .env and fill in the real (rotated) values to test the AI Draft button.');
  }
});
