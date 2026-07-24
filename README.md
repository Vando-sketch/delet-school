# delet-school

Watches a local `__INBOX__` folder for manually-downloaded files (e.g. a zip export of a
Teams channel's files, or individual PDFs/docs — including scans and handwritten
worksheets), uses the Claude Agent SDK to solve open tasks, and files a styled solution PDF
into a per-subject Nextcloud folder tree. Automates a previously-manual workflow: read a
dropped school PDF, solve it, file it under the right subject.

```
You, manually: download/export files from Teams (zip, PDF, ...)
        │
        ▼
Send with Taildrop, to this app's tailnet device
        │
        ▼
Tailscale sidecar drains the Taildrop queue into __INBOX__
        │
        ▼
Ingest watcher ── extracts zips (one job per contained file), enqueues each file
        │
        ▼
Redis queue (BullMQ)
        │
        ▼
Worker
        ├─ 1. Extract text per-page: MarkItDown (text-layer) / ocrmypdf+Tesseract (scans) /
        │      Claude vision (handwriting or still-garbled OCR)
        ├─ 2. Claude Agent SDK: classify subject, solve every task with citations
        ├─ 3. Render a styled solution PDF (pandoc + weasyprint) — or, for a pure
        │      Materialblatt (no tasks), skip straight to filing the source
        ├─ 4. Write into Nextcloud over WebDAV (via Tailscale):
        │      Fächer/<Fach>/[<Lernfeld>/]<name>_Loesung_<date>.pdf
        └─ 5. Archive the source (OCR'd searchable version if OCR ran) into `.processed/`
             (or `.failed/` on error)
```

## Layout

- `src/ingest/` — watches a local folder and its subfolders (chokidar) for dropped files;
  extracts zip archives and enqueues one job per contained file, or enqueues a single job for
  any other file directly.
- `src/queue/` — BullMQ queue/connection shared by the ingest watcher and worker.
- `src/extract/` — per-page tiered text extraction: MarkItDown for text-layer PDFs,
  `ocrmypdf`/Tesseract for scans, rendered page images for Claude's vision fallback on
  handwriting or still-garbled OCR output.
- `src/claude/` — Claude Agent SDK integration that classifies the subject (Fach) and
  Info-/Materialblatt vs. Aufgabenblatt, and solves every task found with citations.
- `src/pdf/` — builds the solution Markdown and renders it to a styled PDF via
  `pandoc`+`weasyprint`.
- `src/nextcloud/` — writes the result into Nextcloud under `Fächer/<Fach>/[<Lernfeld>/]` over
  WebDAV.
- `src/ingest/taildropDrain.ts` — moves files the Tailscale sidecar drains from Taildrop into
  the watched inbox directory.
- `src/worker/` — wires the above together: read from disk → process → write → archive, one
  BullMQ `Worker` consuming the queue.
- `docker/`, `docker-compose.yml` — containerized ingest watcher + worker + Redis + a Tailscale
  sidecar; no Nextcloud filesystem access needed, only a WebDAV connection over the tailnet.

## Setup

```bash
npm install
cp .env.example .env   # fill in STUDENT_NAME, STUDENT_KLASSE, INGEST_WATCH_DIR + Nextcloud values
npm run dev:ingest     # local folder watcher
npm run dev:worker     # local worker
```

`STUDENT_NAME` and `STUDENT_KLASSE` are required and used to personalize solution output.

`INGEST_WATCH_DIR` defaults to `__INBOX__` in the root of the project directory - files land
there via the Tailscale sidecar draining Taildrop sends into it (see below), so it doesn't need
to be synced with anything.

To get files in: from Teams/SharePoint, use "Download" on individual files, or "Download as
zip" on a folder of files; then, on a device with Tailscale installed, send the result with
Taildrop to this app's tailnet device (`TS_HOSTNAME`). Zip archives are extracted automatically
and every file inside is processed individually; everything else (PDF, .txt, .md, ...) is
processed as-is.

Nextcloud itself only needs to be reachable over HTTPS on the tailnet (its normal web server,
at its Tailscale MagicDNS hostname) - see `.env.example` for the `NEXTCLOUD_*` and `TS_*`
variables, and `docker/tailscale/` for the sidecar that provides tailnet connectivity to the
`ingest`/`worker`/`redis` containers.

`ANTHROPIC_API_KEY` is optional: the Claude Agent SDK subprocess can instead authenticate via a
Claude Pro/Max subscription login (`claude login` in the worker's environment), which draws
from subscription rate limits rather than separate API credits. `ANTHROPIC_MODEL` is also
optional (defaults to claude-sonnet-5, since homework-solving requires more reasoning than simple task extraction).

## Commands

- `npm run typecheck` / `npm run lint` / `npm test` — must all pass before opening a PR (see `CLAUDE.md`).
- `npm run build` — compiles to `dist/`.

## Known open items

- **Breaking change (Nextcloud config)**: The old `NEXTCLOUD_DATA_DIR`, `NEXTCLOUD_TARGET_USER`,
  and `NEXTCLOUD_OCC_BIN` environment variables are no longer supported. They have been replaced
  with `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, and `NEXTCLOUD_APP_PASSWORD` (WebDAV-based).
  Existing `.env` files must be updated to use the new variables.
- The OCR-quality gate's dictionary-ratio threshold (0.45, `src/extract/pdfText.ts`) is a
  starting point, not empirically tuned; adjusting it against real scanned/handwritten homework
  is expected follow-up once this is in regular use.
