# Task 5 Completion Report: Use `renameOrCopy` in both archive functions

## Summary
Task 5 replaces direct `fs.rename` calls in `src/ingest/watcher.ts` and `src/worker/index.ts` with `renameOrCopy` (from `src/lib/renameOrCopy.ts`, implemented in Task 4). In addition, it fixes a pruning scope issue in `src/worker/index.ts`: previously, `archiveFile` pruned any source directory where `sourceDir !== watchDir`. This was safe prior to watched subfolders, but would delete user-created subfolders (e.g. `/inbox/Mathe`) when files in subfolders were processed. The pruning condition has now been narrowed specifically to paths under `config.ingest.stagingDirName` (`.staging/`).

## Changes Made
1. **`src/ingest/watcher.ts`**:
   - Imported `renameOrCopy` from `../lib/renameOrCopy.js`.
   - Replaced `await fs.rename(filePath, dest)` with `await renameOrCopy(filePath, dest)` inside `archiveFile`.

2. **`src/worker/index.ts`**:
   - Imported `renameOrCopy` from `../lib/renameOrCopy.js`.
   - Replaced `await fs.rename(filePath, dest)` with `await renameOrCopy(filePath, dest)` inside `archiveFile`.
   - Updated `archiveFile` pruning check from `sourceDir !== watchDir` to check whether `sourceDir` is equal to or under `stagingRoot` (`watchDir/.staging`).

3. **`test/worker.test.ts`**:
   - Added regression test `does not prune a subfolder a file was dropped into directly - only .staging dirs get pruned` verifying that when `archivalPdfPath` is `/inbox/Mathe/AB1.pdf`, `rmdir` is not called and `rename` is called once.

## Verification
- Ran full test suite via `npx vitest run`:
  - 17 test files passed (96 tests total, including the new regression test).
- Ran `npm run typecheck`:
  - Passed cleanly with 0 errors.
- Ran `npx eslint src test`:
  - Passed cleanly with 0 errors.
- Checked git diff and commit hash:
  - Commit `6bd89b9`: `fix: archive via renameOrCopy, and only prune staging dirs (not subfolders)`.
