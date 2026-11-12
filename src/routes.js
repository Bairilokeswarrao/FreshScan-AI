'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const { analyze, hashImage } = require('./analysis');
const { HttpError, json, send, rateLimit, clientIp } = require('./http');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Authentication required');
  return ctx.user;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (password.length > 128) throw new HttpError(400, 'Password is too long.');
}

function startSession(res, user, remember, status = 200) {
  const { token, ttlMs } = auth.createSession(user, remember);
  json(res, status, { user: auth.publicUser(user) }, {
    'Set-Cookie': auth.sessionCookie(token, ttlMs, remember),
  });
}

function removeScanFiles(scan) {
  if (scan.imageFile) fs.rm(path.join(config.UPLOAD_DIR, scan.imageFile), { force: true }, () => {});
}

const scanView = (s) => ({
  id: s.id, title: s.title, detectedName: s.detectedName, category: s.category,
  score: s.score, status: s.status, shelfLife: s.shelfLife, risk: s.risk,
  summary: s.summary, createdAt: s.createdAt,
  image: s.imageFile ? `/api/scans/${s.id}/image` : '',
  telemetry: s.telemetry || null,
});

function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'image must be a base64 data URL (jpeg, png or webp).');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new HttpError(400, 'Image is empty.');
  if (buf.length > config.MAX_IMAGE_BYTES) throw new HttpError(413, 'Image exceeds 5 MB.');
  return { buf, ext: m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg', mime: m[1] };
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// ======================= HEALTH =======================
route('GET', '/api/health', ({ res }) => json(res, 200, { ok: true, time: new Date().toISOString() }));

// ======================= AUTH =======================
route('POST', '/api/auth/register', ({ req, res, body }) => {
  rateLimit(`reg:${clientIp(req)}`, 10, 3600000);
  const name = str(body.name, 80);
  const email = str(body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  checkPassword(body.password);
  if (store.users.some((u) => u.email === email)) throw new HttpError(409, 'An account with this email already exists.');

  const user = {
    id: store.uid(),
    name: name || email.split('@')[0],
    email,
    passwordHash: auth.hashPassword(body.password),
    role: config.ADMIN_EMAIL && email === config.ADMIN_EMAIL ? 'admin' : 'user',
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  store.save();
  startSession(res, user, !!body.remember, 201);
});

route('POST', '/api/auth/login', ({ req, res, body }) => {
  rateLimit(`login:${clientIp(req)}`, 15, 15 * 60000);
  const email = str(body.email, 254).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const user = store.users.find((u) => u.email === email);
  // Same error for unknown email / wrong password
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, 'Incorrect email or password.');
  }
  startSession(res, user, !!body.remember);
});

route('POST', '/api/auth/logout', ({ res }) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
});

route('GET', '/api/auth/me', (ctx) => {
  json(ctx.res, 200, { user: auth.publicUser(requireUser(ctx)) });
});

route('POST', '/api/auth/forgot', ({ req, res, body }) => {
  rateLimit(`forgot:${clientIp(req)}`, 5, 3600000);
  const email = str(body.email, 254).toLowerCase();
  const user = store.users.find((u) => u.email === email);
  const out = { ok: true, message: 'If that account exists, password reset instructions have been generated.' };
  if (user) {
    const token = require('node:crypto').randomBytes(32).toString('hex');
    store.resets.push({ userId: user.id, tokenHash: auth.hashToken(token), expires: Date.now() + 3600000 });
    store.save();
    // No email service is configured: print the link so you can plug in SMTP later.
    console.log(`[password-reset] ${email}: http://localhost:${config.PORT}/?reset=${token}`);
    if (config.EXPOSE_RESET_TOKEN) out.devToken = token;
  }
  json(res, 200, out);
});

route('POST', '/api/auth/reset', ({ req, res, body }) => {
  rateLimit(`reset:${clientIp(req)}`, 10, 3600000);
  checkPassword(body.password);
  const tokenHash = auth.hashToken(str(body.token, 200));
  const rec = store.resets.find((r) => r.tokenHash === tokenHash && r.expires > Date.now());
  if (!rec) throw new HttpError(400, 'Reset link is invalid or has expired.');
  const user = store.users.find((u) => u.id === rec.userId);
  if (!user) throw new HttpError(400, 'Reset link is invalid or has expired.');
  user.passwordHash = auth.hashPassword(body.password);
  user.tokenVersion = (user.tokenVersion || 0) + 1; // invalidates all existing sessions
  store.resets.splice(0, store.resets.length, ...store.resets.filter((r) => r.userId !== user.id));
  store.save();
  json(res, 200, { ok: true, message: 'Password updated. You can now sign in.' });
});

// ======================= SCANS =======================
// Body: { image: dataURL, predictions: [{className, probability}], features?: {...}, label?, latencyMs? }
route('POST', '/api/scans', (ctx) => {
  const user = requireUser(ctx);
  const { body, res } = ctx;
  rateLimit(`scan:${user.id}`, 60, 3600000);

  const { buf, ext } = parseImage(body.image);
  const predictions = (Array.isArray(body.predictions) ? body.predictions : [])
    .slice(0, 5)
    .filter((p) => p && typeof p.className === 'string')
    .map((p) => ({ className: p.className.slice(0, 120), probability: Number(p.probability) || 0 }));
  if (!predictions.length) throw new HttpError(400, 'predictions are required.');

  const label = str(body.label, 80);
  const imageHash = hashImage(buf);
  const result = analyze({ predictions, features: body.features, label, imageHash });

  if (!result.isFood) {
    return json(res, 422, {
      error: 'not_food',
      message: `Invalid Sample: Detected non-food item ("${result.detectedName}"). Please scan food only.`,
      detectedName: result.detectedName,
    });
  }

  const id = store.uid();
  const imageFile = `${id}.${ext}`;
  fs.writeFileSync(path.join(config.UPLOAD_DIR, imageFile), buf);

  const scan = {
    id, userId: user.id, imageFile,
    title: result.title, detectedName: result.detectedName, category: result.category,
    score: result.score, status: result.status, shelfLife: result.shelfLife,
    risk: result.risk, summary: result.summary,
    telemetry: {
      latencyMs: Number.isFinite(Number(body.latencyMs)) ? Math.round(Number(body.latencyMs)) : null,
      predictions: predictions.slice(0, 3),
    },
    createdAt: new Date().toISOString(),
  };
  store.scans.unshift(scan);

  // Keep only the newest N scans per user
  const mine = store.scans.filter((s) => s.userId === user.id);
  for (const old of mine.slice(config.MAX_SCANS_PER_USER)) {
    removeScanFiles(old);
    store.scans.splice(store.scans.indexOf(old), 1);
  }
  store.save();
  json(res, 201, { scan: scanView(scan) });
});

route('GET', '/api/scans', (ctx) => {
  const user = requireUser(ctx);
  const limit = Math.min(Math.max(parseInt(ctx.query.get('limit'), 10) || 50, 1), 100);
  const scans = store.scans.filter((s) => s.userId === user.id).slice(0, limit).map(scanView);
  json(ctx.res, 200, { scans });
});

route('GET', '/api/scans/stats', (ctx) => {
  const user = requireUser(ctx);
  const mine = store.scans.filter((s) => s.userId === user.id);
  const total = mine.length;
  json(ctx.res, 200, {
    total,
    averageScore: total ? Math.round(mine.reduce((a, s) => a + s.score, 0) / total) : 0,
    safe: mine.filter((s) => s.score >= 75).length,
    caution: mine.filter((s) => s.score < 75).length,
  });
});

route('GET', '/api/scans/:id/image', (ctx) => {
  const user = requireUser(ctx);
  const scan = store.scans.find((s) => s.id === ctx.params.id && s.userId === user.id);
  if (!scan || !scan.imageFile) throw new HttpError(404, 'Image not found');
  const file = path.join(config.UPLOAD_DIR, path.basename(scan.imageFile));
  if (!fs.existsSync(file)) throw new HttpError(404, 'Image not found');
  const ext = path.extname(file).slice(1);
  send(ctx.res, 200, fs.readFileSync(file), {
    'Content-Type': ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
    'Cache-Control': 'private, max-age=86400',
  });
});

route('GET', '/api/scans/:id', (ctx) => {
  const user = requireUser(ctx);
  const scan = store.scans.find((s) => s.id === ctx.params.id && s.userId === user.id);
  if (!scan) throw new HttpError(404, 'Scan not found');
  json(ctx.res, 200, { scan: scanView(scan) });
});

route('DELETE', '/api/scans/:id', (ctx) => {
  const user = requireUser(ctx);
  const i = store.scans.findIndex((s) => s.id === ctx.params.id && s.userId === user.id);
  if (i === -1) throw new HttpError(404, 'Scan not found');
  removeScanFiles(store.scans[i]);
  store.scans.splice(i, 1);
  store.save();
  json(ctx.res, 200, { ok: true });
});

route('DELETE', '/api/scans', (ctx) => {
  const user = requireUser(ctx);
  const keep = [];
  for (const s of store.scans) (s.userId === user.id ? removeScanFiles(s) : keep.push(s));
  store.scans.splice(0, store.scans.length, ...keep);
  store.save();
  json(ctx.res, 200, { ok: true });
});

// ======================= FEEDBACK =======================
route('POST', '/api/feedback', (ctx) => {
  const user = requireUser(ctx);
  const { body, res } = ctx;
  rateLimit(`fb:${user.id}`, 20, 3600000);
  const rating = Number(body.rating);
  if (![1, 2, 3, 4, 5].includes(rating)) throw new HttpError(400, 'rating must be between 1 and 5.');
  const entry = {
    id: store.uid(), userId: user.id,
    name: str(body.name, 80) || user.name,
    category: str(body.category, 60) || 'general',
    rating,
    notes: str(body.notes, 2000),
    createdAt: new Date().toISOString(),
  };
  store.feedback.push(entry);
  store.save();
  json(res, 201, { ok: true, id: entry.id });
});

route('GET', '/api/feedback', (ctx) => {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
  json(ctx.res, 200, { feedback: [...store.feedback].reverse() });
});

module.exports = { routes };
