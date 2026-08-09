# Task 11 Report: PDF Renderer (pandoc + weasyprint)

## Summary

Successfully implemented `renderSolutionPdf()` function in `src/pdf/renderPdf.ts` following strict TDD workflow. The function takes markdown as input, shells out to pandoc with weasyprint as PDF engine, and returns PDF bytes.

## What Was Implemented

### Files Created
1. **`src/pdf/renderPdf.ts`** (45 lines)
   - Exports `renderSolutionPdf(markdown: string, deps?: RenderPdfDeps): Promise<Buffer>`
   - Accepts injectable dependencies: `execFile`, `writeFile`, `readFile`, `rm`
   - Generates unique temp file paths using `randomUUID()`
   - Writes markdown to temp `.md` file
   - Invokes pandoc with configured template, CSS, and weasyprint PDF engine
   - Reads PDF bytes from temp output file
   - Cleans up both temp markdown and PDF files in finally block

2. **`test/pdf/renderPdf.test.ts`** (47 lines)
   - Single comprehensive test covering the full workflow
   - Mocks all dependencies to track calls
   - Verifies markdown write, pandoc invocation, PDF read, and cleanup

### Implementation Details

The function follows this flow:
```
1. Generate unique temp file names using randomUUID
2. Write markdown input to temp .md file
3. Shell out to pandoc with:
   - Input: temp markdown file path
   - --template: config.pandoc.templatePath
   - --css: config.pandoc.cssPath
   - --pdf-engine: config.pandoc.weasyprintBinary
   - -o: temp PDF output file path
4. Read back PDF bytes from temp output file
5. Clean up both temp files in finally block (guaranteed even on error)
```

All dependencies have sensible defaults pointing to real `node:fs` implementations and `defaultExecFile`.

## TDD Evidence

### RED (Test Failure)
```
Command: npm test -- test/pdf/renderPdf.test.ts

Result: FAIL
Error: Failed to load url ../../src/pdf/renderPdf.js (resolved id: ../../src/pdf/renderPdf.js) in test/pdf/renderPdf.test.ts. Does the file exist?

Test Files: 1 failed
Tests: no tests
```

### GREEN (Test Success)
```
Command: npm test -- test/pdf/renderPdf.test.ts

Result: PASS
✓ test/pdf/renderPdf.test.ts (1 test) 2ms
Test Files: 1 passed (1)
Tests: 1 passed (1)
```

### Full Test Suite
All 52 tests pass (13 test files), including the new renderPdf test.

## Self-Review Findings

✓ **Dependencies**: All four injectable deps present with correct defaults
  - `execFile`: defaults to `defaultExecFile` from `src/lib/execFile.js`
  - `writeFile`: defaults to `fs.writeFile` with UTF-8 encoding
  - `readFile`: defaults to `fs.readFile`
  - `rm`: defaults to `fs.rm` with `{ force: true }`

✓ **Cleanup**: Both temp files cleaned up via finally block
  - Markdown file (`mdPath`) removed
  - PDF file (`pdfPath`) removed
  - Finally block ensures cleanup even if pandoc execution throws

✓ **Pandoc Args Order**: Exact order verified by test
  - [0] Input markdown file path
  - [1] `--template`
  - [2] Config template path (`/app/vorlage/template.html`)
  - [3] `--css`
  - [4] Config CSS path (`/app/vorlage/style.css`)
  - [5] `--pdf-engine`
  - [6] Config weasyprint binary (`/app/.venv/bin/weasyprint`)
  - [7] `-o`
  - [8] Output PDF file path (verified to end with `.pdf`)

✓ **Error Handling**: Finally block guarantees cleanup even on pandoc failure

## Files Changed

- Created: `src/pdf/renderPdf.ts` (45 lines)
- Created: `test/pdf/renderPdf.test.ts` (47 lines)

## Commits

- **34fd09b** "feat: render solution markdown to PDF bytes via pandoc+weasyprint"

## Test Results

- **Task 11 test**: 1 passed
- **Full suite**: 52 passed across 13 files
- **No regressions**: All existing tests still pass

## Issues or Concerns

None. Implementation is complete, tested, and ready for use by Task 14 (worker integration).

---

## Fix: Coverage for Cleanup-on-Failure Path

**Issue**: The `renderSolutionPdf` function has a finally block that cleans up temp files even on error, but this critical safety path was untested. Risk: if the default `rm` implementation ever changed or was injected without `{ force: true }`, cleanup would throw on pandoc failures with no test catching it.

**Solution**: Added a second test case to cover the failure path.

### Test Added

```typescript
it('cleans up temp files even when pandoc fails', async () => {
  const writeCalls: Array<{ path: string; data: string }> = [];
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const rmCalls: string[] = [];

  const deps = {
    writeFile: async (path: string, data: string) => {
      writeCalls.push({ path, data });
    },
    execFile: async (file: string, args: readonly string[]) => {
      execCalls.push({ file, args });
      throw new Error('pandoc failed');
    },
    readFile: async () => Buffer.from(''),
    rm: async (path: string) => {
      rmCalls.push(path);
    },
  };

  await expect(renderSolutionPdf('# markdown', deps)).rejects.toThrow('pandoc failed');

  // Verify execFile was called once (before failing)
  expect(execCalls).toHaveLength(1);

  // Verify cleanup still happened twice despite the pandoc failure
  expect(rmCalls).toHaveLength(2);
});
```

### Test Results
```
✓ test/pdf/renderPdf.test.ts (2 tests) 2ms
Test Files: 1 passed (1)
Tests: 2 passed (2)
```

### Lint Results
No issues found.

### Commit
- **b84e370** "test: cover cleanup-on-failure path in renderSolutionPdf"

### Coverage Verified
- Original happy-path test: ✓ Still passing
- New failure-path test: ✓ Passing, confirms rm called twice even when pandoc throws
- Lint: ✓ No issues
