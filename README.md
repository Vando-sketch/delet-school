# delet-school

Watches a local `__INBOX__` folder for manually-downloaded files (e.g. a zip export of a
Teams channel's files, or individual PDFs/docs — including scans and handwritten
worksheets), solves open tasks with Gemini (via `agy`, primary) falling back to the Claude
Agent SDK, and files a styled solution PDF into a per-subject Nextcloud folder tree. Automates
a previously-manual workflow: read a dropped school PDF, solve it, file it under the right
subject.

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
        ├─ 2. Gemini (via agy, primary) / Claude Agent SDK (fallback): classify subject,
        │      solve every task with citations
        ├─ 3. Render a styled solution PDF (pandoc + weasyprint) — or, for a pure
        │      reference sheet (no tasks), skip straight to filing the source
        ├─ 4. Write into Nextcloud over WebDAV (via Tailscale):
        │      Subjects/<Subject>/[<Module>/]<name>_Solution_<date>.pdf
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
- `src/claude/` — solve pipeline that classifies the subject and reference sheet vs. task
  sheet, and solves every task found with citations. Tries Gemini via the `agy` CLI first
  (`src/agy/`), falling back to the Claude Agent SDK on any failure.
- `src/pdf/` — builds the solution Markdown and renders it to a styled PDF via
  `pandoc`+`weasyprint`.
- `src/nextcloud/` — writes the result into Nextcloud under `Subjects/<Subject>/[<Module>/]` over
  WebDAV.
- `src/ingest/taildropDrain.ts` — moves files the Tailscale sidecar drains from Taildrop into
  the watched inbox directory.
- `src/worker/` — wires the above together: read from disk → process → write → archive, one
  BullMQ `Worker` consuming the queue.
- `docker/`, `docker-compose.yml` — containerized ingest watcher + worker + Redis + a Tailscale
  sidecar; no Nextcloud filesystem access needed, only a WebDAV connection over the tailnet.

## Setup

One command installs everything needed to run outside Docker: system PDF/OCR toolchain
(`poppler-utils`, `ocrmypdf`, `tesseract-ocr` + language packs, `pandoc`, `hunspell`
dictionaries — via `apt-get`/`dnf`/`brew`, whichever is found), a Python venv with
`markitdown`+`weasyprint`, npm dependencies, the `claude` CLI, and the `agy` CLI (installed only
if not already on `PATH`; prompts for `sudo` for system packages). Safe to re-run. Also scaffolds
`.env` from `.env.example` if it doesn't exist yet. Logs to both the terminal and `setup.log`.

```bash
npm run setup
```

(Skipped automatically inside Docker — `docker/Dockerfile` installs the same system
dependencies directly into the image; see the Docker section below.) A running Redis instance
is still required separately (`REDIS_URL`, defaults to `redis://localhost:6379`) — `npm run
setup` doesn't install or start one.

```bash
# edit .env (created by npm run setup) - fill in Nextcloud/Tailscale values, see below
npm run dev:ingest     # local folder watcher
npm run dev:worker     # local worker
```

`STUDENT_NAME` and `STUDENT_CLASS` are required and used to personalize solution output. `SUBJECTS` and `OUTPUT_LANGUAGE` are also configurable (see `.env.example` for format). Binary paths for the PDF/OCR toolchain (`PDFTOTEXT_BIN`, `PDFTOPPM_BIN`, `PDFINFO_BIN`, `OCRMYPDF_BIN`, `PANDOC_BIN`, `HUNSPELL_DE_DIC_PATH`, `HUNSPELL_EN_DIC_PATH`, `MARKITDOWN_BIN`, `WEASYPRINT_BIN`) are all overridable in `.env` if `npm run setup` installed them somewhere non-standard, or you installed them manually.

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

Gemini (via the `agy` CLI) is the primary solver for both passes — `PASS1_MODEL`/`PASS1_EFFORT`
(classification) and `PASS2_MODEL`/`PASS2_EFFORT` (solving) control which model/effort each pass
uses, `AGY_BIN` points at the `agy` binary, and `AGY_PRINT_TIMEOUT` bounds how long a call can
run. Any `agy` failure (missing binary, timeout, bad output) falls back to the Claude Agent SDK
path above automatically — see `src/claude/processFile.ts`. `agy` authenticates via a
pre-authenticated `~/.gemini` directory mounted into the worker container
(`AGY_CREDENTIAL_DIR_HOST` in Docker); this credential-mount path, and the `agy` install step in
`docker/Dockerfile`, are **not yet verified end-to-end on a real Docker host** (only interactively
on macOS) — if `agy` doesn't work in your container, the worker still functions via the Claude
fallback, just without the Gemini primary path.

## Docker

The intended production path is `docker-compose.yml`: `tailscale` (joins the tailnet, drains
Taildrop), `redis`, `ingest`, and `worker` — `ingest`/`redis` share `tailscale`'s network
namespace (`network_mode: service:tailscale`), so `REDIS_URL` must stay `redis://localhost:6379`
in Docker too, not a Compose service name.

```bash
cp .env.example .env   # fill in every required value below, then:
docker compose up -d --build
```

Beyond the vars covered above, Docker-only requirements in `.env`:

- `TS_AUTHKEY` — a Tailscale OAuth client secret (`tskey-client-...`, not a classic auth key;
  create one under the tailnet's admin console → Settings → OAuth clients) and a `tag:delet-school`
  ACL tag on the tailnet.
- `AGY_CREDENTIAL_DIR_HOST` — absolute host path to a `~/.gemini` directory produced by running
  `agy` interactively on the host once, mounted read-write into the worker container so it can
  authenticate headlessly. Required, no default (Compose doesn't expand `~`). See the
  end-to-end-unverified caveat above.
- `INGEST_WATCH_DIR_HOST` — host path for the watched inbox folder, bind-mounted into both
  `ingest` and `worker` (must resolve to the same `INGEST_WATCH_DIR` inside each container).

## Commands

- `npm run typecheck` / `npm run lint` / `npm test` — must all pass before opening a PR (see `CLAUDE.md`).
- `npm run build` — compiles to `dist/`.

## Known open items

- **Breaking change (Nextcloud config)**: The old `NEXTCLOUD_DATA_DIR`, `NEXTCLOUD_TARGET_USER`,
  and `NEXTCLOUD_OCC_BIN` environment variables are no longer supported. They have been replaced
  with `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, and `NEXTCLOUD_APP_PASSWORD` (WebDAV-based).
  Existing `.env` files must be updated to use the new variables.
- **Breaking change (subject/output config)**: `STUDENT_KLASSE` is now `STUDENT_CLASS`. The
  subject list is no longer hardcoded — configure it via `SUBJECTS` (defaults to a generic
  example set) and control generated-solution language via `OUTPUT_LANGUAGE` (defaults to
  English). Existing `.env` files must be updated.
- The OCR-quality gate's dictionary-ratio threshold (0.45, `src/extract/pdfText.ts`) is a
  starting point, not empirically tuned; adjusting it against real scanned/handwritten homework
  is expected follow-up once this is in regular use.
