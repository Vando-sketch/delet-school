# Paperless-ngx as the document store, search layer, and ingest front end

Date: 2026-09-09
Status: Approved, ready for implementation planning

## Context

The pipeline today does this: a chokidar watcher (`src/ingest/watcher.ts`) picks files out of
`INGEST_WATCH_DIR`, extracts zips, and enqueues one BullMQ job per file. The worker
(`src/worker/index.ts`) extracts text (`src/extract/`), checks for near-duplicates
(`src/ingest/nearDup.ts`), solves tasks with Gemini-via-`agy` falling back to the Claude Agent
SDK (`src/claude/processFile.ts`), renders a solution PDF (`src/pdf/`), writes it into Nextcloud
over WebDAV (`src/nextcloud/writeResult.ts`), and moves the source file into
`INGEST_WATCH_DIR/.processed/`.

Four requirements drove this design:

1. Scan in any handed-out piece of paper or any file.
2. Organize the documents, always keeping the original.
3. Auto-solve documents that contain tasks.
4. Search across everything to find specific content.

Plus: every document should carry a "processed on" timestamp.

Measured against those, the current pipeline has three structural gaps and one bug:

- **No search at all.** Solutions land as PDFs in a Nextcloud folder tree. Finding "the sheet
  about Kaufvertrag" means remembering which subject folder it went into. There is no index, no
  metadata, no query path. Requirement 4 is at 0%.
- **The original is only half-kept.** `archiveFile()` moves the source into
  `INGEST_WATCH_DIR/.processed/` with a `Date.now()` filename prefix, on the app's local disk,
  disconnected from the solution PDF that came out of it. Nothing links the two, and
  `removeOriginalIfArchivedElsewhere()` deletes the pre-OCR original whenever OCR ran, keeping
  only the OCR'd derivative. Requirement 2 is partially met at best.
- **Timestamps are a string in a filename.** `deriveFileName()` appends `_Solution_<date>`.
  That is not a queryable timestamp, and there is only one of them — no distinction between
  "the date on the sheet" and "when we processed it".
- **Photos are rejected.** `extractFile()` accepts `.pdf`, `.txt`, `.md`, `.docx` and throws
  `unsupported file type` on anything else. A phone photo of a worksheet (`.jpg`/`.png`) — the
  most natural way to "scan in a piece of paper" — cannot enter the pipeline at all.

Building an index, a metadata model, a dedup story, an ingest front end, and a UI on top of the
current design is a large amount of work that reimplements a mature, self-hostable product.

## Goal

Make paperless-ngx the system of record for every document, and reduce delet-school to the one
thing paperless cannot do: reading a sheet, deciding whether it contains tasks, and solving
them.

Explicitly: paperless-ngx moves to the **front** of the pipeline, not the back. Documents enter
paperless first; delet-school consumes from it and writes back to it.

## Design

### Division of responsibility

Paperless-ngx owns:

| Concern | Paperless feature |
| --- | --- |
| Ingest from scanner, phone, email, API | consume directory (`PAPERLESS_CONSUMPTION_DIR`), IMAP mail ingest, `POST /api/documents/post_document/`, mobile apps |
| Image and Office input | consumes `.jpg`/`.png`/`.docx`/… and normalizes to PDF (Gotenberg/Tika for Office) |
| OCR | ocrmypdf + Tesseract, `PAPERLESS_OCR_LANGUAGE=deu+eng`, `PAPERLESS_OCR_MODE=skip` |
| Keeping the original | stores the untouched original **and** a separate archive PDF with a text layer; the original is never rewritten |
| Exact-duplicate rejection | checksum comparison at consume time |
| Timestamps | `added` (entered the system), `created` (date on the document), `modified` |
| Metadata model | tags, correspondent, document type, storage paths, custom fields |
| Full-text search | field queries (`content:`, `title:`, `tag:`), fuzzy search, "more like this", saved views |
| Folder tree | storage-path templates, derived from metadata instead of hand-built paths |
| UI | web UI plus native mobile clients |

delet-school keeps:

- Vision-based text recovery for handwriting and OCR that came out as garbage
  (`src/extract/renderPage.ts` + the Claude vision path) — paperless has no equivalent.
- Near-duplicate detection over normalized text (`src/ingest/nearDup.ts`) — paperless only
  catches byte-identical files.
- Subject/module/topic classification and task solving (`src/claude/`, `src/agy/`).
- Solution PDF rendering (`src/pdf/`).
- Zip extraction — paperless does not consume zip archives, and "download as zip" from Teams is
  the primary way files arrive.

Everything else in `src/ingest/` and all of `src/nextcloud/` is deleted.

### Flow

```
Scan / phone photo / Taildrop / Teams zip
        │
        ├─ zip ──► slim watcher: extract into <consume>/<zip-stem>/ ──┐
        └─ anything else ─────────────────────────────────────────────┤
                                                                      ▼
                                              paperless-ngx consume directory
                                                                      │
                                      OCR, original + archive PDF, checksum dedup,
                                      timestamps, storage path, workflow assigns
                                      the `dls:pending` tag
                                                                      │
                                                                      ▼
                              delet-school poller: GET /api/documents/?tags__id__all=<pending>
                                                                      │
                                                     BullMQ job, jobId `paperless:<docId>`
                                                                      ▼
                                                              delet-school worker
        ├─ 1. fetch content + archive PDF from the API
        ├─ 2. quality-gate the content; on failure render pages → Claude vision →
        │      PATCH the recovered text back into the document (it becomes searchable)
        ├─ 3. near-duplicate check over the normalized content
        ├─ 4. classify + solve (agy primary, Claude Agent SDK fallback)
        ├─ 5. write subject/module/topic back as tags, document type, custom fields
        ├─ 6. if tasks were found: render the solution PDF, upload it as a NEW document,
        │      link it to the source both ways, tag it `dls:unchecked`
        └─ 7. swap `dls:pending` for `dls:done` (or `dls:failed` + an error note)
```

### Why polling, not a post-consume webhook

Paperless offers `PAPERLESS_POST_CONSUME_SCRIPT` and, in recent versions, a webhook workflow
action. Both push. This design pulls instead:

- No HTTP server in delet-school, no shared secret, no requirement that the paperless container
  can reach the worker.
- Self-healing. If delet-school is down for a day, the backlog is simply every document still
  carrying `dls:pending`; nothing is lost and nothing needs replaying.
- Manual retry is a UI action: re-add the `dls:pending` tag to a document and it gets picked up
  again. That falls out for free.
- The version-dependent surface shrinks to one thing (a workflow that assigns a tag), which
  every supported paperless version can do.

Latency is a poll interval (default 30s). For homework, that is irrelevant.

A push hook stays a viable later optimization and is not precluded by anything here.

### Job identity and batching

The poller enqueues with `jobId: paperless:<documentId>`. BullMQ ignores an `add()` for a jobId
that already exists, so a document polled twice before its tag is swapped does not produce two
jobs. This replaces `src/ingest/dedup.ts` entirely.

Jobs are enqueued with a **settle delay** (`PAPERLESS_BATCH_SETTLE_MS`, default 60000). A Teams
zip extracts into `<consume>/<zip-stem>/`; with `PAPERLESS_CONSUMER_RECURSIVE=true` and
`PAPERLESS_CONSUMER_SUBDIRS_AS_TAGS=true`, paperless tags every file from that folder with the
zip's name. The delay gives the rest of the batch time to finish consuming, so that when the
worker builds the sibling manifest it queries `/api/documents/?tags__id__all=<batch-tag>` and
actually sees its siblings. Best-effort by construction: a sibling that consumes late is simply
missing from that job's context, exactly as a slow zip entry is today.

### Metadata schema

Bootstrapped idempotently at worker startup (`src/paperless/schema.ts`), so a fresh paperless
install needs no manual clicking.

**Document types** — `Aufgabenblatt` (has tasks), `Merkblatt` (reference sheet, no tasks),
`Lösung` (generated solution).

**Tags** — subject tags (one per configured `SUBJECTS` entry) plus pipeline tags:

| Tag | Meaning |
| --- | --- |
| `dls:pending` | queued for delet-school; assigned by a paperless consumption workflow |
| `dls:done` | processed successfully |
| `dls:failed` | processing failed; see the document's note for the error |
| `dls:unchecked` | a generated solution nobody has reviewed yet |
| `dls:near-duplicate` | flagged as similar to an existing document, solved anyway |
| `dls:duplicate` | close enough to an existing document that solving was skipped |

**Custom fields:**

| Field | Type | Set on |
| --- | --- | --- |
| `Modul` | string | source document |
| `Thema` | string | source document |
| `Verarbeitet am` | date | source document — the "processed on" timestamp |
| `Gelöst am` | date | solution document |
| `Quelldokument` | documentlink | solution → source |
| `Lösungsdokument` | documentlink | source → solution |
| `Solver` | select (`agy`, `claude`) | solution document |

Requirement "processed on" is met three ways: paperless' own `added` (when it entered),
`created` (the date on the sheet, parsed by paperless), and the explicit `Verarbeitet am` /
`Gelöst am` custom fields (when delet-school touched it). All three are queryable and sortable
in the UI.

### Writing recovered text back

Step 2 above is the one place this integration is more than plumbing. Paperless runs ocrmypdf
and stores whatever it produces — for handwriting that is usually noise, and that noise is what
lands in the search index. delet-school already renders pages to PNG and recovers text through
Claude's vision path when its dictionary-ratio gate (`src/extract/pdfText.ts`) rejects the OCR
output. Feeding that recovered text back via `PATCH /api/documents/{id}/ { content }` makes
handwritten sheets searchable.

Caveat, to be documented: this changes the indexed text, not the archive PDF's text layer.
Selecting text in the stored PDF still yields the ocrmypdf output. Accepted — the goal is
findability.

### Failure handling

On any error the worker swaps `dls:pending` for `dls:failed` and posts the error message as a
paperless note (`POST /api/documents/{id}/notes/`). Failures are therefore visible in the same
UI as everything else, with the failing document one click away, instead of in a container log.
BullMQ retries remain in place for transient errors; the tag swap happens only after retries are
exhausted.

### The review gate

A solution is never presented as verified. Every uploaded solution document carries
`dls:unchecked` until a human removes it, and a saved view ("Ungeprüfte Lösungen") lists them.

This is a deliberate constraint, not an oversight. An LLM solving vocational-school tasks is
frequently right and occasionally confidently wrong, and a rendered PDF gives no signal which
one it is. The existing per-task `source` citation in `TaskSolution` is the reviewer's tool for
telling them apart, so it stays and gets surfaced in the PDF. Turning the review gate off is a
configuration change the operator makes knowingly (`PAPERLESS_UNCHECKED_TAG=`), not a default.

## Rejected alternatives

**Paperless at the back (archive solutions into paperless, keep the current front end).** This
was the shape the requirement was originally phrased in. It leaves every ingest concern —
image input, OCR, original retention, checksum dedup, timestamps — implemented by hand in
delet-school, and gains only search over the outputs. The pre-solve documents, which are what
you actually search for, would stay outside the index.

**Keep Nextcloud as a second sink behind a flag.** Two systems of record, two places to look,
a sync story to maintain, for a benefit (solutions on the tablet) that paperless' share links
and mobile apps already cover. `src/nextcloud/` and the `webdav` dependency are removed
outright; a `NEXTCLOUD_*` variable left in an existing `.env` is inert, and the removal is
called out as a breaking change in the README.

**Store paperless' media directory inside Nextcloud.** Paperless owns those files and rewrites
them on metadata changes; a sync client racing that is a corruption bug waiting to happen.

**Replacing BullMQ/Redis with paperless as the queue.** The tag *is* the queue for
work-not-yet-started, but BullMQ still provides retry, backoff, and concurrency control that
would otherwise be reimplemented. It stays.

## Explicitly out of scope

- Migrating documents already filed into Nextcloud. They can be dropped into paperless' consume
  directory by hand; no importer is written.
- A push hook (post-consume script or webhook) — polling first, see above.
- Any LLM-driven auto-tagging beyond the subject/module/topic classification that already
  exists. Paperless' own matching rules and ML classifier handle the rest.
- Rewriting the archive PDF's text layer with vision-recovered text.
