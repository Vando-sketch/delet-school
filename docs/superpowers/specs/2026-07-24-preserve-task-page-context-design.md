# Design Spec: Preserving Document Context & Deduplicating Ingested PDFs

## Summary

Expand the ingestion and solving pipeline (`src/claude/processFile.ts`, `src/ingest/watcher.ts`, `src/types.ts`, `src/pdf/buildMarkdown.ts`) to:
1. Capture and include non-task background information (introductory scenarios, reference notes, Infoblatt sections, code snippets, formulas, or general instructions) present on task pages into the generated solution markdown and PDF output.
2. Detect and handle duplicate PDFs during ingestion using content-based hash caching (SHA-256) to eliminate redundant LLM API calls and prevent duplicate output files in the outbox.

## Problem Statement

### 1. Loss of Document Context
When an ingested worksheet is classified as an `Aufgabenblatt` (contains tasks):
- Pass 2 currently extracts only the discrete tasks into `tasksFound: [{ title, taskDescription, proposedSolution, quelle }]`.
- Any surrounding content on the task page that is not strictly part of a numbered task question — such as overarching case studies, introductory scenario descriptions, reference data, code listings, or general instructions — is dropped from the output.
- As a result, when reviewing the generated solution PDF (`*_Loesung_YYYY-MM-DD.pdf`), the student loses the critical context, background scenario, or reference data that the questions refer to.

### 2. Redundant Processing of Duplicate PDFs
When manually downloading Teams exports or dropping files into the inbox:
- Duplicate PDFs (e.g. `05_3prozRabatt_Aufgabenstellung.pdf` vs `05_3prozRabatt_Aufgabenstellung (1).pdf`, or identical PDFs exported in multiple zips) are processed independently.
- Each duplicate triggers OCR, Pass 1 classification, and Pass 2 solving, consuming unnecessary LLM tokens and creating duplicate output PDFs in `__OUTBOX__` (or Nextcloud).

## Proposed Changes

### 1. Schema & Data Model Updates (`src/types.ts`)

Update `ProcessedFileResult` and `PASS2_JSON_SCHEMA` to include an optional document-level background context field:

```typescript
export interface ProcessedFileResult {
  originalFileName: string;
  isMaterialblatt: boolean;
  fach: FachKey;
  lernfeld?: string;
  thema: string;
  hintergrundKontext?: string; // Non-task background info, scenario descriptions, or reference notes
  tasksFound: TaskSolution[];
}
```

In `PASS2_JSON_SCHEMA`:
- Add `hintergrundKontext` (type: `string`, optional) with description: *"Zusammenfassender Einleitungstext, Hintergrund-Szenario, Infoblatt-Teile oder allgemeine Hinweise des Dokuments, die nicht Teil einer einzelnen Aufgabe sind."*

### 2. Prompt Enhancement (`src/claude/processFile.ts`)

Update `SYSTEM_PROMPT` to direct the LLM:
- **Preserve Page Context**:
  When extracting tasks from an `Aufgabenblatt`, collect any preceding or surrounding background text, case study descriptions, reference tables, or general instructions into `hintergrundKontext`.
- **Zero Information Loss**:
  Ensure that no explanatory text or reference data from the original page is omitted; if text provides context for the tasks, it must be captured in `hintergrundKontext`.

### 3. Solution Markdown & PDF Rendering (`src/pdf/buildMarkdown.ts`)

Update `buildSolutionMarkdown()` to render the background context block immediately following the YAML frontmatter and before the first task block:

```markdown
---
lang: de
fach: "IT-Tec"
thema: "Algorithmen – Lösungen"
...
---

::: {.hintergrund-kontext}
### Hintergrund & Kontext

[Extracted background scenario, reference information, or general instructions]
:::

:::: {.task}
## 1. Task Title
...
```

Add CSS rules in `docker/vorlage/style.css` for `.hintergrund-kontext` to visually distinguish the document context section (subtle background tint, left border callout) from the task solutions.

### 4. Content-Based PDF Deduplication (`src/ingest/dedup.ts`, `src/ingest/watcher.ts`)

Implement content-based duplicate handling in the ingest layer:

- **File Hashing (`src/ingest/dedup.ts`)**:
  Compute a SHA-256 hash of each incoming file's raw binary contents upon detection in `createIngestWatcher()`.
- **Processed Hash Cache**:
  Maintain a persistent SQLite / Redis / JSON hash cache of previously ingested file hashes (`.staging/.hash_cache.json` or Redis set `delet_school:processed_hashes`).
- **Deduplication Handling**:
  - When `handlePlainFile()` or `handleZip()` encounters a file whose SHA-256 hash exists in the processed hash cache:
    1. Log an informational notice (`"Duplicate file detected, skipping LLM processing"`).
    2. Skip enqueuing a BullMQ processing job for the duplicate file.
    3. Archive the duplicate source file directly into `.processed/` (or remove duplicate staging files).
  - If a file's hash is new, calculate and register the hash upon successful job completion.

### 5. Testing & Verification

- **Schema & Prompt Tests (`test/processFile.test.ts`)**:
  Verify that `PASS2_JSON_SCHEMA` includes `hintergrundKontext` and `processFile` parses and returns `hintergrundKontext` when present in LLM output.
- **Markdown Rendering Tests (`test/pdf/buildMarkdown.test.ts`)**:
  Verify `buildSolutionMarkdown` correctly formats `hintergrundKontext` when present and omits the section cleanly when absent.
- **Deduplication Tests (`test/ingest-watcher.test.ts`)**:
  Verify that dropping two identical PDF files (or a zip containing a duplicate PDF) processes the first file normally and skips job creation for the duplicate.
- **End-to-End Test Suite**:
  Ensure all unit tests continue to pass cleanly.

## Explicitly Out of Scope

- Changing classification rules in Pass 1 (`isMaterialblatt` determination remains unchanged).
- Re-processing pure material sheets (`isMaterialblatt: true`), which already write the original PDF intact into `Fächer/<Fach>/Material/`.

## Self-Review

1. **Placeholder scan**: No TBD/TODO or unfulfilled sections.
2. **Internal consistency**: Context preservation flows from LLM Pass 2 -> `ProcessedFileResult` -> PDF rendering. Deduplication sits cleanly in `ingest/watcher.ts` before jobs enter the queue.
3. **Scope check**: Addresses both user requirements (preserving page background info and deduplicating ingested PDFs).
