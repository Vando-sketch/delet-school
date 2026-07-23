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

A `tailscale` sidecar container joins the tailnet with its own node identity (auth key), and the
existing `ingest`/`worker` containers share its network namespace — giving the whole app direct
tailnet connectivity (MagicDNS resolution, routing to Nextcloud's tailnet hostname) without
installing or configuring Tailscale inside the app's own image.

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

**Known edge case:** Taildrop delivers files under their original filename; two files sent with
the same name would collide in the shared drop folder. This is the same collision risk that
already exists for direct folder drops today, so no new handling is needed — noted here as a
carried-over, not new, limitation.

### Outbound: WebDAV replaces direct filesystem + `occ`

`src/nextcloud/writeResult.ts` keeps its existing path-derivation logic untouched —
`deriveTargetDir`, `deriveFileName`, and `sanitizePathSegment` (traversal/separator
sanitization) are pure path-string logic and don't change. What changes is how the resulting
path gets written:

- **Auth**: a Nextcloud app password (created once in Nextcloud's security settings, scoped to
  one account, revocable independent of the login password), sent as HTTP Basic Auth over
  HTTPS.
- **Folder creation**: WebDAV's `MKCOL` doesn't recurse, so each path segment (`Fächer`,
  `Fächer/Mathe`, `Fächer/Mathe/Lernfeld 3`, …) is created one at a time; a `405 Method Not
  Allowed` (already exists) is treated as success, any other error throws.
- **Upload**: a `PUT` of the file bytes to
  `https://<nextcloud-host>/remote.php/dav/files/<user>/Fächer/…/<filename>`.
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
- `TAILSCALE_AUTHKEY` — the sidecar's tailnet auth key
- `TAILDROP_POLL_INTERVAL_MS` (default `5000`)

## `docker-compose.yml` changes

- Add a `tailscale` service (`tailscale/tailscale` image) with `TS_AUTHKEY`/`TS_HOSTNAME` env, a
  named volume for `/var/lib/tailscale` state, and a shared volume for the Taildrop drop
  directory. `TAILSCALE_AUTHKEY` should be a reusable (non-ephemeral) key from the Tailscale
  admin console: once the sidecar first authenticates, its identity/keys persist in the state
  volume, so later restarts reconnect from that saved state without needing the auth key again
  — an ephemeral key would still work for the first run but is meant to self-expire, which
  fights the "don't re-auth on every restart" goal.
- `ingest` and `worker` switch to `network_mode: "service:tailscale"` for direct tailnet
  connectivity (MagicDNS resolution, routing to Nextcloud's tailnet hostname). Redis stays on
  the regular bridge network, unaffected.
- The `NEXTCLOUD_DATA_DIR_HOST` bind mount and its UID-matching permission comments are deleted
  from the `worker` service entirely — this was the single biggest source of deployment
  friction and it's simply gone.

## Testing

- `test/nextcloudWriter.test.ts` is rewritten against a mocked WebDAV client (injectable the
  same way `execFile` is injected today), asserting one MKCOL call per new path segment and one
  PUT call with the expected path/body, plus the `405`-tolerant / other-error-throws MKCOL
  behavior.
- `test/ingest-watcher.test.ts` is unaffected — it still exercises chokidar against a temp
  directory; the Taildrop drain loop is a new, separately testable unit (interval → drains
  queue into a directory), not part of the watcher itself.

## Documentation changes

README's architecture diagram and setup section are updated to describe Taildrop-send +
WebDAV instead of "drop into a Nextcloud-synced folder" / bind-mounted data directory. No
changes needed to the "Known open items" list beyond noting the carried-over Taildrop filename
collision case if not already implied by the existing direct-drop collision behavior.

## Out of scope

- Changing anything in the extraction, Claude-solving, or PDF-rendering pipeline
  (`src/extract/`, `src/claude/`, `src/pdf/`) — unaffected by this change.
- `.docx` extraction, the OCR-quality heuristic, and top-level-only folder watching remain
  open items tracked separately in the README; not addressed here.
