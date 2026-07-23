# PDF-to-solved-homework pipeline

Date: 2026-07-23
Status: Approved, ready for implementation planning

## Context

This repo (`teams-task-agent`) already replaced Microsoft Graph auto-ingestion with a
watched-folder pipeline (no Azure AD admin rights available): files are manually
downloaded/exported from Teams and dropped into a local folder, which is watched, queued,
processed by the Claude Agent SDK, and written into Nextcloud.

The current pipeline is a first pass that only reads `.txt`/`.md` and produces a generic
"open tasks found" summary. Separately, the user has an existing interactive Claude Code
skill (`schule-loesen`) that solves school homework dropped as PDFs into a folder
(`~/Claude/__INBOX__/`): it detects whether a PDF has a text layer or needs OCR or vision,
solves each task with citations, classifies the subject (Fach), and produces a styled PDF
filed into a per-subject folder tree.

This design merges the two: automate what `schule-loesen` did by hand, on top of the
existing watched-folder/queue/worker infrastructure.

## Goal

Drop a file (zip, PDF — text-layer, scanned, or handwritten — `.txt`, `.md`) into the inbox
folder and get a solved, styled PDF filed into the correct subject folder in Nextcloud, with
no manual steps.

## Pipeline

```
__INBOX__/ (INGEST_WATCH_DIR, default renamed from ./inbox to __INBOX__)
   │  chokidar watcher — UNCHANGED (zip extraction, one job per file, ignore
   │  .processed/.failed/.staging, awaitWriteFinish)
   ▼
extraction stage — NEW (src/extract/)
   ├─ text-layer PDF        → MarkItDown (Python subprocess) → Markdown text
   ├─ scanned PDF            → ocrmypdf -l deu+eng --deskew --rotate-pages --skip-text
   │                            locally (free, offline, Tesseract-backed) → feed the
   │                            resulting searchable PDF into MarkItDown
   └─ OCR text still garbled/handwriting → pdftoppm renders pages to PNG, Claude reads
                                            the images directly (vision), same last-resort
                                            behavior as the old skill
   Heuristic for choosing the branch: same as the old skill — run `pdftotext`, count
   non-whitespace characters; >=100 chars means a usable text layer exists (branch 1);
   otherwise attempt OCR (branch 2) and re-check the character count; if still too low,
   or the OCR'd text looks garbled, fall back to vision (branch 3).
   ▼
Claude solve step — CHANGED (src/claude/processFile.ts)
   Default model: Sonnet (was Haiku — homework solving needs more reasoning than the old
   "find TODOs" extraction job Haiku was chosen for). Still overridable via ANTHROPIC_MODEL.
   Responsibilities:
     1. Classify Info-/Materialblatt (no tasks, used as context only) vs. Aufgabenblatt.
     2. Determine Fach (subject) via the fixed lookup table below, using the document's
        own header/text as the primary signal and the file's source folder path (from the
        zip's internal structure, or the dropped file's relative path) as a secondary hint
        when the document text is ambiguous.
     3. Solve every open task fully and precisely (no filler), with concrete citations
        (§/source) in a per-task `quelle` field where applicable.
   Fach lookup table (ported as-is from schule-loesen):
     BGWP → Fächer/BGWP/Grünig, Englisch → Fächer/Englisch, Deutsch → Fächer/Deutsch,
     IT/FU-IT → Fächer/FU-IT, AEuP → Fächer/AEuP, PuG → Fächer/PuG,
     IT-Tec → Fächer/IT-Tec, Religion → Fächer/Religion.
   If the Fach cannot be determined with reasonable confidence from either signal, the
   file is *not* failed — it's routed to Fächer/_Unsortiert/ (see Output structure below).
   ▼
PDF generation — NEW (src/pdf/)
   Solved result is rendered to Markdown (frontmatter: fach, lernfeld?, thema, name,
   klasse, datum; one `## N.` block per task with Frage/Antwort/Quelle sections — see
   Template below), then built via `pandoc --template ... --css ... --pdf-engine
   weasyprint` into the final PDF. Template and stylesheet live in this repo (not
   referenced externally), so the build is fully reproducible in Docker.
   ▼
Nextcloud write — CHANGED (src/nextcloud/writeResult.ts)
   Path: Fächer/<Fach>/[<Lernfeld>/]<original-name-without-ext>_Loesung.pdf
   Unclassifiable Fach → Fächer/_Unsortiert/<...>_Loesung.pdf
   `occ files:scan` scoped to the specific computed target path (same pattern as today,
   just with a dynamic path instead of the fixed teams-task-agent subfolder).
   ▼
archive — CHANGED (src/worker/index.ts)
   .processed/ receives the OCR'd searchable PDF when the extraction stage ran OCR
   (branch 2 or 3 above), otherwise the raw original file — mirrors the old skill's
   archiving so scanned homework stays full-text-searchable in the archive.
```

## Template design (approved via visual companion)

Style "E" from brainstorming: formal serif document (Georgia/Times), centered header
(Fach/Lehrer on top in small sans-serif caps, title in bold serif, name/Klasse/date below
in muted sans-serif), each task in a bordered card. Within a card, Frage and Antwort each
get a thin colored left-rule (indigo ~`#8892b0` for Frage, green ~`#2f6b45` for Antwort)
with an uppercase letter-spaced sans-serif label above the rule — no filled/pill-badge
labels. Quelle is plain muted small text at the bottom of the card, no label styling.

## Data model changes (src/types.ts)

```ts
export interface TaskSolution {
  taskDescription: string;
  proposedSolution: string;
  quelle?: string; // paragraphs/categories/sources for this specific task
}

export interface ProcessedFileResult {
  originalFileName: string;
  tasksFound: TaskSolution[];
  summaryMarkdown: string; // now the pandoc-ready markdown body (frontmatter + task blocks)
  fach: string; // resolved subject, or "_Unsortiert"
  lernfeld?: string;
  thema: string;
}
```

## Config changes (src/config/index.ts, .env.example)

- `INGEST_WATCH_DIR` default: `./inbox` → `__INBOX__` (still overridable)
- `ANTHROPIC_MODEL` default: `claude-haiku-4-5-20251001` → a Sonnet model id
- New: `STUDENT_NAME` (e.g. "Elias Helmer"), `STUDENT_KLASSE` (e.g. "IT10b") — required,
  same pattern as `NEXTCLOUD_TARGET_USER`
- New: extraction-stage tunables as needed (e.g. OCR languages, MarkItDown invocation
  path) — exact env surface to be finalized during implementation planning

## Infra changes (docker/Dockerfile, docker-compose.yml)

Worker image needs: `poppler-utils` (`pdftotext`, `pdftoppm`), `ocrmypdf`,
`tesseract-ocr-deu`, `tesseract-ocr-eng`, `pandoc`, and a Python 3 environment with
`markitdown` and `weasyprint` installed (mirrors the old skill's dedicated venv
workaround for weasyprint's packaging issues on Debian).

## Error handling

- Extraction stage failures (MarkItDown/ocrmypdf/pandoc subprocess errors) propagate as
  job failures — same `.failed/` archiving path already in place, unchanged.
  Which of the OCR'd-vs-raw archive rule still applies based on how far extraction got.
- Ambiguous Fach is NOT an error — routes to `_Unsortiert/` (see above), consistent with
  keeping automation running unattended.
- `occ files:scan` failures remain non-fatal (already the case) — file write succeeded,
  which is what matters; log and continue.

## Testing

- Unit tests per new module (`src/extract/`, `src/pdf/`) with subprocess calls
  injected/stubbed, following the existing pattern (`CreateFileProcessorOptions.queryFn`,
  `NextcloudWriterDeps.execFile`).
- Fixture-based tests for the three extraction branches (text-layer PDF, scanned PDF,
  garbled/handwriting-forcing-vision) using small sample PDFs checked into `test/fixtures/`.
- Existing test suite (`ingest-watcher`, `nextcloudWriter`, `processFile`, `worker`) updated
  for the changed interfaces rather than rewritten from scratch.

## Out of scope

- No equivalent of the old skill's step 6 (`Improvements.md` journaling) — that was a
  habit tied to interactive Claude Code sessions, doesn't map to a headless worker.
- No changes to zip handling, BullMQ queue wiring, or `awaitWriteFinish` stability logic.
- `.docx` extraction is not addressed here (MarkItDown supports it, but no `.docx` handling
  was requested in this round — can be a fast follow since the extraction module already
  routes by file type).
