// server/web-sync.js driven against a real server/server.js — the conflict
// rules are the part of the self-hosted build that can lose notes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer } = require('../server/server.js');
const { createSync } = require('../server/web-sync.js');

let dataDir, server, api;
let userSeq = 0;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-sync-test-'));
  server = createServer({ dataDir, userHeader: 'x-authentik-username', log: () => {}, defaultUser: '', maxBodyBytes: 1 << 20 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${server.address().port}/api/notes`;
});

after(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, label) {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

// One browser tab for `user`. `net` lets a test break the network under it.
function tab(user, { delayMs = 0 } = {}) {
  const net = { down: false, withUser: true, respond: null };
  const events = { remote: [], lost: 0, statuses: [] };
  const sync = createSync({
    api,
    debounceMs: 5,
    retryDelays: [10],
    fetch: async (url, init) => {
      if (delayMs) await sleep(delayMs);
      if (net.down) throw new TypeError('fetch failed');
      if (net.respond) return net.respond();
      const headers = { ...init.headers, ...(net.withUser ? { 'x-authentik-username': user } : {}) };
      return fetch(url, { ...init, headers });
    },
    onStatus: (s) => events.statuses.push(s),
    onLostEdits: () => { events.lost++; },
  });
  sync.onRemoteChange((data) => events.remote.push(data));
  const settled = () => until(() => !sync.state().inflight && sync.state().pending === null, `${user} to settle`);
  return { sync, net, events, settled };
}

const newUser = () => `user${++userSeq}`;

async function onServer(user) {
  const res = await fetch(api, { headers: { 'x-authentik-username': user } });
  return res.json();
}

const board = (notes, view = { x: 0, y: 0, z: 1 }) => ({ notes, folders: { root: { id: 'root' } }, cwd: 'root', view, drawer: true });

test('nothing is saved before the first load, then saves reach the server', async () => {
  const user = newUser();
  const a = tab(user);
  a.sync.save(board(['too early']));
  await sleep(30);
  assert.deepEqual(await onServer(user), { rev: '0', data: {} });

  assert.deepEqual(await a.sync.load(), {});
  a.sync.save(board(['hello']));
  await a.settled();
  assert.deepEqual((await onServer(user)).data, board(['hello']));
});

test('saves made while one is on its way are sent after it, not as a conflict', async () => {
  const user = newUser();
  const a = tab(user, { delayMs: 20 });
  await a.sync.load();
  for (let i = 0; i < 6; i++) {
    a.sync.save(board([`v${i}`]));
    await sleep(12);
  }
  await a.settled();
  assert.deepEqual((await onServer(user)).data, board(['v5']));
  assert.deepEqual(a.events.remote, []);
  assert.equal(a.events.lost, 0);
});

test('a stale tab loses to the server when the notes changed there, and says so', async () => {
  const user = newUser();
  const a = tab(user), b = tab(user);
  await a.sync.load();
  await b.sync.load();

  a.sync.save(board(['from A']));
  await a.settled();
  b.sync.save(board(['from B']));
  await b.settled();

  const server = await onServer(user);
  assert.deepEqual(server.data, board(['from A']));
  assert.deepEqual(b.events.remote, [board(['from A'])]);
  assert.equal(b.events.lost, 1);
  assert.equal(b.sync.state().rev, server.rev);

  // Based on the server's copy now, B's next change goes through.
  b.sync.save(board(['from A', 'B again']));
  await b.settled();
  assert.deepEqual((await onServer(user)).data, board(['from A', 'B again']));
});

test('when the other tab only moved the viewport, the stale tab\'s change is kept', async () => {
  const user = newUser();
  const a = tab(user), b = tab(user);
  a.sync.save(board(['start']));   // ignored: not loaded
  await a.sync.load();
  a.sync.save(board(['start']));
  await a.settled();
  await b.sync.load();

  a.sync.save(board(['start'], { x: 500, y: 500, z: 2 }));
  await a.settled();
  b.sync.save(board(['start', 'added in B']));
  await b.settled();

  assert.deepEqual((await onServer(user)).data, board(['start', 'added in B']));
  assert.deepEqual(b.events.remote, []);
  assert.equal(b.events.lost, 0);
});

test('a conflict that lands on the same notes is not reported as a lost change', async () => {
  const user = newUser();
  const a = tab(user), b = tab(user);
  await a.sync.load();
  await b.sync.load();
  a.sync.save(board(['same'], { x: 1, y: 1, z: 1 }));
  await a.settled();
  b.sync.save(board(['same'], { x: 2, y: 2, z: 1 }));
  await b.settled();
  assert.equal(b.events.lost, 0);
});

test('refresh brings in note changes but ignores viewport-only ones', async () => {
  const user = newUser();
  const a = tab(user), b = tab(user);
  await a.sync.load();
  await b.sync.load();

  a.sync.save(board(['changed']));
  await a.settled();
  await b.sync.refresh();
  assert.deepEqual(b.events.remote, [board(['changed'])]);

  a.sync.save(board(['changed'], { x: 7, y: 7, z: 3 }));
  await a.settled();
  await b.sync.refresh();
  assert.equal(b.events.remote.length, 1);
  assert.equal(b.sync.state().rev, (await onServer(user)).rev);

  await b.sync.refresh();   // nothing new: 304
  assert.equal(b.events.remote.length, 1);
  assert.equal(b.events.lost, 0);
});

test('a refresh with unsaved edits saves them instead of overwriting them', async () => {
  const user = newUser();
  const a = tab(user);
  await a.sync.load();
  a.sync.save(board(['unsaved']));
  await a.sync.refresh();
  await a.settled();
  assert.deepEqual((await onServer(user)).data, board(['unsaved']));
  assert.deepEqual(a.events.remote, []);
});

test('offline: the change is kept and retried until the server is back', async () => {
  const user = newUser();
  const a = tab(user);
  await a.sync.load();
  a.net.down = true;
  a.sync.save(board(['written offline']));
  await until(() => a.sync.state().status === 'offline', 'offline status');
  assert.ok(a.sync.hasUnsaved());
  await sleep(40);
  a.net.down = false;
  await until(() => a.sync.state().status === 'ok' && !a.sync.hasUnsaved(), 'retry to succeed');
  await a.settled();
  assert.deepEqual((await onServer(user)).data, board(['written offline']));
});

test('signed out: the change is kept, not retried on its own, and saved on Retry', async () => {
  const user = newUser();
  const a = tab(user);
  await a.sync.load();
  a.net.withUser = false;   // what a proxy that lost the session looks like to the server: 401
  a.sync.save(board(['while signed out']));
  await until(() => a.sync.state().status === 'signed-out', 'signed-out status');
  await sleep(40);
  assert.ok(a.sync.hasUnsaved());
  assert.deepEqual(await onServer(user), { rev: '0', data: {} });

  a.net.withUser = true;
  await a.sync.retry();
  await a.settled();
  assert.equal(a.sync.state().status, 'ok');
  assert.deepEqual((await onServer(user)).data, board(['while signed out']));
});

test('a redirect or a login page instead of JSON counts as signed out', async () => {
  for (const respond of [
    () => new Response(null, { status: 302, headers: { Location: '/outpost.goauthentik.io/start' } }),
    () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  ]) {
    const a = tab(newUser());
    await a.sync.load();
    a.net.respond = respond;
    a.sync.save(board(['x']));
    await until(() => a.sync.state().status === 'signed-out', 'signed-out status');
    assert.ok(a.sync.hasUnsaved());
  }
});

test('load keeps retrying until the server answers', async () => {
  const user = newUser();
  const a = tab(user);
  a.net.down = true;
  const loading = a.sync.load();
  await until(() => a.events.statuses.includes('offline'), 'offline status');
  a.net.down = false;
  assert.deepEqual(await loading, {});
  assert.equal(a.sync.state().status, 'ok');
});
