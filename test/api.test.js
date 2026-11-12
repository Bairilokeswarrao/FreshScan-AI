'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freshscan-'));
process.env.EXPOSE_RESET_TOKEN = 'true';
process.env.ADMIN_EMAIL = 'admin@example.com';

const server = require('../server');
let base;
let cookie = '';

// 1x1 red JPEG-ish PNG as data URL
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(method, url, body, extra = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, res };
}

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('health + static index', async () => {
  assert.strictEqual((await call('GET', '/api/health')).status, 200);
  const html = await fetch(base + '/');
  assert.strictEqual(html.status, 200);
  assert.match(await html.text(), /FreshScan/);
});

test('requires auth', async () => {
  assert.strictEqual((await call('GET', '/api/scans')).status, 401);
});

test('register, me, logout, login', async () => {
  let r = await call('POST', '/api/auth/register', { name: 'Tester', email: 'T@Example.com', password: 'short' });
  assert.strictEqual(r.status, 400);
  r = await call('POST', '/api/auth/register', { name: 'Tester', email: 'T@Example.com', password: 'password123' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.user.email, 't@example.com');
  assert.ok(!('passwordHash' in r.data.user));
  assert.strictEqual((await call('POST', '/api/auth/register', { email: 't@example.com', password: 'password123' })).status, 409);
  assert.strictEqual((await call('GET', '/api/auth/me')).data.user.name, 'Tester');
  await call('POST', '/api/auth/logout', {});
  cookie = '';
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 't@example.com', password: 'wrongpass1' })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 't@example.com', password: 'password123', remember: true })).status, 200);
});

test('scan: non-food rejected, food saved, history, image, delete', async () => {
  let r = await call('POST', '/api/scans', {
    image: PNG, predictions: [{ className: 'golden retriever', probability: 0.9 }],
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.error, 'not_food');

  r = await call('POST', '/api/scans', {
    image: PNG,
    predictions: [{ className: 'Granny Smith', probability: 0.8 }, { className: 'orange', probability: 0.1 }],
    features: { brightness: 0.6, saturation: 0.5, darkRatio: 0, brownRatio: 0 },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.scan.status, 'Passed / Safe');
  assert.ok(r.data.scan.score >= 75);
  const id = r.data.scan.id;

  // deterministic score for the same image
  const r2 = await call('POST', '/api/scans', {
    image: PNG,
    predictions: [{ className: 'Granny Smith', probability: 0.8 }],
    features: { brightness: 0.6, saturation: 0.5, darkRatio: 0, brownRatio: 0 },
  });
  assert.strictEqual(r2.data.scan.score, r.data.scan.score);

  // spoiled-looking features lower the score
  const bad = await call('POST', '/api/scans', {
    image: PNG, label: 'banana',
    predictions: [{ className: 'banana', probability: 0.8 }],
    features: { brightness: 0.2, saturation: 0.1, darkRatio: 0.6, brownRatio: 0.7 },
  });
  assert.ok(bad.data.scan.score < 60, `score ${bad.data.scan.score}`);
  assert.notStrictEqual(bad.data.scan.status, 'Passed / Safe');

  const list = await call('GET', '/api/scans');
  assert.strictEqual(list.data.scans.length, 3);
  const img = await fetch(base + `/api/scans/${id}/image`, { headers: { Cookie: cookie } });
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual((await call('GET', '/api/scans/stats')).data.total, 3);

  assert.strictEqual((await call('DELETE', `/api/scans/${id}`)).status, 200);
  assert.strictEqual((await call('GET', '/api/scans')).data.scans.length, 2);
  assert.strictEqual((await call('DELETE', '/api/scans')).status, 200);
  assert.strictEqual((await call('GET', '/api/scans')).data.scans.length, 0);
});

test('users cannot see each other\'s scans', async () => {
  await call('POST', '/api/scans', { image: PNG, predictions: [{ className: 'pizza', probability: 0.9 }] });
  const keep = cookie;
  cookie = '';
  await call('POST', '/api/auth/register', { email: 'other@example.com', password: 'password123' });
  assert.strictEqual((await call('GET', '/api/scans')).data.scans.length, 0);
  cookie = keep;
});

test('feedback + admin-only listing', async () => {
  assert.strictEqual((await call('POST', '/api/feedback', { rating: 9 })).status, 400);
  assert.strictEqual((await call('POST', '/api/feedback', { rating: 5, notes: 'great' })).status, 201);
  assert.strictEqual((await call('GET', '/api/feedback')).status, 403);
  cookie = '';
  await call('POST', '/api/auth/register', { email: 'admin@example.com', password: 'password123' });
  const r = await call('GET', '/api/feedback');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.feedback.length, 1);
});

test('password reset invalidates old sessions', async () => {
  cookie = '';
  await call('POST', '/api/auth/login', { email: 't@example.com', password: 'password123' });
  const oldCookie = cookie;
  const f = await call('POST', '/api/auth/forgot', { email: 't@example.com' });
  assert.ok(f.data.devToken);
  assert.strictEqual((await call('POST', '/api/auth/reset', { token: 'bad', password: 'newpassword1' })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/reset', { token: f.data.devToken, password: 'newpassword1' })).status, 200);
  cookie = oldCookie;
  assert.strictEqual((await call('GET', '/api/auth/me')).status, 401);
  cookie = '';
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 't@example.com', password: 'newpassword1' })).status, 200);
});

test('rejects bad content-type and path traversal', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.strictEqual(r.status, 415);
  const t = await fetch(base + '/..%2f..%2fserver.js');
  assert.ok([403, 404].includes(t.status));
});
