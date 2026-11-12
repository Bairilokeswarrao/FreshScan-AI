'use strict';
const http = require('node:http');
const config = require('./src/config');
const auth = require('./src/auth');
const { routes } = require('./src/routes');
const { HttpError, json, readJson, serveStatic } = require('./src/http');

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  }

  let matchedPath = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    matchedPath = true;
    if (r.method !== req.method) continue;

    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    return r.handler({ req, res, params, body, query: url.searchParams, user: auth.getUser(req) });
  }
  throw new HttpError(matchedPath ? 405 : 404, matchedPath ? 'Method not allowed' : 'Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) {
      if (req.url.startsWith('/api/')) return json(res, err.status, { error: err.message, ...(err.extra || {}) });
      res.writeHead(err.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(err.message);
    }
    console.error(err);
    json(res, 500, { error: 'Internal server error' });
  }
});

if (require.main === module) {
  server.listen(config.PORT, config.HOST, () => {
    console.log(`FreshScan AI running at http://localhost:${config.PORT}`);
    console.log(`Data directory: ${config.DATA_DIR}`);
  });
}

module.exports = server;
