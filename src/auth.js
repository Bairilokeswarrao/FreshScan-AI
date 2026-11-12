'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');

// ---------- password hashing (scrypt) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- signed session tokens (HMAC-SHA256) ----------
const b64 = (s) => Buffer.from(s).toString('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', config.SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.SECRET).update(body).digest();
  const given = Buffer.from(sig || '', 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function createSession(user, remember) {
  const ttlMs = remember
    ? config.SESSION_DAYS_REMEMBER * 86400000
    : config.SESSION_HOURS_DEFAULT * 3600000;
  const token = sign({ sub: user.id, tv: user.tokenVersion || 0, exp: Date.now() + ttlMs });
  return { token, ttlMs };
}

function userFromToken(token) {
  const payload = verify(token);
  if (!payload) return null;
  const user = store.users.find((u) => u.id === payload.sub);
  if (!user || (user.tokenVersion || 0) !== payload.tv) return null;
  return user;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
  }
  return out;
}

function getUser(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = bearer ? bearer[1] : parseCookies(req.headers.cookie).fs_token;
  return token ? userFromToken(token) : null;
}

// remember=true  -> persistent cookie (Max-Age)
// remember=false -> browser-session cookie (expires when the browser closes)
function sessionCookie(token, ttlMs, persistent) {
  const parts = [`fs_token=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (persistent) parts.push(`Max-Age=${Math.floor(ttlMs / 1000)}`);
  if (config.IS_PROD) parts.push('Secure');
  return parts.join('; ');
}

const clearCookie = () => 'fs_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt });

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

module.exports = {
  hashPassword, verifyPassword, createSession, getUser,
  sessionCookie, clearCookie, publicUser, hashToken,
};
