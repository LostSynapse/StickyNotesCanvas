# Self-hosting Sticky Notes

This fork adds a server build of the web app. The browser app is unchanged
upstream code. Notes are stored on the server, one board per signed-in user,
instead of in each browser's `localStorage`. The desktop (Electron) app and
the static web demo are not affected.

- Image: `git.lost-synapse.com/lostsynapse/stickynotescanvas`, built for
  `linux/amd64` and `linux/arm64` by `.forgejo/workflows/build.yaml`
- Reference manifests: [`kubernetes.yaml`](kubernetes.yaml)
- Code: [`server/server.js`](../server/server.js) (HTTP server, no npm
  dependencies) and [`server/web-sync.js`](../server/web-sync.js) (the
  browser side)

## How it works

- The server serves the app's files and a small JSON API under `/api/`.
  Serving `index.html`, it adds one `<script>` that switches the app from
  `localStorage` to the API.
- Each user's whole board is one file: `DATA_DIR/users/<username>/notes.json`.
  It has the same format as the desktop app's `notes.json`.
- Every save names the revision it was based on. If the board changed on
  the server in the meantime (another tab or device), the save is refused
  and the server's copy is sent back instead:
  - If only the other side's viewport moved (pan/zoom, open folder, folders
    drawer), the refused change is re-applied on top and saved. Nothing is
    lost.
  - If the notes, folders, links or settings changed, **the server's copy
    wins**. The tab switches to it and, if that dropped an edit made there,
    it tells the user.
- A tab checks for newer changes whenever it's focused or shown again, so
  conflicts need two tabs editing within a second or two of each other.
  There's no live push; an open tab updates the next time it's focused.
- The viewport is saved with the board, so a new session opens where the
  last one left off. A tab that is already open keeps its own viewport when
  it picks up changes from elsewhere.
- Saving problems show a notice under the top bar: server unreachable
  (retries automatically), session expired (Retry / Reload), or save refused
  (for example, too large). Unsaved changes stay in the tab until a save
  succeeds.

## Container contract

| | |
|---|---|
| Port | `8080` (HTTP) |
| User | UID/GID `65532`, no shell (distroless) |
| Writes to | `DATA_DIR` only, so `readOnlyRootFilesystem: true` works |
| Health | `GET /healthz` → `200 ok`, no auth needed |
| Memory | about 65 MiB resident with every app file cached |
| Shutdown | exits cleanly on `SIGTERM`; writes are synchronous and atomic (write, fsync, rename) |

### Environment

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `/data` in the image | Persistent volume goes here |
| `USER_HEADER` | `X-authentik-username` | Request header holding the username |
| `DEFAULT_USER` | unset | Username for requests **without** that header. Only for single-user or local use; leave unset behind Authentik |
| `MAX_BODY_BYTES` | `10485760` | Largest board a save may send |

### Endpoints

| | |
|---|---|
| `GET /` and the app's files | The app. Everything else (source, `package.json`, dotfiles) is 404 |
| `GET /api/notes` | `{ rev, data }` for the current user |
| `PUT /api/notes` | Whole board as JSON. Needs `If-Match: "<rev>"`. Returns `200 { rev }`, or `409 { rev, data }` if stale |
| `GET /api/whoami` | `{ user }`. Use it to check that the auth header arrives |
| `GET /healthz` | Liveness/readiness |

Requests to `/api/` without a user get `401`.

## Deployment requirements

- **One replica, `strategy: Recreate`.** Boards are plain files, and the
  revision check is only atomic within one server process. Two pods on the
  same volume could overwrite each other.
- **ReadWriteOnce volume at `/data`.** A small one is plenty: boards are
  text (the web build doesn't store pasted images), typically tens of KB
  each. With k3s `local-path`, the pod is pinned to the node that holds the
  volume.
- **`fsGroup: 65532`** (or an otherwise writable volume) so the nonroot
  user can create `users/` in the volume.

## Authentication (Authentik)

The server has no login of its own. It trusts the `USER_HEADER` header
completely. That means:

1. **All traffic must go through the Authentik-protected ingress.** Anyone
   who can reach the Service directly can send any username and read or
   overwrite that user's notes. `kubernetes.yaml` has a NetworkPolicy that
   admits only k3s's bundled Traefik pods; keep it, or an equivalent. k3s
   enforces NetworkPolicy out of the box.
2. **The proxy must replace any client-sent copy of the header.** Traefik's
   `forwardAuth.authResponseHeaders` does this for the headers it lists, so
   `X-authentik-username` must be in that list.
3. **Don't exempt `/api/` from authentication** (for example, with an
   unauthenticated-paths rule in the Authentik provider). On an exempt path,
   the proxy doesn't set the header, so a client-sent one would get through.
   Everything under this host should require login.

Outline of the Authentik side. Check the details against the Authentik and
Traefik versions in the cluster:

- In Authentik: create a **Proxy Provider** in *Forward auth (single
  application)* mode with the app's external URL. Create an Application
  for it and add it to the outpost that Traefik talks to (for example, the
  embedded outpost).
- In Traefik: a `forwardAuth` Middleware pointing at that outpost's
  `/outpost.goauthentik.io/auth/traefik` endpoint, with `trustForwardHeader:
  true` and `authResponseHeaders` including `X-authentik-username`. Attach
  it to the app's route. Also route `/outpost.goauthentik.io/` on the app's
  host to the outpost, so the login callback works.
- Serve the app on its **own hostname at the root path**. The app uses
  relative URLs, but a path prefix isn't tested.

Verify after deploying:

1. Open `https://<host>/api/whoami` in a signed-in browser. It should show
   your username.
2. Call the Service directly from another pod. The NetworkPolicy must block
   this (the command times out):

```bash
kubectl run -it --rm probe --image=busybox:1.37 --restart=Never -- \
  wget -qO- --header 'X-authentik-username: someone' http://sticky-notes.<namespace>/api/whoami
```

When a session expires, Authentik answers the app's API calls with a
redirect to its login page. The app recognizes that and asks the user to
sign in again. It keeps unsaved changes and saves them on Retry once
they've signed in (for example, in another tab).

## Data and backups

```
/data/users/<username>/notes.json          one board per user
/data/users/_<hash>/notes.json             usernames that aren't safe as a directory name
/data/users/<username>/notes.corrupt-<ms>.json   an unreadable board, moved aside
```

- A username is used as-is when it matches `^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`.
  Otherwise the directory is `_` followed by the first 32 hex characters of
  the name's SHA-256: `printf '%s' "$name" | sha256sum | cut -c1-32`.
- If a `notes.json` isn't valid JSON, the server renames it to
  `notes.corrupt-<timestamp>.json` and serves an empty board. It never
  silently overwrites the file. Check the logs for `is not a JSON object`.
- Back up by copying the volume, or per user with the app's own Backup
  menu. Editing a `notes.json` by hand while the server runs is safe: open
  tabs pick it up the next time they're focused.
- `notes.json` has the same format as the desktop app's file, so it can be
  copied to `~/.config/sticky-notes-canvas/notes.json`, and the other way.
- **Moving notes from the public web demo (or any browser's `localStorage`):**
  there, choose Backup → Export; here, choose Backup → Restore.

## Logs

One line per API request, plus any request that failed:

```
PUT /api/notes 200 3ms user=alice
PUT /api/notes 409 1ms user=alice      # stale save refused; the tab took the server's copy
GET /api/notes 401 0ms user=-          # no user header reached the server
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/api/whoami` returns 401 through the ingress | The header isn't forwarded. Check `authResponseHeaders` and that the middleware is attached to this route |
| The notice keeps saying the session expired right after signing in | API calls are redirected even with a valid session. Check the provider's external host and the `/outpost.goauthentik.io/` route |
| "Refused … larger than it accepts" | Raise `MAX_BODY_BYTES` |
| Pod never becomes ready with the NetworkPolicy applied | The CNI is blocking kubelet probes. Allow the node CIDR in the policy |
| `EACCES` writing `/data/users` | The volume isn't writable by UID 65532. Set `fsGroup: 65532` |

## Running locally

```bash
DEFAULT_USER=me npm run serve        # http://localhost:8080, notes in ./data
docker run --rm -p 8080:8080 -e DEFAULT_USER=me -v sticky-data:/data git.lost-synapse.com/lostsynapse/stickynotescanvas:latest
```

## Not supported in the web build

- Pasting or dropping images into notes. Upstream's web build doesn't
  support it either; images need the desktop app.
- Real-time collaboration, or sharing one board between users.
