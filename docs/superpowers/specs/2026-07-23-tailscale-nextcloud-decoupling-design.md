# Decoupling teams-task-agent from Nextcloud via Tailscale

## Problem

`teams-task-agent` currently must run on (or share a filesystem/binary with) the same host as
Nextcloud:

- `src/nextcloud/writeResult.ts` writes the solved PDF directly into Nextcloud's raw data
  directory via a bind mount (`NEXTCLOUD_DATA_DIR`), then shells out to Nextcloud's `occ
  files:scan` CLI binary (`NEXTCLOUD_OCC_BIN`) to register the new file.
- `docker-compose.yml`'s `worker` service bind-mounts `NEXTCLOUD_DATA_DIR_HOST` and documents a
  UID-matching workaround so the container process can read/write Nextcloud's data directory on
  the host.

The inbox side (`src/ingest/watcher.ts`) is already host-independent — it just watches a local
folder (`INGEST_WATCH_DIR`), conventionally a Nextcloud-synced directory, but nothing about the
watcher itself talks to Nextcloud's server.

The app should instead be deployable on any machine with Docker and network access to the
user's Tailscale tailnet, talking to Nextcloud safely over that network rather than sharing a
host with it.

## Approach

A `tailscale` sidecar container joins the tailnet with its own node identity (OAuth client
credentials, minted into short-lived keys automatically rather than a static long-lived secret),
and the existing `ingest`/`worker` containers share its network namespace — giving the whole app
direct tailnet connectivity (MagicDNS resolution, routing to Nextcloud's tailnet hostname)
without installing or configuring Tailscale inside the app's own image.

```
Your laptop (Tailscale installed)
   │  Taildrop send (zip/PDF export from Teams)
   ▼
tailscale sidecar container ── drains Taildrop queue into a shared volume
   │                             (same volume as INGEST_WATCH_DIR)
   ▼
ingest container (chokidar watch, unchanged) ── enqueues job
   ▼
Redis queue → worker container
   │
   ▼ (existing extract/solve/render pipeline, unchanged)
   │
   ▼ WebDAV PUT over the sidecar's tailnet connection
Nextcloud (reachable at its Tailscale MagicDNS hostname, e.g. https://nextcloud.<tailnet>.ts.net)
```

Two independent changes fall out of this: how files get **into** the app (inbound, via
Taildrop) and how the solved result gets **out** to Nextcloud (outbound, via WebDAV). Neither
Nextcloud's data directory nor its `occ` binary needs to be reachable from the app anymore.

### Inbound: Taildrop, existing watcher unchanged

Headless `tailscaled` (no GUI, as on a Linux container) queues incoming Taildrop files
internally rather than writing them straight to disk — they only land in a real directory once
something calls `tailscale file get <dir>`. The sidecar container runs a small loop invoking
`tailscale file get` on an interval (`TAILDROP_POLL_INTERVAL_MS`, default `5000`), writing
drained files into a directory shared via a Docker volume with the `ingest` container's
`INGEST_WATCH_DIR`.

Everything downstream is unchanged: `src/ingest/watcher.ts` keeps watching `INGEST_WATCH_DIR`
with chokidar exactly as today, with the same zip handling, stability threshold, and
`.processed`/`.failed`/`.staging` subfolders. It has no awareness that files arrived via
Taildrop instead of a synced folder.

Sending a file becomes: on a laptop with Tailscale installed, right-click a downloaded Teams
export → "Send with Taildrop" → pick the app's tailnet device.

**Mid-write races:** already handled — `src/ingest/watcher.ts` configures chokidar's
`awaitWriteFinish` (`stabilityThreshold`/`pollInterval`) specifically so a file isn't treated as
"added" until its size stops changing, which covers slow writes from any source, `tailscale
file get` included. As defense-in-depth (not because the above is insufficient), the drain loop
still writes into a staging subdirectory first and atomically renames into `INGEST_WATCH_DIR`
only once `tailscale file get` exits cleanly, so a mid-drain crash can't leave a partial file
inside the watched directory at all.

**Same-name collisions:** `handlePlainFile` in the watcher uses the on-disk filename directly as
`originalFileName`, which flows through to the final output filename in Nextcloud
(`deriveFileName` in `writeResult.ts`). So collision avoidance must not touch the filename
unconditionally (a blanket timestamp/UUID prefix would leak into every solved PDF's name). The
drain script instead checks the destination directory before the final rename: if a file of the
same name doesn't already exist there, it moves in unchanged (the common case — no side effect
on output naming); if one does, it suffixes the filename before moving. This is a small
sharpening of an existing risk (the same collision was already possible with direct folder
drops), not a new problem, but Taildrop's ability to queue several files that land in one drain
pass makes it more likely to be hit in practice, so it's worth the small mitigation.

### Outbound: WebDAV replaces direct filesystem + `occ`

`src/nextcloud/writeResult.ts` keeps its existing path-derivation logic untouched —
`deriveTargetDir`, `deriveFileName`, and `sanitizePathSegment` (traversal/separator
sanitization) are pure path-string logic and don't change. What changes is how the resulting
path gets written:

- **Auth**: a Nextcloud app password (created once in Nextcloud's security settings, scoped to
  one account, revocable independent of the login password), sent as HTTP Basic Auth over
  HTTPS.
- **Folder creation**: WebDAV's `MKCOL` doesn't recurse, so each path segment (`Fächer`,
  `Fächer/Mathe`, `Fächer/Mathe/Lernfeld 3`, …) is created top-down, one at a time, waiting for
  each to finish before the next — a parent is always created before its child's `MKCOL` fires.
  A `405 Method Not Allowed` (already exists) is treated as success. A `409 Conflict` (per RFC
  4918, the response for a missing parent) shouldn't occur given that ordering — `worker/index.ts`
  runs jobs at BullMQ's default concurrency of 1, so there's no cross-job race either — but it's
  handled explicitly anyway (treated as a bug signal: log and retry folder creation from the
  root) rather than silently left to surface as an unhandled rejection. To avoid repeating
  `MKCOL` for every file, an in-memory `Set` of already-confirmed collection paths is kept for
  the process lifetime (the Fach set is a fixed enum, so this stays small and never goes stale
  within a run).
- **Upload**: a `PUT` of the file bytes to
  `https://<nextcloud-host>/remote.php/dav/files/<user>/Fächer/…/<filename>`. Path segments
  (Fach names contain umlauts, lernfeld/filenames may contain spaces or `#`) must be
  URL-encoded — the `webdav` package does this internally, but it's called out here as an
  explicit requirement with a corresponding test case (round-tripping an umlaut/space/`#`
  Fach or filename), not left as an unverified assumption about the library's behavior.
- **`occ files:scan` is removed outright, not replaced.** WebDAV uploads go through Nextcloud's
  own storage layer and are indexed immediately, so the scan step serves no purpose here.
- **Error handling changes**: today the filesystem write is the critical part and `occ scan`
  failure is only logged (best-effort). With WebDAV, the `PUT` *is* the critical part — any
  non-2xx response throws, failing the job exactly as a write failure does today (source file
  archived to `.failed` by the existing `worker/index.ts` error path; no changes needed there).

Implementation uses the `webdav` npm package rather than hand-rolling HTTP/XML — the standard,
maintained client for MKCOL/PUT/auth, keeping `writeResult.ts` free of raw WebDAV protocol
details.

The `NextcloudWriter` interface (`writeResult(result, content, datum) → { writtenPath }`) is
unchanged, so `worker/index.ts` requires no changes.

## Configuration changes

**Removed** (nothing talks to Nextcloud's filesystem or `occ` anymore):
- `NEXTCLOUD_DATA_DIR`
- `NEXTCLOUD_OCC_BIN`
- `NEXTCLOUD_DATA_DIR_HOST`

**Added:**
- `NEXTCLOUD_BASE_URL` — e.g. `https://nextcloud.<tailnet>.ts.net`
- `NEXTCLOUD_USERNAME` — replaces `NEXTCLOUD_TARGET_USER`; same value, now used both as the
  WebDAV path segment and the Basic Auth username
- `NEXTCLOUD_APP_PASSWORD`
- `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` — replaces a static `TAILSCALE_AUTHKEY`
- `TAILDROP_POLL_INTERVAL_MS` (default `5000`)

A static auth key (even a "reusable" one) still expires — 90 days by default — unless
separately marked non-expiring in the admin console, which reintroduces a manual step this
design is trying to eliminate. Tailscale's OAuth client credentials are its recommended pattern
for unattended containers specifically for this reason: the sidecar mints its own short-lived
keys as needed rather than relying on one static secret staying valid indefinitely.

## `docker-compose.yml` changes

- Add a `tailscale` service (`tailscale/tailscale` image) with `TS_OAUTH_CLIENT_ID`/
  `TS_OAUTH_CLIENT_SECRET`/`TS_HOSTNAME` env, a named volume for `/var/lib/tailscale` state, and
  a shared volume for the Taildrop drop directory.
- `ingest`, `worker`, **and `redis`** all switch to `network_mode: "service:tailscale"`, and
  `REDIS_URL` becomes `redis://localhost:6379` (already `.env.example`'s existing default).
  This is deliberate, not incidental: `network_mode: "service:tailscale"` shares the sidecar's
  `/etc/resolv.conf`, and Tailscale's MagicDNS resolver (100.100.100.100) has no knowledge of
  Compose service names — a plain `redis:6379` lookup would fail once `ingest`/`worker` are on
  the sidecar's network namespace. Moving `redis` into that same namespace and addressing it via
  `localhost` sidesteps the DNS conflict entirely rather than working around it (e.g. via a
  separate proxy or disabling MagicDNS, which would break the WebDAV-over-MagicDNS-hostname path
  this design depends on).
- The `NEXTCLOUD_DATA_DIR_HOST` bind mount and its UID-matching permission comments are deleted
  from the `worker` service entirely — this was the single biggest source of deployment
  friction and it's simply gone.

## Testing

- `test/nextcloudWriter.test.ts` is rewritten against a mocked WebDAV client (injectable the
  same way `execFile` is injected today), asserting: one `MKCOL` call per new path segment, made
  top-down; a `405` (already exists) treated as success; a `409` logged and retried from the
  root rather than swallowed; the directory-cache avoiding repeat `MKCOL` calls within a
  process; one `PUT` call with the expected (encoded) path/body; and a round-trip test for a
  Fach/filename containing an umlaut, space, and `#`.
- `test/ingest-watcher.test.ts` is unaffected — it still exercises chokidar against a temp
  directory; the Taildrop drain loop is a new, separately testable unit (interval → drains
  queue into a staging dir → collision-checked atomic rename into the watched directory), not
  part of the watcher itself. Its own tests cover: no existing file → unchanged name; existing
  file with the same name → suffixed; a crash mid-drain leaving no partial file in
  `INGEST_WATCH_DIR`.

## Documentation changes

README's architecture diagram and setup section are updated to describe Taildrop-send +
WebDAV instead of "drop into a Nextcloud-synced folder" / bind-mounted data directory.

## Out of scope

- Changing anything in the extraction, Claude-solving, or PDF-rendering pipeline
  (`src/extract/`, `src/claude/`, `src/pdf/`) — unaffected by this change.
- `.docx` extraction, the OCR-quality heuristic, and top-level-only folder watching remain
  open items tracked separately in the README; not addressed here.
