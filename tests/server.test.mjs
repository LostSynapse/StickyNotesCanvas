import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import http from 'node:http';
import { createServer, userDirName } from '../server/server.js';

let dataDir, server, base;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-server-test-'));
  server = createServer({
    dataDir,
    userHeader: 'x-authentik-username',
    defaultUser: '',
    log: () => {},
    maxBodyBytes: 64 * 1024,
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const as = (user, headers = {}) => ({ 'x-authentik-username': user, ...headers });

function put(user, data, rev, extra = {}) {
  return fetch(`${base}/api/notes`, {
    method: 'PUT',
    headers: as(user, { 'Content-Type': 'application/json', ...(rev ? { 'If-Match': `"${rev}"` } : {}), ...extra }),
    body: typeof data === 'string' ? data : JSON.stringify(data),
  });
}

const get = (user, headers) => fetch(`${base}/api/notes`, { headers: as(user, headers) });
const notesFile = (user) => path.join(dataDir, 'users', userDirName(user), 'notes.json');

test('notes API needs a user', async () => {
  const res = await fetch(`${base}/api/notes`);
  assert.equal(res.status, 401);
});

test('a user who never saved gets an empty store at rev 0', async () => {
  const res = await get('newbie');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { rev: '0', data: {} });
});

test('save, reload, and the file on disk matches the desktop format', async () => {
  const data = { notes: [{ id: 'n1', title: 'hello' }], view: { x: 1, y: 2, z: 1 } };
  const res = await put('alice', data, '0');
  assert.equal(res.status, 200);
  const { rev } = await res.json();
  assert.match(rev, /^[0-9a-f]{32}$/);

  assert.equal(fs.readFileSync(notesFile('alice'), 'utf8'), JSON.stringify(data, null, 2));
  assert.deepEqual(await (await get('alice')).json(), { rev, data });

  const cached = await get('alice', { 'If-None-Match': `"${rev}"` });
  assert.equal(cached.status, 304);
});

test('a write based on a stale rev is refused with the current document', async () => {
  const first = await (await put('carol', { notes: [{ id: 'a' }] }, '0')).json();
  const second = await (await put('carol', { notes: [{ id: 'b' }] }, first.rev)).json();

  const stale = await put('carol', { notes: [{ id: 'stale' }] }, first.rev);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { rev: second.rev, data: { notes: [{ id: 'b' }] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(notesFile('carol'), 'utf8')), { notes: [{ id: 'b' }] });
});

test('a stale write of exactly the stored content is not a conflict', async () => {
  const data = { notes: [{ id: 'same' }] };
  const { rev } = await (await put('dave', data, '0')).json();
  const res = await put('dave', data, '0');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { rev });
});

test('a weakened ETag from a proxy still matches', async () => {
  const { rev } = await (await put('erin', { a: 1 }, '0')).json();
  const res = await put('erin', { a: 2 }, null, { 'If-Match': `W/"${rev}"` });
  assert.equal(res.status, 200);
});

test('writes without If-Match, JSON content type, or an object body are rejected', async () => {
  assert.equal((await put('frank', { a: 1 }, null)).status, 428);
  assert.equal((await put('frank', { a: 1 }, '0', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await put('frank', '[1,2]', '0')).status, 400);
  assert.equal((await put('frank', 'not json', '0')).status, 400);
  assert.equal((await put('frank', 'null', '0')).status, 400);
  assert.equal(fs.existsSync(notesFile('frank')), false);
});

test('a body over the size limit is refused', async () => {
  const res = await put('gina', { body: 'x'.repeat(70 * 1024) }, '0');
  assert.equal(res.status, 413);
  assert.equal(fs.existsSync(notesFile('gina')), false);
});

test('users are isolated from each other', async () => {
  await put('henry', { mine: true }, '0');
  assert.deepEqual(await (await get('ivy')).json(), { rev: '0', data: {} });
});

test('usernames that are not safe directory names are hashed', async () => {
  for (const user of ['../escape', '..', '.hidden', 'Zoë', 'a/b', '_looks-hashed']) {
    const res = await put(user, { who: user }, '0');
    assert.equal(res.status, 200, user);
    const dir = userDirName(user);
    assert.match(dir, /^_[0-9a-f]{32}$/, user);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'users', dir, 'notes.json'), 'utf8')), { who: user });
  }
  assert.deepEqual(fs.readdirSync(dataDir), ['users']);
  assert.equal(userDirName('jane.doe@example.com'), 'jane.doe@example.com');
});

test('a corrupt notes file is moved aside, never served as empty and overwritten', async () => {
  const file = notesFile('kate');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"notes": [truncated');
  assert.deepEqual(await (await get('kate')).json(), { rev: '0', data: {} });
  const aside = fs.readdirSync(path.dirname(file)).filter(f => /^notes\.corrupt-\d+\.json$/.test(f));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8'), '{"notes": [truncated');
});

test('whoami reports the user', async () => {
  const res = await fetch(`${base}/api/whoami`, { headers: as('liam') });
  assert.deepEqual(await res.json(), { user: 'liam' });
});

test('other methods on the notes API are refused', async () => {
  const res = await fetch(`${base}/api/notes`, { method: 'POST', headers: as('liam') });
  assert.equal(res.status, 405);
});

test('DEFAULT_USER covers requests without the header', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-server-test-'));
  const single = createServer({ dataDir: dir, userHeader: 'x-authentik-username', log: () => {}, defaultUser: 'me', maxBodyBytes: 1024 });
  await new Promise(r => single.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${single.address().port}`;
    assert.deepEqual(await (await fetch(`${url}/api/whoami`)).json(), { user: 'me' });
    const res = await fetch(`${url}/api/whoami`, { headers: as('someone') });
    assert.deepEqual(await res.json(), { user: 'someone' });
  } finally {
    await new Promise(r => single.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healthz needs no user', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

test('the page gets web-sync.js injected before the app scripts', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const sync = html.indexOf('<script src="./web-sync.js"></script>');
  assert.ok(sync > 0);
  assert.ok(sync < html.indexOf('</head>'));
  assert.ok(sync < html.indexOf('src="app.jsx"'));
  const js = await fetch(`${base}/web-sync.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /window\.stickyServer =/);
});

test('app files are served, compressed and revalidated', async () => {
  for (const p of ['/index.html', '/app.jsx', '/utils.jsx', '/vendor/react.production.min.js', '/assets/fonts/inter-400.woff2']) {
    assert.equal((await fetch(`${base}${p}`)).status, 200, p);
  }
  // fetch() would transparently gunzip; read the bytes as sent.
  const raw = await new Promise((resolve, reject) => {
    http.get(`${base}/vendor/react.production.min.js`, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  assert.equal(raw.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(raw.body), fs.readFileSync(new URL('../vendor/react.production.min.js', import.meta.url)));
  const etag = (await fetch(`${base}/app.jsx`)).headers.get('etag');
  assert.equal((await fetch(`${base}/app.jsx`, { headers: { 'If-None-Match': etag } })).status, 304);
});

test('nothing outside the app files is served', async () => {
  for (const p of ['/main.js', '/preload.js', '/storage.js', '/package.json', '/server/server.js',
    '/.git/config', '/vendor/../main.js', '/%2e%2e/main.js', '/vendor/%2e%2e/main.js', '/assets/',
    '/tests/server.test.mjs', '/README.md']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
  }
  const res = await fetch(`${base}/index.html`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});
