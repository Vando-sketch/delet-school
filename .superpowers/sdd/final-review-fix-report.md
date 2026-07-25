# Final-review fix: orphaned raw scan never removed from inbox after OCR archival

## Bug

In `src/worker/index.ts`, `handleJob` tracks a single `archivalPath` variable that starts as
the job's raw `filePath` and gets reassigned to `extraction.archivalPdfPath` (the OCR'd
searchable PDF, written under the per-job scratch `workDir`) whenever OCR ran. Both the
success path (`archiveFile(archivalPath, config.ingest.processedDirName)`) and the failure
path (`archiveFile(archivalPath, config.ingest.failedDirName)`) only ever move/rename
`archivalPath`.

When OCR ran, `archivalPath !== filePath`, so the original raw scan dropped at the top level
of the watch directory (e.g. `/inbox/scan.pdf`) was never renamed, moved, or deleted by any
code path — it sat there forever.

Because `src/ingest/watcher.ts`'s chokidar watcher runs with `ignoreInitial: false`, every
leftover orphaned original got re-emitted as an `add` event and re-enqueued on every
worker/ingest restart — causing the same scanned document to be re-OCR'd, re-solved (repeat
Claude spend), and re-written to Nextcloud, forever. It also meant the inbox never actually
cleared for scanned/handwritten homework, the flagship use case this branch was built for.

## Fix

Added a small helper in `src/worker/index.ts`:

```ts
async function removeOriginalIfArchivedElsewhere(filePath: string, archivalPath: string): Promise<void> {
  if (archivalPath !== filePath) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}
```

Called right after both `archiveFile(...)` calls in `handleJob`:

- Success path: after `archiveFile(archivalPath, config.ingest.processedDirName)`.
- Failure path (inside the `catch` block): after the failed-dir `archiveFile(...).catch(...)`
  chain completes, and *before* `throw err` — so a failure removing the original never
  suppresses the original error.

When OCR did not run, `archivalPath === filePath`, so the helper is a correct no-op:
`archiveFile` already renamed/moved that exact file via `fs.rename`, leaving nothing at the
original path to remove.

## Tests added (`test/worker.test.ts`)

1. Extended `'archives the OCR'd searchable PDF (not the raw scan) when extraction ran OCR'`
   with an assertion that the *original* job `filePath` (`/inbox/scan.pdf`, distinct from the
   stubbed OCR'd `archivalPdfPath` at `/inbox/.staging/job-abc123/ocr.pdf`) is removed via
   `fs.rm`:
   ```ts
   expect(rm).toHaveBeenCalledWith('/inbox/scan.pdf', { force: true });
   ```
   This hits the same mocked `rm` function (`test/worker.test.ts`'s `node:fs` mock exposes
   `mkdir`, `rename`, `rmdir`, `rm`) that the scratch-dir cleanup in the `finally` block also
   uses, distinguished by call arguments (`{ force: true }` vs.
   `{ recursive: true, force: true }` for the workDir).

2. Extended the non-OCR happy-path test
   (`'extracts, solves, renders a PDF, writes it, and archives the raw source when OCR did not
   run'`) with a negative assertion that `fs.rm` was never called with the original `filePath`
   specifically, since `archivalPath === filePath` there and the helper must be a no-op:
   ```ts
   expect(rm).not.toHaveBeenCalledWith('/inbox/arbeitsblatt1.pdf', { force: true });
   ```
   (Note `fs.rm` *is* still called once in this test, for the `workDir` scratch cleanup via
   the existing `finally` block — only the specific call with the original `filePath` and
   `{ force: true }` is asserted absent.)

## Verification

### `npm test -- test/worker.test.ts`

```
 ✓ test/worker.test.ts (5 tests) 27ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### `npm run typecheck`

```
> teams-task-agent@0.1.0 typecheck
> tsc --noEmit
```

Exit code 0, no output (clean).

### `npm run lint`

```
> teams-task-agent@0.1.0 lint
> eslint .
```

Exit code 0, no output (clean).

### `npm test` (full suite)

```
 Test Files  13 passed (13)
      Tests  56 passed (56)
   Duration  4.73s
```

All 13 test files / 56 tests pass, zero regressions.

## Files changed

- `src/worker/index.ts` — added `removeOriginalIfArchivedElsewhere` helper, called after both
  `archiveFile` call sites in `handleJob`.
- `test/worker.test.ts` — extended the OCR-path test with an assertion the original scan is
  removed; extended the non-OCR happy-path test with a negative assertion that it isn't.

## Commit

`58424b5` — `fix: remove the original source file from the inbox when the OCR'd version was archived instead`
