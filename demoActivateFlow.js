#!/usr/bin/env node

/**
 * Web Activation Demo (no Solidity dependencies)
 *
 * A minimal HTTP server implementing a simple activation flow:
 *  - POST   /register         { email } -> issues activation token + 6-digit code
 *  - GET    /activate?token=  -> activates by token (simulates link click)
 *  - POST   /activate         { email, code } -> activates by code (simulates code entry)
 *  - GET    /status?email=    -> returns activation status for an email
 *  - POST   /resend           { email } -> re-issues token + code if not active
 *
 * Notes:
 *  - Uses in-memory storage (lost on restart). Good for local demos.
 *  - No external dependencies (built-in `http`, `url`, `crypto`).
 *  - Keep it on localhost; do not expose publicly without hardening.
 */

const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

// In-memory "database" keyed by email
// Record: { email, status: 'pending'|'active', token, code, createdAt, activatedAt, expiresAt }
const db = new Map();

function now() { return Date.now(); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genCode() { return ('' + Math.floor(100000 + Math.random() * 900000)); }

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function getBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').toString();
  const host = (req.headers.host || `127.0.0.1:${PORT}`).toString();
  return `${proto}://${host}`;
}

function collectJson(req, limit = 1024 * 64) { // 64KB
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const json = JSON.parse(text || '{}');
        resolve(json);
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

function issue(email) {
  const rec = {
    email,
    status: 'pending',
    token: genToken(),
    code: genCode(),
    createdAt: now(),
    activatedAt: null,
    expiresAt: now() + TOKEN_TTL_MS,
  };
  db.set(email.toLowerCase(), rec);
  return rec;
}

function findByToken(token) {
  for (const rec of db.values()) {
    if (rec.token === token) return rec;
  }
  return null;
}

function activateRecord(rec) {
  rec.status = 'active';
  rec.activatedAt = now();
  rec.token = null;
  rec.code = null;
  rec.expiresAt = null;
}

function purgeExpired() {
  const t = now();
  for (const [key, rec] of db.entries()) {
    if (rec.status === 'pending' && rec.expiresAt && rec.expiresAt < t) {
      db.delete(key);
    }
  }
}

function handleRegister(req, res, url) {
  collectJson(req).then((body) => {
    const email = (body && body.email) || url.searchParams.get('email');
    if (!isEmail(email)) return sendJson(res, 400, { ok: false, error: 'Invalid email' });

    purgeExpired();
    const rec = issue(email);
    const link = `${getBaseUrl(req)}/activate?token=${rec.token}`;

    // In real world, send via email. We return for demo purposes only.
    return sendJson(res, 200, {
      ok: true,
      email: rec.email,
      status: rec.status,
      activationLink: link,
      code: rec.code,
      expiresAt: rec.expiresAt,
    });
  }).catch((e) => {
    const status = e.status || 500;
    return sendJson(res, status, { ok: false, error: e.message || 'Failed to register' });
  });
}

function handleActivateByToken(req, res, url) {
  const token = url.searchParams.get('token');
  if (!token) return sendJson(res, 400, { ok: false, error: 'Missing token' });

  purgeExpired();
  const rec = findByToken(token);
  if (!rec) return sendJson(res, 404, { ok: false, error: 'Invalid or expired token' });
  if (rec.status === 'active') return sendJson(res, 200, { ok: true, email: rec.email, status: rec.status });
  if (rec.expiresAt && rec.expiresAt < now()) return sendJson(res, 410, { ok: false, error: 'Token expired' });

  activateRecord(rec);
  return sendJson(res, 200, { ok: true, email: rec.email, status: rec.status, activatedAt: rec.activatedAt });
}

function handleActivateByCode(req, res) {
  collectJson(req).then((body) => {
    const email = body && body.email;
    const code = body && body.code;
    if (!isEmail(email)) return sendJson(res, 400, { ok: false, error: 'Invalid email' });
    if (!/^[0-9]{6}$/.test(String(code || ''))) return sendJson(res, 400, { ok: false, error: 'Invalid code format' });

    purgeExpired();
    const rec = db.get(email.toLowerCase());
    if (!rec) return sendJson(res, 404, { ok: false, error: 'Not found' });
    if (rec.status === 'active') return sendJson(res, 200, { ok: true, email: rec.email, status: rec.status });
    if (rec.expiresAt && rec.expiresAt < now()) return sendJson(res, 410, { ok: false, error: 'Code expired' });
    if (rec.code !== String(code)) return sendJson(res, 401, { ok: false, error: 'Code mismatch' });

    activateRecord(rec);
    return sendJson(res, 200, { ok: true, email: rec.email, status: rec.status, activatedAt: rec.activatedAt });
  }).catch((e) => {
    const status = e.status || 500;
    return sendJson(res, status, { ok: false, error: e.message || 'Failed to activate' });
  });
}

function handleStatus(req, res, url) {
  const email = url.searchParams.get('email');
  if (!isEmail(email)) return sendJson(res, 400, { ok: false, error: 'Invalid email' });

  purgeExpired();
  const rec = db.get(email.toLowerCase());
  if (!rec) return sendJson(res, 200, { ok: true, email, status: 'none' });
  return sendJson(res, 200, {
    ok: true,
    email: rec.email,
    status: rec.status,
    createdAt: rec.createdAt,
    activatedAt: rec.activatedAt,
    expiresAt: rec.expiresAt,
  });
}

function handleResend(req, res) {
  collectJson(req).then((body) => {
    const email = body && body.email;
    if (!isEmail(email)) return sendJson(res, 400, { ok: false, error: 'Invalid email' });

    purgeExpired();
    let rec = db.get(email.toLowerCase());
    if (!rec) rec = issue(email);

    if (rec.status === 'active') {
      return sendJson(res, 200, { ok: true, email: rec.email, status: rec.status, message: 'Already active' });
    }

    // Re-issue
    rec.token = genToken();
    rec.code = genCode();
    rec.expiresAt = now() + TOKEN_TTL_MS;

    const link = `${getBaseUrl(req)}/activate?token=${rec.token}`;
    return sendJson(res, 200, {
      ok: true,
      email: rec.email,
      status: rec.status,
      activationLink: link,
      code: rec.code,
      expiresAt: rec.expiresAt,
    });
  }).catch((e) => {
    const status = e.status || 500;
    return sendJson(res, status, { ok: false, error: e.message || 'Failed to resend' });
  });
}

function handleRoot(req, res) {
  return sendJson(res, 200, {
    ok: true,
    name: 'Web Activation Demo',
    port: PORT,
    endpoints: {
      register: { method: 'POST', path: '/register', body: { email: 'string' } },
      activateByLink: { method: 'GET', path: '/activate?token=...' },
      activateByCode: { method: 'POST', path: '/activate', body: { email: 'string', code: '6-digit string' } },
      status: { method: 'GET', path: '/status?email=...' },
      resend: { method: 'POST', path: '/resend', body: { email: 'string' } },
    },
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS (minimal, for local testing)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && url.pathname === '/') return handleRoot(req, res);
    if (req.method === 'POST' && url.pathname === '/register') return handleRegister(req, res, url);
    if (req.method === 'GET' && url.pathname === '/activate') return handleActivateByToken(req, res, url);
    if (req.method === 'POST' && url.pathname === '/activate') return handleActivateByCode(req, res);
    if (req.method === 'GET' && url.pathname === '/status') return handleStatus(req, res, url);
    if (req.method === 'POST' && url.pathname === '/resend') return handleResend(req, res);

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Web Activation Demo listening on http://127.0.0.1:${PORT}`);
});

