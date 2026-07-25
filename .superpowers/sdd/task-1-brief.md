# Task 1 Brief: Single-Pass Poppler Extraction & Fallback (`src/extract/pdfText.ts`)

**Files to modify:**
- Modify: `src/extract/pdfText.ts`
- Modify: `src/extract/index.ts`
- Modify: `test/extract/pdfText.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` from `src/lib/execFile.ts`
- Produces: `getAllPagesText(pdfPath: string, pageCount: number, execFile?: ExecFileFn): Promise<string[]>`

**Requirements:**
1. Export `getAllPagesText` in `src/extract/pdfText.ts`:
   - Executes `pdftotext <pdfPath> -` **once** for the entire PDF document.
   - Flag parity with `getPageText`: pass `[pdfPath, '-']` to `config.poppler.pdftotextBin`.
   - Splitting: Split stdout by `\f`.
   - Trailing `\f` handling: Poppler appends `\f` after every page, including the last page. `stdout.split('\f')` on $N$ pages produces $N+1$ items where item $N+1$ is empty/whitespace. Before length validation, if `rawPages.length === pageCount + 1` and `(rawPages[pageCount] ?? '').trim() === ''`, pop the trailing empty string.
   - If `pages.length === pageCount`, return `pages`.
   - Fallback: If `pages.length !== pageCount` or `pdftotext` single-pass fails, fall back to `Promise.all(pageNumbers.map(p => getPageText(pdfPath, p, execFile)))`.
2. Update `src/extract/index.ts`:
   - Add `getAllPagesText?: typeof getAllPagesText` to `ExtractDeps` interface.
   - Use `deps.getAllPagesText ?? getAllPagesText` in `extractFile`.
3. Add Vitest unit tests in `test/extract/pdfText.test.ts`:
   - Test `getAllPagesText` splitting stdout by form feed `\f` and stripping trailing `\f`.
   - Test fallback to `getPageText` when page count mismatches.
   - Test character-for-character flag parity with `getPageText`.

**Verification:**
Run `npx vitest run test/extract/pdfText.test.ts` to ensure all tests pass.
