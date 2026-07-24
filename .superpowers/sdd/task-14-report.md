# Task 14 Report: Worker wiring

## What I implemented

Full rewrite of `src/worker/index.ts`'s `handleJob` (and matching full rewrite of `test/worker.test.ts`), replacing the old "read file -> processFile(DownloadedFile) -> writeResult(result, file)" flow with the new integrated pipeline:

1. `mkdtemp` a scratch work dir, call `extractFile(filePath, workDir)` (Task 8) to get an `ExtractionResult` (`markdown`, `visionPages`, `ranOcr`, `archivalPdfPath`).
2. Track `archivalPath`, initialized to the raw job `filePath` and reassigned to `extraction.archivalPdfPath` only after `extractFile` succeeds — so a failure inside `extractFile` itself still archives the original dropped file (there's no OCR'd version yet), while a later failure archives the OCR'd/canonical version.
3. Call `fileProcessor.processFile(originalFileName, extraction)` (Task 12) to get a `ProcessedFileResult`.
4. Branch on `result.isMaterialblatt`:
   - Materialblatt: skip `buildSolutionMarkdown`/`renderSolutionPdf` entirely, build `{ kind: 'material', sourcePath: extraction.archivalPdfPath }` directly.
   - Aufgabenblatt: `buildSolutionMarkdown(result, datum)` -> `renderSolutionPdf(markdown)` -> `{ kind: 'pdf', bytes }`.
5. `nextcloudWriter.writeResult(result, content, datum)` (Task 13), then `archiveFile(archivalPath, config.ingest.processedDirName)`.
6. On any error in the try block, `archiveFile(archivalPath, config.ingest.failedDirName)` (archival-path-aware, not the raw `filePath`) then rethrow.

`archiveFile` itself and `createFileJobWorker`/module-bootstrap are unchanged from the prior version — only `handleJob`'s body and its imports changed.

## What I tested and test results

Ran the brief's full rewritten `test/worker.test.ts` (5 cases): Aufgabenblatt happy path (extract -> solve -> markdown -> PDF -> write -> archive raw source since `ranOcr: false`), OCR'd-archive-path selection (archives `extraction.archivalPdfPath`, not the raw scan, when `ranOcr: true`), Materialblatt routing (asserts `buildSolutionMarkdown`/`renderSolutionPdf` never called, writes `{kind: 'material', sourcePath}` directly), extraction-failure archiving (rethrows, archives into `.failed`, `writeResult` never called), and zip-staging-dir cleanup (`rmdir`'d on the `archivalPdfPath`'s parent directory, `/inbox/.staging/uuid-1`).

All 5 pass. Full suite (13 files / 56 tests) passes. `npm run typecheck` and `npm run lint` are both clean.

## TDD Evidence

### RED

Command: `npm test -- test/worker.test.ts` (run against the rewritten test file, before touching `src/worker/index.ts`)

```
 ❯ test/worker.test.ts (5 tests | 5 failed) 32ms
   × worker pipeline > extracts, solves, renders a PDF, writes it, and archives the raw source when OCR did not run 29ms
     → promises.readFile is not a function
   × worker pipeline > archives the OCR'd searchable PDF (not the raw scan) when extraction ran OCR 0ms
     → promises.readFile is not a function
   × worker pipeline > skips PDF generation and writes the archival source directly for a Materialblatt 0ms
     → promises.readFile is not a function
   × worker pipeline > archives the source into the failed dir and rethrows when extraction fails 2ms
     → expected [Function] to throw error including 'ocrmypdf blew up' but got 'promises.readFi…'
   × worker pipeline > cleans up a zip-extraction staging directory after archiving the file it contained 0ms
     → promises.readFile is not a function

 Test Files  1 failed (1)
      Tests  5 failed (5)
```

The old `handleJob` (unmodified at this point) called `fs.readFile`, which the new test's `node:fs` mock doesn't provide (it only stubs `mkdtemp`/`mkdir`/`rename`/`rmdir`/`rm`), and never called the new mocked modules (`extractFile`, `buildSolutionMarkdown`, `renderSolutionPdf`) at all — confirming the tests genuinely exercise the new pipeline and fail against the old implementation.

### GREEN

Command: `npm test -- test/worker.test.ts` (after the `src/worker/index.ts` rewrite)

```
 ✓ test/worker.test.ts (5 tests) 24ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

## Files changed

- `src/worker/index.ts` — full rewrite of `handleJob` (extraction -> solve -> Materialblatt/Aufgabenblatt branch -> write -> archive), imports updated accordingly.
- `test/worker.test.ts` — full rewrite per the brief's 5 test cases.

## Verification: typecheck / lint / full test suite

`npm run typecheck`:
```
> teams-task-agent@0.1.0 typecheck
> tsc --noEmit
```
(no output — zero errors)

`npm run lint`:
```
> teams-task-agent@0.1.0 lint
> eslint .
```
(no output — zero errors/warnings)

`npm test` (full suite):
```
 Test Files  13 passed (13)
      Tests  56 passed (56)
   Start at  11:01:07
   Duration  4.75s
```

All three fully clean, zero errors anywhere. Grepped `src/` and `test/` for `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `ts-nocheck` — none found. `tsconfig.json`'s `exclude` is just `node_modules`/`dist`; `eslint.config.js`'s `ignores` is just `dist/**`, `node_modules/**`, `.claude/**` — no per-file carve-outs remain anywhere in the codebase after this task.

## `datum` format confirmation (closing out Task 13's reviewer concern)

`today()` is exactly:
```ts
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
```

`Date.prototype.toISOString()` is spec-guaranteed (ECMA-262) to always return the fixed-width extended format `YYYY-MM-DDTHH:mm:ss.sssZ` in UTC, regardless of host locale, timezone, or `Intl` configuration — this is not locale-sensitive like `toLocaleDateString()`. `.slice(0, 10)` therefore always yields exactly 10 characters: 4-digit year, `-`, 2-digit month, `-`, 2-digit day (e.g. `2026-07-23`). Verified directly:

```
$ node -e "const d = new Date().toISOString().slice(0, 10); console.log(JSON.stringify(d), /^\d{4}-\d{2}-\d{2}\$/.test(d));"
"2026-07-23" true
```

There is no code path by which `datum` could contain a path separator, quote, shell metacharacter, or any character outside `[0-9-]`. This closes out Task 13's reviewer's concern about `datum` being unsanitized before interpolation into the output filename and the `occ files:scan --path=` argument in `writeResult.ts` — the value is always a controlled, predictable `YYYY-MM-DD` string, not attacker- or LLM-influenced.

## Self-review findings

- Materialblatt branch: confirmed `buildSolutionMarkdown`/`renderSolutionPdf` are only reachable in the `else` branch of `if (result.isMaterialblatt)` — genuinely skipped, not just their output discarded. Test 3 asserts `not.toHaveBeenCalled()` on both.
- Failure-path archiving: `archivalPath` is initialized to the raw `filePath` before the `try` body runs any async work, and is only reassigned after `extractFile` resolves successfully. Test 4 (extraction throws) confirms the `.failed` archive uses the original `filePath` since `archivalPdfPath` was never reached.
- `datum` format: confirmed clean and closed out above.
- All 5 test cases pass, including the zip-staging-dir cleanup test, which now works correctly with the new `archivalPath` (defaulting to `extraction.archivalPdfPath`, which the test stubs as `/inbox/.staging/uuid-1/a.md`) — `archiveFile` computes `path.dirname(archivalPath)` = `/inbox/.staging/uuid-1` and `rmdir`s it, matching the assertion.
- `npm run typecheck`, `npm run lint`, and full `npm test` (13 files / 56 tests) are all clean with zero errors — no remaining carve-outs anywhere in the codebase.

No other issues or concerns.

---

# Fix Report: Findings 1 & 2 (cross-device rename + scratch dir leak)

## What changed

`src/worker/index.ts`:

- **Finding 1 (EXDEV on archive rename):** Replaced `await fs.mkdtemp(path.join(os.tmpdir(), 'extract-'))` with a deterministic path inside the watched folder's existing staging convention:
  ```ts
  const workDir = path.join(path.resolve(config.ingest.watchDir), config.ingest.stagingDirName, randomUUID());
  await fs.mkdir(workDir, { recursive: true });
  ```
  This mirrors `handleZip`'s `stagingDir` pattern in `src/ingest/watcher.ts` exactly (`watchDir/.staging/<uuid>`), which the watcher already excludes from re-ingestion via its top-level dot-directory `ignored` filter. Since `workDir` now lives on the same bind-mounted volume as `processedDirName`/`failedDirName`, `fs.rename` in `archiveFile` never crosses a device boundary. Dropped the now-unused `node:os` import and added `randomUUID` from `node:crypto` (same import `src/ingest/watcher.ts` already uses).

- **Finding 2 (scratch dir leak):** Wrapped the existing try/catch body in a `finally` block:
  ```ts
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  ```
  This runs after both the success-path `archiveFile(archivalPath, processedDirName)` and the failure-path `archiveFile(archivalPath, failedDirName)` have already had a chance to move the file out of `workDir` (for the OCR case, `extraction.archivalPdfPath` lives inside `workDir` as `workDir/ocr.pdf`). `force: true` makes it a no-op if `workDir` was never created (e.g. `fs.mkdir` itself threw) or was already removed; `recursive: true` fully removes `workDir` even when `vision-pages/` has files in it, which is exactly the case where `archiveFile`'s existing best-effort non-recursive `rmdir` on the OCR scratch dir silently fails.

`fs.mkdir(workDir, ...)` was moved inside the `try` block (workDir path computation itself stays outside, since it's synchronous and cannot fail) so that if directory creation itself fails, the failure path still archives the original `filePath` to `.failed` and the `finally` cleanup still runs safely (no-op via `force: true`).

## Test changes (`test/worker.test.ts`)

- Removed the `mkdtemp` mock entirely (no longer called anywhere in `src/worker/index.ts` — confirmed via `grep -rn "mkdtemp|os.tmpdir|node:os" src/ test/`; the only other `os.tmpdir()` user in the codebase is the unrelated `src/pdf/renderPdf.ts`, untouched by this fix).
- **Mocking approach for `randomUUID`:** added `const randomUUID = vi.fn();` plus `vi.mock('node:crypto', () => ({ randomUUID }));`, set to `randomUUID.mockReturnValue('job-abc123')` in `beforeEach`. I chose this over relaxing the assertions to `expect.stringMatching(...)` because it keeps the test file's existing style (every collaborator module — `extractFile`, `writeResult`, `fs.promises`, etc. — is mocked with `vi.fn()` at the top and wired via `vi.mock`, with exact-value assertions throughout) and lets every assertion stay a precise `toBe`/`toHaveBeenCalledWith` on the exact resulting path (`/inbox/.staging/job-abc123`) rather than a looser pattern match, which is strictly more informative when a test fails.
- Updated `extractFile`/`rename` assertions in the two success-path tests to the new deterministic path (`/inbox/.staging/job-abc123` instead of the old mocked `mkdtemp` return value `/tmp/job-abc123`).
- Added new regression coverage for Finding 2: in the happy-path test, the OCR test, and the extraction-failure test, added `expect(rm).toHaveBeenCalledWith('/inbox/.staging/job-abc123', { recursive: true, force: true })` — covering both the success path and the failure (rejected `extractFile`) path. Also added `expect(mkdir).toHaveBeenCalledWith('/inbox/.staging/job-abc123', { recursive: true })` to the happy-path test to cover Finding 1's `workDir` creation.
- Left the existing zip-staging-dir cleanup test (`rmdir` on `/inbox/.staging/uuid-1`) untouched — that covers a separate, pre-existing mechanism (the ingest watcher's own zip-extraction staging dir, cleaned up via `archiveFile`'s `sourceDir` `rmdir`), unaffected by this fix since it uses a different directory than the worker's own per-job `workDir`.

## Verification

`npm test -- test/worker.test.ts`:
```
 ✓ test/worker.test.ts (5 tests) 26-41ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

`npm run typecheck`:
```
> tsc --noEmit
```
(no output — zero errors)

`npm run lint`:
```
> eslint .
```
(no output — zero errors/warnings)

`npm test` (full suite):
```
 Test Files  13 passed (13)
      Tests  56 passed (56)
   Duration  4.74s
```

All clean, zero regressions.

## Commit

`fix: keep extraction scratch dir on the same filesystem as the watch dir, clean it up unconditionally` (83311e0), on branch `feat/pdf-solve-pipeline`.
