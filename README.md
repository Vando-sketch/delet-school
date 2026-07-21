# teams-task-agent

Watches a local folder for manually-downloaded files (e.g. a zip export of a Teams channel's
files, or individual PDFs/docs), uses the Claude Agent SDK to find open tasks/action items and
draft solutions, and writes the result into a Nextcloud instance running on the same host.

This exists as an alternative to a Microsoft Graph webhook integration for setups where an
Azure AD app registration isn't available (no tenant admin rights, or admin consent for
`Files.Read.All`/`Sites.Read.All` denied) - files are exported/downloaded by hand from
Teams/SharePoint instead of pulled automatically via the Graph API.

```
You, manually: download/export files from Teams (zip, PDF, ...)
        │
        ▼
Drop into the watched folder (e.g. a Nextcloud-synced directory)
        │
        ▼
Ingest watcher ── extracts zips (one job per contained file), enqueues each file
        │
        ▼
Redis queue (BullMQ)
        │
        ▼
Worker
        ├─ 1. Read the file from disk
        ├─ 2. Claude Agent SDK: find open tasks & draft solutions
        ├─ 3. Write result into Nextcloud's data dir + `occ files:scan`
        └─ 4. Archive the source file into `.processed/` (or `.failed/` on error)
```

## Layout

- `src/ingest/` — watches a local folder (chokidar) for dropped files; extracts zip archives
  and enqueues one job per contained file, or enqueues a single job for any other file directly.
- `src/queue/` — BullMQ queue/connection shared by the ingest watcher and worker.
- `src/claude/` — Claude Agent SDK integration that finds open tasks in a file and proposes
  solutions. The exact "what counts as a task" / output-shape logic is a placeholder default —
  see comments in `processFile.ts`; intended to be revisited.
- `src/nextcloud/` — writes the result directly into Nextcloud's data directory (no network hop,
  same host) and triggers `occ files:scan`.
- `src/worker/` — wires the above together: read from disk → process → write → archive, one
  BullMQ `Worker` consuming the queue.
- `docker/`, `docker-compose.yml` — containerized ingest watcher + worker + Redis, with bind
  mounts for the watched folder and Nextcloud's data directory.

## Setup

```bash
npm install
cp .env.example .env   # fill in INGEST_WATCH_DIR + Nextcloud values
npm run dev:ingest     # local folder watcher
npm run dev:worker     # local worker
```

Point `INGEST_WATCH_DIR` at whichever folder you'll drop downloaded files into. A convenient
option is a folder synced by the Nextcloud desktop/mobile client (or uploaded via Nextcloud's
web UI) — that way "upload a file to Nextcloud" is the entire manual step, with no separate
transfer to the machine running this app.

To get files in: from Teams/SharePoint, use "Download" on individual files, or "Download as
zip" on a folder of files, then drop the result into the watched folder. Zip archives are
extracted automatically and every file inside is processed individually; everything else
(PDF, .txt, .md, ...) is processed as-is.

`ANTHROPIC_API_KEY` is optional: the Claude Agent SDK subprocess can instead authenticate via a
Claude Pro/Max subscription login (`claude login` in the worker's environment), which draws
from subscription rate limits rather than separate API credits. `ANTHROPIC_MODEL` is also
optional (defaults to Haiku, since task extraction is a simple, high-volume call).

## Commands

- `npm run typecheck` / `npm run lint` / `npm test` — must all pass before opening a PR (see `CLAUDE.md`).
- `npm run build` — compiles to `dist/`.

## Known open items

- Claude processing only handles plain-text formats (`.txt`, `.md`) today — PDFs and other
  binary formats are read from disk but rejected before being sent to Claude (see the TODO in
  `src/claude/processFile.ts`). Since the point of this workflow is manually-downloaded files,
  which are very often PDFs, adding text extraction for PDF (and possibly `.docx`) is the most
  impactful next step.
- Claude processing prompt/output schema for "open tasks" is a first-pass default (see
  `src/claude/processFile.ts`), not a finalized product decision.
- The ingest watcher watches only the top level of `INGEST_WATCH_DIR` (no subfolders) and
  assumes a local/POSIX filesystem; folders synced over network filesystems or with unusual
  change-notification behavior may need `usePolling` added to the chokidar config.
