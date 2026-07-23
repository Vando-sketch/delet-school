# teams-task-agent

Watches a local `__INBOX__` folder for manually-downloaded files (e.g. a zip export of a
Teams channel's files, or individual PDFs/docs — including scans and handwritten
worksheets), uses the Claude Agent SDK to solve open tasks, and files a styled solution PDF
into a per-subject Nextcloud folder tree. Automates a previously-manual workflow: read a
dropped school PDF, solve it, file it under the right subject.

```
You, manually: download/export files from Teams (zip, PDF, ...)
        │
        ▼
Drop into __INBOX__ (e.g. a Nextcloud-synced directory)
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
        ├─ 4. Write into Nextcloud: Fächer/<Fach>/[<Lernfeld>/]<name>_Loesung_<date>.pdf
        │      + `occ files:scan`
        └─ 5. Archive the source (OCR'd searchable version if OCR ran) into `.processed/`
             (or `.failed/` on error)
```

## Layout

- `src/ingest/` — watches a local folder (chokidar) for dropped files; extracts zip archives
  and enqueues one job per contained file, or enqueues a single job for any other file directly.
- `src/queue/` — BullMQ queue/connection shared by the ingest watcher and worker.
- `src/extract/` — per-page tiered text extraction: MarkItDown for text-layer PDFs,
  `ocrmypdf`/Tesseract for scans, rendered page images for Claude's vision fallback on
  handwriting or still-garbled OCR output.
- `src/claude/` — Claude Agent SDK integration that classifies the subject (Fach) and
  Info-/Materialblatt vs. Aufgabenblatt, and solves every task found with citations.
- `src/pdf/` — builds the solution Markdown and renders it to a styled PDF via
  `pandoc`+`weasyprint`.
- `src/nextcloud/` — writes the result into Nextcloud's data directory under
  `Fächer/<Fach>/[<Lernfeld>/]`, and triggers `occ files:scan`.
- `src/worker/` — wires the above together: read from disk → process → write → archive, one
  BullMQ `Worker` consuming the queue.
- `docker/`, `docker-compose.yml` — containerized ingest watcher + worker + Redis, with bind
  mounts for the watched folder and Nextcloud's data directory.

## Setup

```bash
npm install
cp .env.example .env   # fill in STUDENT_NAME, STUDENT_KLASSE, INGEST_WATCH_DIR + Nextcloud values
npm run dev:ingest     # local folder watcher
npm run dev:worker     # local worker
```

`STUDENT_NAME` and `STUDENT_KLASSE` are required and used to personalize solution output.

`INGEST_WATCH_DIR` defaults to `__INBOX__` in the root of the project directory, but can be
pointed at any folder you'll drop downloaded files into. A convenient option is a folder synced
by the Nextcloud desktop/mobile client (or uploaded via Nextcloud's web UI) — that way "upload
a file to Nextcloud" is the entire manual step, with no separate transfer to the machine running
this app.

To get files in: from Teams/SharePoint, use "Download" on individual files, or "Download as
zip" on a folder of files, then drop the result into the watched folder. Zip archives are
extracted automatically and every file inside is processed individually; everything else
(PDF, .txt, .md, ...) is processed as-is.

`ANTHROPIC_API_KEY` is optional: the Claude Agent SDK subprocess can instead authenticate via a
Claude Pro/Max subscription login (`claude login` in the worker's environment), which draws
from subscription rate limits rather than separate API credits. `ANTHROPIC_MODEL` is also
optional (defaults to claude-sonnet-5, since homework-solving requires more reasoning than simple task extraction).

## Commands

- `npm run typecheck` / `npm run lint` / `npm test` — must all pass before opening a PR (see `CLAUDE.md`).
- `npm run build` — compiles to `dist/`.

## Known open items

- The OCR-quality gate (`isQualityText` in `src/extract/pdfText.ts`) uses a simple
  alphanumeric-ratio heuristic; a stronger check (e.g. dictionary-based) is a reasonable
  follow-up if it proves too permissive/strict in practice.
- The ingest watcher watches only the top level of `INGEST_WATCH_DIR` (no subfolders) and
  assumes a local/POSIX filesystem.
