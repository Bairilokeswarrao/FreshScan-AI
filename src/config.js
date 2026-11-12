'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

// Minimal .env loader (no dependencies)
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

function resolveSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PORT: process.env.PORT === undefined || process.env.PORT === '' ? 3000 : Number(process.env.PORT),
  HOST: process.env.HOST || '0.0.0.0',
  IS_PROD: process.env.NODE_ENV === 'production',
  SECRET: resolveSecret(),
  ADMIN_EMAIL: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  EXPOSE_RESET_TOKEN: process.env.EXPOSE_RESET_TOKEN === 'true',
  SESSION_DAYS_REMEMBER: 30,
  SESSION_HOURS_DEFAULT: 12,
  MAX_BODY_BYTES: 8 * 1024 * 1024,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  MAX_SCANS_PER_USER: 100,
};
