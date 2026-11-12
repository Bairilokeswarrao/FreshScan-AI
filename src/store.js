'use strict';
// Tiny JSON-file database: in-memory collections, atomic writes to data/db.json.
// Fine for a single-instance app / demo. To scale up, replace this module with
// PostgreSQL / MongoDB / SQLite while keeping the same collection names.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'db.json');
const fresh = () => ({ users: [], scans: [], feedback: [], resets: [] });

let db = fresh();
if (fs.existsSync(FILE)) {
  try { db = { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { console.error('Could not read db.json, starting empty:', e.message); }
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

module.exports = {
  uid: () => crypto.randomUUID(),
  save,
  get users() { return db.users; },
  get scans() { return db.scans; },
  get feedback() { return db.feedback; },
  get resets() { return db.resets; },
};
