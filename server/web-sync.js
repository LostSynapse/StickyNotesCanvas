/* Server-mode storage for the self-hosted web build.
 *
 * server/server.js injects this script into index.html, so it only ever runs
 * when the app is served by that server — the Electron app and the static web
 * demo never load it. It defines window.stickyServer, which useStickyStore
 * (hooks.jsx) uses instead of localStorage.
 *
 * The whole store is one document on the server. Every write names the rev
 * it was based on; the server refuses a stale one (409) and sends back what
 * it has. Resolving that:
 *   - The other side changed only the viewport (pan/zoom, open folder,
 *     drawer): nothing of ours is at risk, so our write is retried on top.
 *   - The other side changed notes, folders, links or settings: the server's
 *     copy wins and replaces ours, and if that threw away an edit made here
 *     the user is told. A stale tab must never overwrite a day of changes
 *     made on another device just because someone panned the canvas in it.
 * When the tab comes back into view it asks for anything newer, so a
 * conflict normally needs two tabs editing within the same second or two.
 *
 * Plain script, no JSX: it has to run before Babel has transpiled anything.
 * createSync is also exported for node tests (tests/web-sync.test.mjs).
 */
(function () {
  'use strict';

  // Not part of the note content: which part of the canvas this tab shows.
  const VIEWPORT_KEYS = ['view', 'cwd', 'drawer'];
  const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];
  // Browsers cap a keepalive request body at 64 KiB.
  const KEEPALIVE_MAX_BYTES = 60000;

  const isStore = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function contentOf(store) {
    const out = {};
    for (const [k, v] of Object.entries(store || {})) if (!VIEWPORT_KEYS.includes(k)) out[k] = v;
    return JSON.stringify(out);
  }

  function createSync({
    fetch,
    api = 'api/notes',
    debounceMs = 500,
    retryDelays = RETRY_DELAYS,
    onStatus = () => {},
    onLostEdits = () => {},
  }) {
    let rev = null;           // rev of the server document we are based on; null until loaded
    let baseContent = null;   // contentOf that document
    let pending = null;       // newest local store not yet sent
    let inflight = null;      // the PUT on its way, if any
    let timer = null;         // debounce or retry timer
    let attempt = 0;          // consecutive failed attempts, for backoff
    let refreshing = false;
    let status = 'ok';        // 'ok' | 'offline' | 'signed-out' | 'error'
    let statusCode = 0;
    const listeners = new Set();

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const backoff = () => retryDelays[Math.min(attempt++, retryDelays.length - 1)];

    function setStatus(next, code = 0) {
      if (next === status && code === statusCode) return;
      status = next;
      statusCode = code;
      onStatus(status, code);
    }

    async function call(method, { body, ifMatch, ifNoneMatch, keepalive } = {}) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
      if (ifNoneMatch) headers['If-None-Match'] = `"${ifNoneMatch}"`;
      let res;
      try {
        res = await fetch(api, {
          method, headers, body, keepalive: !!keepalive,
          cache: 'no-store', credentials: 'same-origin', redirect: 'manual',
        });
      } catch {
        return { outcome: 'offline' };
      }
      if (res.status === 304) return { outcome: 'unchanged' };
      // An expired proxy session answers with a redirect to the login page
      // (opaque to fetch in a browser), or with the login page itself.
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)
          || res.status === 401 || res.status === 403) {
        return { outcome: 'signed-out', code: res.status };
      }
      let json = null;
      if (/application\/json/.test(res.headers.get('content-type') || '')) {
        try { json = await res.json(); } catch {}
      }
      if (res.ok && !json) return { outcome: 'signed-out', code: res.status };
      if (res.status >= 500 || res.status === 404) return { outcome: 'offline', code: res.status };
      return { outcome: res.status === 409 ? 'conflict' : res.ok ? 'ok' : 'error', code: res.status, json };
    }

    const validDoc = (json) => isStore(json) && typeof json.rev === 'string' && isStore(json.data);

    function takeServerDoc(doc) {
      rev = doc.rev;
      baseContent = contentOf(doc.data);
    }

    function emitRemote(data) {
      for (const fn of listeners) fn(data);
    }

    // Resolves with the store once the server has answered. Never rejects:
    // until it succeeds it keeps retrying and the app keeps its loading
    // screen, rather than showing — and saving — the demo notes over the
    // user's real ones.
    async function load() {
      for (;;) {
        const r = await call('GET');
        if (r.outcome === 'ok' && validDoc(r.json)) {
          takeServerDoc(r.json);
          attempt = 0;
          setStatus('ok');
          return r.json.data;
        }
        setStatus(r.outcome === 'signed-out' ? 'signed-out' : r.outcome === 'error' ? 'error' : 'offline', r.code);
        await sleep(backoff());
      }
    }

    function save(store) {
      if (rev === null) return;   // not loaded yet: never write over a document we haven't seen
      pending = store;
      clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    }

    function flush({ keepalive = false } = {}) {
      clearTimeout(timer);
      timer = null;
      if (inflight || pending === null || rev === null) return inflight || Promise.resolve();
      const sent = pending;
      pending = null;
      const body = JSON.stringify(sent);
      if (keepalive) keepalive = new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES;
      inflight = (async () => {
        const r = await call('PUT', { body, ifMatch: rev, keepalive });
        inflight = null;
        if (r.outcome === 'ok' && r.json && typeof r.json.rev === 'string') {
          rev = r.json.rev;
          baseContent = contentOf(sent);
          attempt = 0;
          setStatus('ok');
        } else if (r.outcome === 'conflict' && validDoc(r.json)) {
          resolveConflict(r.json, pending !== null ? pending : sent);
        } else {
          // Keep the unsaved state; anything edited meanwhile is newer still.
          if (pending === null) pending = sent;
          setStatus(r.outcome === 'conflict' ? 'error' : r.outcome, r.code);
          if (r.outcome === 'offline') timer = setTimeout(flush, backoff());
          return;
        }
        if (pending !== null) return flush();
      })();
      return inflight;
    }

    function resolveConflict(doc, local) {
      const remoteContent = contentOf(doc.data);
      attempt = 0;
      setStatus('ok');
      if (remoteContent === baseContent) {
        // Only the viewport moved over there; put our change on top.
        rev = doc.rev;
        pending = local;
        return;
      }
      const localContent = contentOf(local);
      const lost = localContent !== baseContent && localContent !== remoteContent;
      pending = null;
      takeServerDoc(doc);
      emitRemote(doc.data);
      if (lost) onLostEdits();
    }

    // Pick up changes made elsewhere. Unsaved local edits go first instead:
    // their save finds out about any conflict and resolves it.
    async function refresh() {
      if (rev === null || refreshing) return;
      if (pending !== null || inflight) return flush();
      refreshing = true;
      try {
        const r = await call('GET', { ifNoneMatch: rev });
        if (pending !== null || inflight || rev === null) return;   // edited while we waited
        if (r.outcome === 'ok' && validDoc(r.json)) {
          if (r.json.rev !== rev) {
            const changed = contentOf(r.json.data) !== baseContent;
            takeServerDoc(r.json);
            if (changed) emitRemote(r.json.data);
          }
          setStatus('ok');
        } else if (r.outcome === 'unchanged') {
          setStatus('ok');
        } else if (r.outcome === 'signed-out') {
          // Worth knowing before the next edit fails to save. A failed
          // refresh with nothing unsaved is otherwise not the user's problem.
          setStatus('signed-out', r.code);
        }
      } finally {
        refreshing = false;
      }
    }

    function retry() {
      attempt = 0;
      return pending !== null ? flush() : refresh();
    }

    function onRemoteChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return {
      load, save, flush, refresh, retry, onRemoteChange,
      hasUnsaved: () => pending !== null,
      state: () => ({ rev, pending, inflight: !!inflight, status, statusCode }),
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createSync, contentOf };
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------- Browser wiring ---------- */

  // A small notice just under the top bar, clear of the canvas controls and
  // the drawer's new-sticky button. Same fixed paper palette as the app's
  // own dialogs and the mobile banner.
  function createNotice() {
    let el = null;
    let hideTimer = null;
    function show(message, actions = [], autoHideMs = 0) {
      clearTimeout(hideTimer);
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('role', 'status');
        Object.assign(el.style, {
          position: 'fixed', left: '50%', top: '66px', transform: 'translateX(-50%)',
          maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px',
          background: '#fbf7ef', color: '#2a241a', border: '1px solid #d8cfbc',
          boxShadow: '0 6px 24px rgba(0,0,0,.2)',
          font: '13px/1.4 Inter, system-ui, sans-serif', zIndex: '30001',
        });
      }
      el.replaceChildren();
      const text = document.createElement('span');
      text.textContent = message;
      text.style.flex = '1 1 240px';
      el.append(text);
      for (const { label, onClick } of actions) {
        const b = document.createElement('button');
        b.textContent = label;
        Object.assign(b.style, {
          background: 'transparent', border: 'none', padding: '2px 4px', cursor: 'pointer',
          color: '#d97757', font: '600 13px Inter, system-ui, sans-serif',
        });
        b.addEventListener('click', onClick);
        el.append(b);
      }
      if (!el.isConnected) document.body.append(el);
      if (autoHideMs) hideTimer = setTimeout(hide, autoHideMs);
    }
    function hide() {
      clearTimeout(hideTimer);
      if (el) el.remove();
    }
    return { show, hide };
  }

  const notice = createNotice();
  const reload = { label: 'Reload', onClick: () => location.reload() };

  const sync = createSync({
    fetch: window.fetch.bind(window),
    onStatus: (status, code) => {
      const retry = { label: 'Retry', onClick: () => sync.retry() };
      if (status === 'ok') notice.hide();
      else if (status === 'offline') {
        notice.show("Can't reach the server — your notes aren't saved yet. Retrying…", [retry]);
      } else if (status === 'signed-out') {
        notice.show('Your session has expired, so changes aren’t being saved. Sign in again in another tab and press Retry, or reload.', [retry, reload]);
      } else {
        notice.show(`The server refused to save your notes${code === 413 ? ' — they are larger than it accepts' : ` (HTTP ${code})`}.`, [retry]);
      }
    },
    onLostEdits: () => {
      notice.show('These notes were changed in another tab or on another device. Showing the latest version — your most recent change here was not saved.',
        [{ label: 'OK', onClick: () => notice.hide() }], 15000);
    },
  });

  window.stickyServer = {
    load: sync.load,
    save: sync.save,
    onRemoteChange: sync.onRemoteChange,
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sync.flush({ keepalive: true });
    else sync.refresh();
  });
  window.addEventListener('focus', () => sync.refresh());
  window.addEventListener('online', () => sync.retry());
  window.addEventListener('pagehide', () => sync.flush({ keepalive: true }));
  window.addEventListener('beforeunload', (e) => {
    const { status, inflight } = sync.state();
    const unsaved = sync.hasUnsaved();
    sync.flush({ keepalive: true });
    // Ask before leaving when that last save can't go out now (one is already
    // on its way) or is unlikely to land (saving is currently failing).
    if (unsaved && (inflight || status !== 'ok')) { e.preventDefault(); e.returnValue = ''; }
  });
})();
