# Task 16 Report: README Updates

## Summary

Successfully updated `README.md` to reflect the PDF-solve pipeline implementation completed in Tasks 1-15.

## Changes Made

### 1. Opening Paragraph (Lines 1-7)
- **Old framing**: Generic "find open tasks/action items and draft solutions" with Microsoft Graph context
- **New framing**: Describes the `__INBOX__` folder workflow, PDF-to-solution pipeline, and Nextcloud filing structure
- **Impact**: Now accurately represents the actual pipeline: watch folder → extract & solve → file results

### 2. Pipeline Diagram (Lines 9-31)
- **Old**: 4-step pipeline (read file, find tasks, write result, archive)
- **New**: 5-step pipeline with detailed text extraction strategies:
  - Step 1: Tiered text extraction (MarkItDown, ocrmypdf+Tesseract, Claude vision)
  - Step 2: Classification and task solving
  - Step 3: PDF rendering (pandoc + weasyprint)
  - Step 4: Nextcloud filing with structured path
  - Step 5: Source archival with OCR optimization
- **Impact**: Accurately reflects the PDF text extraction, classification, rendering, and filing workflow

### 3. Layout Section (Lines 34-51)
Updated all four module descriptions:
- **Added `src/extract/`**: Describes per-page tiered text extraction matching Tasks 1-3
- **Updated `src/claude/`**: Changed from generic "find tasks" to "classifies subject (Fach) and Aufgabenblatt/Materialblatt, solves every task with citations"
- **Added `src/pdf/`**: Describes Markdown building and PDF rendering via pandoc+weasyprint (Task 4)
- **Updated `src/nextcloud/`**: Clarified the Nextcloud path structure `Fächer/<Fach>/[<Lernfeld>/]` and `occ files:scan` trigger
- **Kept `src/ingest/`, `src/queue/`, `src/worker/`, `docker/`**: No changes needed

### 4. Setup Section (Lines 53-78)
- **Updated bash comment**: Now lists `STUDENT_NAME, STUDENT_KLASSE, INGEST_WATCH_DIR + Nextcloud values`
- **Added `STUDENT_NAME`/`STUDENT_KLASSE` documentation**: "required and used to personalize solution output"
- **Clarified `__INBOX__` default**: Explicitly states it defaults to `__INBOX__` in project root
- **Impact**: Users now understand the three required environment variables

### 5. Known Open Items Section (Lines 85-93)
- **Removed**: Old bullet about PDF support gap (now implemented)
- **Removed**: Old bullet about task-finding prompt being a placeholder (now properly implemented)
- **Kept/updated**: 
  - `.docx` extraction not yet wired (small follow-up)
  - OCR-quality gate uses alphanumeric-ratio heuristic (may need stronger check)
  - Ingest watcher limitations (top-level only, POSIX filesystem)
- **Impact**: PDF support gap is closed; remaining items are realistic follow-ups

## Self-Review Findings

### ✓ Stale Language Check
Searched entire file for "find open tasks", "find action items", "action items" — **all removed**. File now uses "solve open tasks" and "solve every task" language matching the actual implementation.

### ✓ Setup Section Requirements
- `STUDENT_NAME` mentioned on line 57 (bash comment) and line 62 (documentation)
- `STUDENT_KLASSE` mentioned on line 57 (bash comment) and line 62 (documentation)
- `__INBOX__` default documented on line 64

### ✓ Known Open Items Replacement
Section is fully replaced, not appended. The old PDF-support gap is now gone, replaced with realistic follow-ups (`.docx` extraction, OCR-quality heuristics, ingest watcher limitations).

### ✓ Implementation Verification
Spot-checked against actual implementation:
- **`src/extract/pdfText.ts`**: Contains `isQualityText()` with alphanumeric-ratio heuristic ✓
- **`src/pdf/renderPdf.ts`**: PDF rendering with pandoc+weasyprint ✓
- **`src/claude/processFile.ts`**: System prompt shows Fach classification and Aufgabenblatt/Materialblatt distinction ✓
- **`src/nextcloud/writeResult.ts`**: Uses `Fächer` as root directory ✓
- **Directory structure**: All modules exist (`src/extract/`, `src/claude/`, `src/pdf/`, `src/nextcloud/`) ✓

## Commit

```
99f918a docs: update README for the PDF-solve pipeline
```

## Issues or Concerns

None. The README now accurately describes the implemented PDF-solve pipeline from Tasks 1-15, with all stale language removed and all new sections properly documented.
