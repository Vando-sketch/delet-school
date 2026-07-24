### Task 16: README updates

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update the README's description, layout, setup, and "known open items" sections**

Replace the opening paragraph (currently describing a generic "find open tasks/action items and draft solutions" agent) with:

```markdown
# teams-task-agent

Watches a local `__INBOX__` folder for manually-downloaded files (e.g. a zip export of a
Teams channel's files, or individual PDFs/docs — including scans and handwritten
worksheets), uses the Claude Agent SDK to solve open tasks, and files a styled solution PDF
into a per-subject Nextcloud folder tree. Automates a previously-manual workflow: read a
dropped school PDF, solve it, file it under the right subject.
```

Update the pipeline diagram to:

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

Update the `Layout` section's `src/claude/` and `src/nextcloud/` bullets, and add bullets for `src/extract/` and `src/pdf/`:

```markdown
- `src/extract/` — per-page tiered text extraction: MarkItDown for text-layer PDFs,
  `ocrmypdf`/Tesseract for scans, rendered page images for Claude's vision fallback on
  handwriting or still-garbled OCR output.
- `src/claude/` — Claude Agent SDK integration that classifies the subject (Fach) and
  Info-/Materialblatt vs. Aufgabenblatt, and solves every task found with citations.
- `src/pdf/` — builds the solution Markdown and renders it to a styled PDF via
  `pandoc`+`weasyprint`.
- `src/nextcloud/` — writes the result into Nextcloud's data directory under
  `Fächer/<Fach>/[<Lernfeld>/]`, and triggers `occ files:scan`.
```

Update `Setup`'s `.env` instructions to mention `STUDENT_NAME`/`STUDENT_KLASSE` are required, and that `__INBOX__` is the new default watch-dir name.

Replace the `Known open items` section (the PDF-support gap is now closed) with:

```markdown
## Known open items

- `.docx` extraction is not wired up yet (MarkItDown supports it; the extraction module
  already routes by file extension, so this is a small follow-up).
- The OCR-quality gate (`isQualityText` in `src/extract/pdfText.ts`) uses a simple
  alphanumeric-ratio heuristic; a stronger check (e.g. dictionary-based) is a reasonable
  follow-up if it proves too permissive/strict in practice.
- The ingest watcher watches only the top level of `INGEST_WATCH_DIR` (no subfolders) and
  assumes a local/POSIX filesystem.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for the PDF-solve pipeline"
```

---

