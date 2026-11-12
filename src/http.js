'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Camera is needed by the app; everything else is off.
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      return reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------- tiny in-memory rate limiter ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    throw new HttpError(429, 'Too many attempts. Please try again later.');
  }
  hits.push(now);
  buckets.set(key, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600000)) buckets.delete(k);
}, 600000).unref();

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(config.PUBLIC_DIR, rel));
  if (!file.startsWith(config.PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': type,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
}

const clientIp = (req) => req.socket.remoteAddress || 'unknown';

module.exports = { HttpError, send, json, readJson, rateLimit, serveStatic, clientIp };
