# Paperless-ngx Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make paperless-ngx the ingest front end, document store, and search layer, and reduce delet-school to classification, task solving, and vision-based text recovery. Delivers all four product requirements (scan anything in, organize while keeping originals, auto-solve tasks, search everything) plus queryable "processed on" timestamps.

**Architecture:** A new `src/paperless/` module owns all API contact: a typed client (`client.ts`), idempotent tag/document-type/custom-field bootstrap (`schema.ts`), and a poller (`poller.ts`) that replaces the chokidar file watcher as the queue's producer. `FileJobData` becomes `PaperlessJobData { documentId }`; the worker fetches content and the archive PDF over the API instead of reading from disk, and writes classification, solutions, and failures back as paperless metadata. `src/ingest/watcher.ts` shrinks to a zip extractor that feeds paperless' consume directory; `src/ingest/dedup.ts` and all of `src/nextcloud/` are deleted.

**Tech Stack:** Node 20/TypeScript (existing), BullMQ/ioredis (existing), vitest (existing), paperless-ngx + PostgreSQL + Gotenberg + Tika (new Compose services). No new npm dependencies — the paperless client uses the built-in `fetch`; `webdav` is removed.

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-09-09-paperless-ngx-integration-design.md`.
- `npm run typecheck` / `npm run lint` / `npm test` must all pass before opening a PR (repo `CLAUDE.md`).
- Every task follows TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- No test performs real network I/O. The paperless client takes an injected `fetch`-shaped function, matching the existing DI patterns (`ExecFileFn` in `src/lib/execFile.ts`, `NextcloudWriterDeps` in `src/nextcloud/writeResult.ts`).
- No comments explaining *what* code does — only non-obvious *why* (matches existing codebase style).
- Tasks 1-3 are independent of each other and can run in parallel. Tasks 4-11 are a chain and must run in order. Tasks 12-13 are cleanup and must run last, after 11 is verified — the old Nextcloud path stays functional until the paperless path works end to end.
- The pipeline is not expected to be runnable end to end until Task 11 completes. Do not delete the Nextcloud path early to "simplify"; a half-migrated repo with no working sink is worse than a repo with two.

---

## File Structure

```
src/
  paperless/
    client.ts          NEW   typed paperless REST client (fetch injected)
    schema.ts          NEW   idempotent bootstrap of tags/document types/custom fields
    poller.ts          NEW   polls the pending tag, enqueues BullMQ jobs
    index.ts           NEW   re-exports
  queue/index.ts       MOD   FileJobData -> PaperlessJobData
  worker/index.ts      MOD   fetch from API, write back to API, no disk archiving
  extract/index.ts     MOD   new entry point that starts from paperless content + archive PDF
  ingest/
    watcher.ts         MOD   shrinks to: zip -> extract into consume dir; other -> move there
    dedup.ts           DEL   replaced by BullMQ jobId + paperless checksum dedup
    nearDup.ts         MOD   signature record keyed by paperless document id
    siblingManifest.ts MOD   built from the paperless batch tag, not the zip batch
  nextcloud/           DEL   entire directory
  config/index.ts      MOD   paperless.* added, nextcloud.* removed
docker-compose.yml     MOD   paperless-ngx + postgres + gotenberg + tika services
.env.example           MOD   PAPERLESS_* added, NEXTCLOUD_* removed
README.md              MOD   rewritten flow diagram, setup, breaking-change note
test/
  paperless/
    client.test.ts     NEW
    schema.test.ts     NEW
    poller.test.ts     NEW
  worker.test.ts       MOD   rewritten against the paperless client
  ingest-watcher.test.ts MOD  zip-extraction cases kept, enqueue cases removed
  ingest-dedup.test.ts DEL
  nextcloudWriter.test.ts DEL
```

---

## Phase A — Foundation (nothing existing is touched)

### Task 1: Paperless stack in Compose + configuration

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `src/config/index.ts`
- Test: `test/config.test.ts`

**Interfaces:** Produces `config.paperless.{baseUrl,apiToken,pollIntervalMs,batchSettleMs,pendingTag,doneTag,failedTag,uncheckedTag,consumeDir}` — consumed by Tasks 2, 3, 4.

- [ ] Add `paperless`, `paperless-db` (PostgreSQL), `gotenberg`, and `tika` services. Paperless reuses the existing `redis` service for its broker; give it a distinct `PAPERLESS_REDIS` database index so BullMQ and paperless do not share keyspace.
- [ ] Set `PAPERLESS_OCR_LANGUAGE=deu+eng`, `PAPERLESS_OCR_MODE=skip`, `PAPERLESS_CONSUMER_RECURSIVE=true`, `PAPERLESS_CONSUMER_SUBDIRS_AS_TAGS=true`, `PAPERLESS_FILENAME_FORMAT` for the storage-path tree.
- [ ] Bind-mount the consume directory into both `paperless` and `ingest` (the slim watcher writes into it) — one host path, one variable, same as the existing `INGEST_WATCH_DIR_HOST` pattern.
- [ ] Add the `config.paperless` section following the existing `optional()` convention. `baseUrl`/`apiToken` are lazy getters (`() => string`), matching `config.nextcloud`, so importing config without paperless configured does not throw.
- [ ] Document every new variable in `.env.example`, including how to mint an API token in the paperless UI.
- [ ] Test: defaults resolve, an empty-string `PAPERLESS_POLL_INTERVAL_MS` falls back rather than becoming `NaN` (the `optional()` empty-string trap the existing tests already cover).

### Task 2: Paperless API client

**Files:**
- Create: `src/paperless/client.ts`
- Test: `test/paperless/client.test.ts`

**Interfaces:** Produces `createPaperlessClient(deps?: { fetch?: FetchFn }): PaperlessClient` with:
`listDocumentsByTag(tagId)`, `getDocument(id)`, `downloadArchive(id, destPath)`, `patchDocument(id, patch)`, `uploadDocument(bytes, meta)`, `addNote(id, text)`, `listTags()`, `createTag(name)`, `listDocumentTypes()`, `createDocumentType(name)`, `listCustomFields()`, `createCustomField(name, dataType)`.
Consumed by Tasks 3-11.

- [ ] Auth via `Authorization: Token <PAPERLESS_API_TOKEN>` on every request.
- [ ] Handle paginated list responses (`{count, next, previous, results}`) — follow `next` until exhausted.
- [ ] `uploadDocument` posts multipart to `/api/documents/post_document/`; that endpoint returns a **task id, not a document id**. Poll `/api/tasks/?task_id=` until it resolves and return the resulting document id. Getting this wrong silently breaks the source↔solution link in Task 10, so cover it with a test.
- [ ] Non-2xx responses throw with status and body included; the worker's error path (Task 11) surfaces that text in a paperless note.
- [ ] Tests inject a fake `fetch`: happy path per method, pagination across two pages, upload task polling (pending → complete), and error-body propagation.

### Task 3: Metadata schema bootstrap

**Files:**
- Create: `src/paperless/schema.ts`
- Test: `test/paperless/schema.test.ts`

**Interfaces:** Consumes the Task 2 client. Produces `ensureSchema(client): Promise<SchemaIds>` where `SchemaIds` maps every tag/document-type/custom-field name from the spec to its paperless id. Consumed by Tasks 4, 9, 10, 11.

- [ ] Create, if missing: document types `Aufgabenblatt`/`Merkblatt`/`Lösung`; tags `dls:pending`, `dls:done`, `dls:failed`, `dls:unchecked`, `dls:near-duplicate`, `dls:duplicate`, plus one tag per `SUBJECT_KEYS` entry; custom fields `Modul`, `Thema`, `Verarbeitet am`, `Gelöst am`, `Quelldokument`, `Lösungsdokument`, `Solver`.
- [ ] Idempotent: list first, create only what is absent, never rename or delete anything. Run once at worker and poller startup.
- [ ] Test: a fresh instance creates everything; a fully-populated instance creates nothing; a partially-populated instance creates exactly the gap.

---

## Phase B — Move the pipeline over (ordered chain)

### Task 4: Poller replaces the watcher as the queue producer

**Files:**
- Create: `src/paperless/poller.ts`
- Modify: `src/queue/index.ts`, `package.json` (`dev:poller`/`start:poller` scripts)
- Test: `test/paperless/poller.test.ts`

**Interfaces:** `PaperlessJobData { documentId: number; batchTagId?: number }` replaces `FileJobData`. Consumed by Tasks 5-11.

- [ ] Poll `listDocumentsByTag(pendingTagId)` every `pollIntervalMs`; enqueue each result with `jobId: \`paperless:${documentId}\`` and `delay: batchSettleMs`.
- [ ] Do not remove the pending tag here — the worker owns the swap (Task 11), so a crash between poll and processing leaves the document queued rather than lost.
- [ ] Derive `batchTagId` from any tag on the document that is neither a pipeline tag nor a subject tag (i.e. a subdir-as-tag from a zip extraction), if present.
- [ ] Tests: enqueues one job per pending document; re-enqueueing the same document is a no-op (`jobId` collision); an empty pending list does nothing; an API error is logged and the next tick still runs.

### Task 5: Worker fetches from paperless instead of disk

**Files:** Modify `src/worker/index.ts`, `src/extract/index.ts`; Test: `test/worker.test.ts`

- [ ] `handleJob` takes `documentId`: `getDocument()` for `content`/`title`/`tags`, `downloadArchive()` into the per-job scratch dir.
- [ ] Add `extractFromPaperless(content, archivePdfPath, workDir)` alongside the existing `extractFile()`: run the existing dictionary quality gate (`isQualityText`) over paperless' `content` and, on failure, render the failing pages and produce `visionPages` exactly as today. `extractFile()` itself stays for now (it is deleted in Task 12 only if nothing else uses it).
- [ ] Delete `archiveFile()`, `removeOriginalIfArchivedElsewhere()`, and the `.processed`/`.failed` handling from the worker — paperless owns retention now.
- [ ] Tests: content passing the gate produces no vision pages; failing content triggers page rendering; the scratch dir is always cleaned up (keep the existing `finally`-block coverage).

### Task 6: Write recovered text back into paperless

**Files:** Modify `src/worker/index.ts`; Test: `test/worker.test.ts`

- [ ] When the vision path produced better text than paperless' `content`, `patchDocument(id, { content })` before classification so the search index reflects it.
- [ ] "Better" is decided by the same `isQualityText` gate, not by length — a longer garbage string must not win.
- [ ] Never patch when the vision path did not run, and never patch an empty string.
- [ ] Test: garbage content plus successful vision recovery patches; good content does not patch; failed vision recovery does not patch.

### Task 7: Sibling manifest from the batch tag

**Files:** Modify `src/ingest/siblingManifest.ts`, `src/worker/index.ts`; Test: `test/ingest-siblingManifest.test.ts`

- [ ] When `batchTagId` is set, fetch the other documents carrying that tag and build the manifest from their `content`, reusing the existing per-entry and total character budgets.
- [ ] Exclude the job's own document.
- [ ] Test: excerpts are truncated to the existing budgets; the own document is excluded; a missing `batchTagId` yields an empty manifest.

### Task 8: Near-duplicate detection keyed by document id

**Files:** Modify `src/ingest/nearDup.ts`, `src/worker/index.ts`; Test: `test/ingest-nearDup.test.ts`

- [ ] `SignatureRecord` stores `{ simhash, documentId, title, recordedAt }` instead of `originalFileName`. The SimHash/Hamming logic itself is unchanged.
- [ ] `duplicate` tier: tag the document `dls:duplicate`, skip solving, finish successfully. `flagged` tier: tag `dls:near-duplicate` and solve anyway. Both tiers still record their own signature unconditionally (existing behaviour).
- [ ] Test: the tier→tag mapping, and that a duplicate never reaches the solver.

### Task 9: Classification results written back as metadata

**Files:** Modify `src/worker/index.ts`; Test: `test/worker.test.ts`

- [ ] After `processFile()`: set the subject tag, set the document type (`Merkblatt` when `isReferenceSheet`, else `Aufgabenblatt`), and set the `Modul`, `Thema`, and `Verarbeitet am` custom fields.
- [ ] Preserve tags already on the document — patch the union, never overwrite the array wholesale (a hand-applied tag must survive).
- [ ] An unknown subject key must not throw the way `deriveTargetDir()` does today; fall back to the configured unsorted subject and log.
- [ ] Test: tag union preserved; reference sheet vs. task sheet document type; unknown subject falls back instead of throwing.

### Task 10: Upload and link the solution document

**Files:** Modify `src/worker/index.ts`; Test: `test/worker.test.ts`

- [ ] Reference sheets (`isReferenceSheet`) produce no solution document; the source is fully filed by Task 9 and the job ends.
- [ ] Otherwise: `buildSolutionMarkdown()` + `renderSolutionPdf()` unchanged, then `uploadDocument()` with title `<source title> — Lösung`, document type `Lösung`, the subject tag, `dls:unchecked`, `Gelöst am`, and `Solver`.
- [ ] Set `Quelldokument` on the solution and `Lösungsdokument` on the source — both directions, so either document leads to the other.
- [ ] `dls:unchecked` is skipped only when `PAPERLESS_UNCHECKED_TAG` is explicitly empty.
- [ ] Test: reference sheet uploads nothing; a task sheet uploads once and links both ways; an upload failure propagates to the Task 11 error path.

### Task 11: Terminal tagging and failure notes

**Files:** Modify `src/worker/index.ts`; Test: `test/worker.test.ts`

- [ ] On success: remove `dls:pending`, add `dls:done`.
- [ ] On failure after BullMQ retries are exhausted: remove `dls:pending`, add `dls:failed`, and `addNote()` with the error message. Re-adding `dls:pending` by hand in the UI is the documented retry path.
- [ ] The tag swap must not run on intermediate retry attempts — check `job.attemptsMade` against the configured attempts.
- [ ] A failing `addNote()` must not mask the original error (same defensive shape as the existing archive-failure `catch`).
- [ ] Test: success path swaps tags; final failure tags and notes; a non-final failure leaves tags alone; a note failure still rethrows the original error.

---

## Phase C — Remove the old path (only after Task 11 is verified)

### Task 12: Shrink the ingest watcher, delete file dedup

**Files:** Modify `src/ingest/watcher.ts`; Delete `src/ingest/dedup.ts`, `test/ingest-dedup.test.ts`; Modify `test/ingest-watcher.test.ts`

- [ ] The watcher keeps exactly one job: watch `INGEST_WATCH_DIR`, extract a dropped zip into `<consume>/<zip-stem>/`, move anything else into `<consume>/`. No hashing, no queue, no batch ids, no `.processed`/`.failed`.
- [ ] Keep `awaitWriteFinish` and the `renameOrCopy` EXDEV handling — both still matter when writing into a bind-mounted consume directory.
- [ ] Delete `src/ingest/dedup.ts` (BullMQ `jobId` plus paperless' checksum dedup cover it) and its test.
- [ ] Trim `test/ingest-watcher.test.ts` to the zip-extraction and file-move cases.

### Task 13: Delete the Nextcloud path and update the docs

**Files:** Delete `src/nextcloud/`, `test/nextcloudWriter.test.ts`; Modify `src/types.ts`, `src/config/index.ts`, `package.json`, `docker-compose.yml`, `.env.example`, `README.md`

- [ ] Remove `NextcloudWriter`, `NextcloudWriteContent`, `config.nextcloud`, the `webdav` dependency, and every `NEXTCLOUD_*` variable.
- [ ] Keep the Tailscale sidecar — it is still how Taildrop delivery reaches the box; only the Nextcloud target goes away.
- [ ] Rewrite the README flow diagram, the setup instructions (paperless first-run, API token, workflow that assigns `dls:pending`), and the search/review workflow.
- [ ] Add to "Known open items": the vision-recovered text is patched into the index but not into the archive PDF's text layer; and the whole paperless path is unverified end to end until Task 14.
- [ ] Breaking-change note: `NEXTCLOUD_*` variables are gone, `PAPERLESS_*` are required.

### Task 14: End-to-end verification runbook

**Files:** Create `docs/paperless-e2e-checklist.md`

The repo's standing weakness is that no path has been verified on real hardware (`agy` in Docker, the WebDAV write, real scans). This task does not add code; it produces the checklist that closes that gap, run manually against a real paperless instance:

- [ ] Phone photo of a printed worksheet → appears in paperless with OCR text, original retained.
- [ ] Handwritten sheet → OCR is garbage, vision recovery patches readable text, the sheet is findable by searching a word that only appears in the handwriting.
- [ ] Teams zip → every contained file consumed, all sharing the batch tag, sibling context present in the solve.
- [ ] Task sheet → solution document created, `dls:unchecked` set, both links navigable.
- [ ] Reference sheet → filed with `Merkblatt`, no solution document.
- [ ] Same sheet submitted twice, re-scanned → the second is tagged duplicate and not solved twice.
- [ ] Worker stopped for an hour → the backlog drains on restart with nothing lost.
- [ ] Forced failure (e.g. revoked `agy` credentials) → `dls:failed` plus a readable note, and re-adding `dls:pending` retries successfully.
