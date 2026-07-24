# Task 6 Implementation Report: Recursive Subfolder Watching

**Status:** Completed  
**Branch:** `feat/ocr-quality-and-subfolder-ingest-task-6`  
**Commit:** `242ee12 feat: watch subfolders of INGEST_WATCH_DIR, not just the top level`  

## Summary of Changes

1. **Chokidar Configuration (`src/ingest/watcher.ts`)**
   - Removed `depth: 0` restriction to allow recursive watching of subfolders inside `INGEST_WATCH_DIR`.
   - Updated `ignored` filter function to split path candidates by `/` and `\` using `candidate.split(/[/\\]/)` relative to `watchDir`. This ensures dot-directories (`.processed`, `.failed`, `.staging`) are excluded at any depth.

2. **Relative Path Naming (`src/ingest/watcher.ts`)**
   - Updated `handlePlainFile` to compute `originalFileName` using `path.relative(watchDir, filePath)` instead of `path.basename(filePath)`.
   - Updated `handleZip` to prefix extracted file names with the relative directory path of the source zip archive if the zip archive was dropped in a subfolder (e.g. `Mathe/export.zip` -> `Mathe/a.txt`).

3. **Test Suite (`test/ingest-watcher.test.ts`)**
   - Added 3 new tests:
     - Plain file dropped into a subfolder receives relative path as `originalFileName`.
     - Nested `.processed` folder inside subfolder is ignored.
     - Extracted files from zip archive dropped into a subfolder inherit the subfolder prefix in `originalFileName`.

4. **Lint Config (`eslint.config.js`)**
   - Added `.agents/**` to `ignores` array to prevent eslint parsing errors on skill helper scripts.

## Verification Results

- **Unit Tests:** `vitest run test/ingest-watcher.test.ts` -> 8 passed (5 existing + 3 new).
- **Full Test Suite:** `npm test` -> 17 test files passed, 99 tests passed.
- **Typecheck:** `npm run typecheck` -> Exited 0.
- **Lint:** `npm run lint` -> Exited 0.
