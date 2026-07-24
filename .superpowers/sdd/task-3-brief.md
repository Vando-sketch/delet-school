# Task 3 Brief: Bounded Parallel Vision Page Rendering Queue (`src/extract/index.ts`)

**Files to modify:**
- Modify: `src/extract/index.ts`
- Modify: `test/extract/index.test.ts`

**Interfaces:**
- Consumes: `renderPageToPng` from `src/extract/renderPage.ts`
- Produces: `extractFile(filePath, workDir, deps): Promise<ExtractionResult>` with bounded parallel vision page rendering queue

**Requirements:**
1. Implement a sliding window concurrency pool helper `mapConcurrent` in `src/extract/index.ts`:
   ```ts
   async function mapConcurrent<T, R>(
     items: T[],
     concurrency: number,
     fn: (item: T, index: number) => Promise<R>,
   ): Promise<R[]>
   ```
2. Determine concurrency dynamically:
   - Allow configuration via `process.env.MAX_CONCURRENT_PAGE_RENDERS`.
   - Default concurrency to `Math.min(4, Math.max(1, os.cpus().length))`.
3. Use `mapConcurrent` to render `visionPageNumbers` in parallel while preserving exact page order in the output `visionPages` array.
4. Add unit test in `test/extract/index.test.ts`:
   - Verify `extractFile` renders vision pages concurrently while preserving exact page array order.

**Verification:**
Run `npx vitest run test/extract/index.test.ts` to ensure all tests pass.
