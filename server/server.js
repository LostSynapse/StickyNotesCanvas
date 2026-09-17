#!/usr/bin/env node
/* Self-hosted web server for Sticky Notes.
 *
 * Serves the web build (the same files the Electron app loads) plus a small
 * per-user notes API, so notes live on the server instead of in each
 * browser's localStorage. No npm dependencies — node: built-ins only.
 *
 *   GET  /api/notes   -> 200 { rev, data }, or 304 when If-None-Match is rev
 *   PUT  /api/notes   <- the whole store as JSON, If-Match: "<rev>" required
 *                     -> 200 { rev }, or 409 { rev, data } when rev is stale
 *   GET  /api/whoami  -> 200 { user }
 *   GET  /healthz     -> 200 ok (no user needed)
 *
 * The store is one JSON document per user — the same shape, and the same
 * pretty-printed file, as the desktop app's notes.json. `rev` is a hash of
 * that file's bytes, so it survives restarts and notices an edit made to the
 * file by hand. A write must name the rev it was based on; a stale one is
 * refused with the current document, so a tab that missed changes made
 * elsewhere can't silently overwrite them. server/web-sync.js is the
 * browser half of that contract.
 *
 * WHO the user is comes from a header set by the authenticating reverse
 * proxy (USER_HEADER, default X-authentik-username). The server trusts it
 * blindly: it must only be reachable through that proxy. See deploy/README.md.
 *
 * Environment:
 *   PORT            8080
 *   HOST            0.0.0.0
 *   DATA_DIR        ./data   (notes at DATA_DIR/users/<user>/notes.json)
 *   USER_HEADER     X-authentik-username
 *   DEFAULT_USER    unset    (user for requests without the header; single-user setups only)
 *   MAX_BODY_BYTES  10485760
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const APP_ROOT = path.resolve(__dirname, '..');

// Everything a browser may fetch, mirroring the renderer half of
// package.json's build.files. Anything else — main.js, storage.js,
// package.json, .git, the server itself — is a 404.
const STATIC_FILES = new Set(['index.html', 'app.jsx', 'components.jsx', 'hooks.jsx', 'utils.jsx']);
const STATIC_DIRS = ['vendor/', 'assets/'];

const CONTENT_TYPES = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.jsx':   'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.jsx', '.css', '.json', '.svg']);

// The rev of a user who has never saved. Real revs are 32 hex chars.
const EMPTY_REV = '0';

// Usernames that are safe to use as a directory name as they are. Starting
// with an alphanumeric rules out '.', '..' and leading '-' or '_', and the
// '_' rule is what keeps the hashed names below from ever colliding.
const PLAIN_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function configFromEnv(env = process.env) {
  return {
    port: env.PORT ? Number(env.PORT) : 8080,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    userHeader: (env.USER_HEADER || 'X-authentik-username').toLowerCase(),
    defaultUser: env.DEFAULT_USER || '',
    maxBodyBytes: env.MAX_BODY_BYTES ? Number(env.MAX_BODY_BYTES) : 10 * 1024 * 1024,
  };
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const revOf = (bytes) => sha256(bytes).slice(0, 32);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function userDirName(user) {
  return PLAIN_USER_RE.test(user) ? user : '_' + sha256(user).slice(0, 32);
}

// An entity tag from If-Match / If-None-Match, without quotes or a weak
// prefix — a compressing proxy may weaken the ETag it passed along.
function parseEtag(header) {
  if (!header) return null;
  const first = String(header).split(',')[0].trim().replace(/^W\//, '');
  return first.replace(/^"(.*)"$/, '$1') || null;
}

/* ---------- Notes on disk ---------- */

function readNotes(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { rev: EMPTY_REV, data: {} };
    throw err;
  }
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!isPlainObject(data)) {
    // Never serve an unreadable file as "empty": the client would save its
    // defaults straight over it. Move it aside for a human and start fresh.
    const aside = file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
    fs.renameSync(file, aside);
    console.warn(`[notes] ${file} is not a JSON object; moved it to ${aside}`);
    return { rev: EMPTY_REV, data: {} };
  }
  return { rev: revOf(bytes), data };
}

function writeNotes(file, bytes) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch {}
}

/* ---------- Static files ---------- */

// Resolve a request path to a servable file relative to APP_ROOT, or null.
function staticPath(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel === '/') rel = '/index.html';
  if (rel === '/web-sync.js') return 'server/web-sync.js';
  if (rel.includes('\0') || rel.includes('\\')) return null;
  rel = rel.slice(1);
  if (rel.split('/').some(seg => seg === '' || seg.startsWith('.'))) return null;
  if (STATIC_FILES.has(rel)) return rel;
  if (STATIC_DIRS.some(dir => rel.startsWith(dir))) return rel;
  return null;
}

// index.html gets the server-mode storage script, which must run before the
// app's own scripts. Nothing else is changed.
function injectSyncScript(html) {
  const tag = '<script src="./web-sync.js"></script>\n</head>';
  if (!html.includes('</head>')) throw new Error('index.html has no </head> to inject web-sync.js before');
  return html.replace('</head>', tag);
}

function createStaticCache(appRoot) {
  const cache = new Map();
  return function load(rel) {
    const file = path.join(appRoot, rel);
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const hit = cache.get(rel);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const ext = path.extname(rel);
    let body = fs.readFileSync(file);
    if (rel === 'index.html') body = Buffer.from(injectSyncScript(body.toString('utf8')), 'utf8');
    const entry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      body,
      gzip: COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body) : null,
      etag: `"${revOf(body)}"`,
      type: CONTENT_TYPES[ext] || 'application/octet-stream',
    };
    cache.set(rel, entry);
    return entry;
  };
}

/* ---------- HTTP helpers ---------- */

const acceptsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

function send(req, res, status, headers, body) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.writeHead(status);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, obj, extraHeaders = {}) {
  let body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...extraHeaders,
  };
  if (body.length > 1024 && acceptsGzip(req)) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  send(req, res, status, headers, body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('request body too large'), { code: 'TOO_LARGE' });
    if (Number(req.headers['content-length']) > limit) return reject(tooLarge());
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.removeAllListeners('data'); reject(tooLarge()); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------- Server ---------- */

function createServer(config) {
  const log = config.log || console.log;
  const loadStatic = createStaticCache(APP_ROOT);
  // Fail at startup, not on the first page load, if the page can't be served.
  if (!loadStatic('index.html')) throw new Error(`index.html not found under ${APP_ROOT}`);

  const userOf = (req) => {
    const raw = req.headers[config.userHeader];
    const name = String(Array.isArray(raw) ? raw[0] : raw || '').trim();
    return name || config.defaultUser || null;
  };
  const notesFile = (user) => path.join(config.dataDir, 'users', userDirName(user), 'notes.json');

  function getNotes(req, res, user) {
    const current = readNotes(notesFile(user));
    const etag = `"${current.rev}"`;
    if (parseEtag(req.headers['if-none-match']) === current.rev) {
      return send(req, res, 304, { ETag: etag, 'Cache-Control': 'no-store' });
    }
    sendJson(req, res, 200, current, { ETag: etag });
  }

  async function putNotes(req, res, user) {
    const base = parseEtag(req.headers['if-match']);
    if (!base) return sendJson(req, res, 428, { error: 'If-Match with the rev this change is based on is required' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return sendJson(req, res, 415, { error: 'Content-Type must be application/json' });
    }
    let raw;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      if (err.code !== 'TOO_LARGE') throw err;
      res.on('finish', () => req.destroy());
      return sendJson(req, res, 413, { error: `notes are larger than ${config.maxBodyBytes} bytes` }, { Connection: 'close' });
    }
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch {}
    if (!isPlainObject(data)) return sendJson(req, res, 400, { error: 'body must be a JSON object' });

    // Synchronous from the read to the write, so no other request can
    // slip in between the rev check and the rename.
    const file = notesFile(user);
    const current = readNotes(file);
    const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    const rev = revOf(bytes);
    // Already what's stored: nothing to write, and nothing to conflict with
    // even if the base is stale (two tabs making the same change).
    if (rev === current.rev) return sendJson(req, res, 200, { rev });
    if (base !== current.rev) return sendJson(req, res, 409, current);
    writeNotes(file, bytes);
    sendJson(req, res, 200, { rev });
  }

  function serveStatic(req, res, rel) {
    const entry = loadStatic(rel);
    if (!entry) return sendJson(req, res, 404, { error: 'not found' });
    const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', ETag: entry.etag };
    if (entry.gzip) headers.Vary = 'Accept-Encoding';
    if (parseEtag(req.headers['if-none-match']) === entry.etag.slice(1, -1)) {
      return send(req, res, 304, headers);
    }
    if (entry.gzip && acceptsGzip(req)) {
      headers['Content-Encoding'] = 'gzip';
      return send(req, res, 200, headers, entry.gzip);
    }
    send(req, res, 200, headers, entry.body);
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const reading = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/healthz') {
      if (!reading) return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      return send(req, res, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'ok\n');
    }

    if (pathname.startsWith('/api/')) {
      const user = userOf(req);
      if (!user) return sendJson(req, res, 401, { error: `no user: the ${config.userHeader} header is missing` });
      if (pathname === '/api/whoami' && reading) return sendJson(req, res, 200, { user });
      if (pathname === '/api/notes') {
        if (reading) return getNotes(req, res, user);
        if (req.method === 'PUT') return putNotes(req, res, user);
        return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, PUT' });
      }
      return sendJson(req, res, 404, { error: 'not found' });
    }

    if (!reading) return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    const rel = staticPath(pathname);
    if (!rel) return sendJson(req, res, 404, { error: 'not found' });
    serveStatic(req, res, rel);
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      // API traffic and failures only; a page load is dozens of static hits.
      if (req.url.startsWith('/api/') || res.statusCode >= 400) {
        log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms user=${userOf(req) || '-'}`);
      }
    });
    handle(req, res).catch((err) => {
      console.error(`[server] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  // Outlive the ingress proxy's idle upstream connections, or it will now
  // and then reuse one this server has just closed and answer 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

function main() {
  const config = configFromEnv();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`[server] Sticky Notes on http://${config.host}:${config.port}, notes in ${config.dataDir}`);
    console.log(`[server] user from the ${config.userHeader} header` +
      (config.defaultUser ? `, or "${config.defaultUser}" when it is missing` : '; requests without it get 401'));
  });
  const stop = (signal) => {
    console.log(`[server] ${signal}, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) main();

module.exports = { createServer, configFromEnv, userDirName, parseEtag, staticPath, EMPTY_REV };
