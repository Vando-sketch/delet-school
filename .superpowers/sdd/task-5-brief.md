### Task 5: Use `renameOrCopy` in both archive functions

**Files:**
- Modify: `src/ingest/watcher.ts:78-84` (`archiveFile`)
- Modify: `src/worker/index.ts:24-35` (`archiveFile`)
- Modify: `test/worker.test.ts` (1 new case)

**Interfaces:**
- Consumes: `renameOrCopy` from Task 4 (`src/lib/renameOrCopy.ts`).
- Produces: `watcher.ts`'s `archiveFile` keeps its existing signature and behavior unchanged
  (pure refactor). `worker/index.ts`'s `archiveFile` keeps its signature but its
  source-directory-cleanup condition is corrected, not just refactored — see Step 2's note.

- [ ] **Step 1: Update `src/ingest/watcher.ts`**

Add the import near the top, with the other relative imports:

```ts
import { renameOrCopy } from '../lib/renameOrCopy.js';
```

Replace the `archiveFile` function:

```ts
/** Moves a fully-handled file into `watchDir/dirName`, timestamp-prefixed to avoid collisions. */
async function archiveFile(watchDir: string, filePath: string, dirName: string): Promise<void> {
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await renameOrCopy(filePath, dest);
}
```

- [ ] **Step 2: Update `src/worker/index.ts`**

Add the import near the top, with the other relative imports:

```ts
import { renameOrCopy } from '../lib/renameOrCopy.js';
```

Replace the `archiveFile` function:

```ts
async function archiveFile(filePath: string, dirName: string): Promise<void> {
  const watchDir = path.resolve(config.ingest.watchDir);
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await renameOrCopy(filePath, dest);

  // Only prune the source directory when it's a job-scratch or zip-extraction staging
  // directory under .staging/ - never a real subfolder of watchDir a file was dropped into
  // directly. Before subfolder support, `sourceDir !== watchDir` was an adequate proxy for
  // "this is a staging dir" (the only non-watchDir source a file could ever have). That stops
  // being true once subfolders are watched: a plain file at watchDir/Mathe/AB1.pdf has
  // sourceDir = watchDir/Mathe, which is not a staging dir and must be left in place even once
  // empty (see docs/superpowers/specs/2026-07-24-ocr-quality-and-subfolder-ingest-design.md,
  // "Explicitly out of scope: empty subfolder cleanup").
  const stagingRoot = path.join(watchDir, config.ingest.stagingDirName);
  const sourceDir = path.dirname(filePath);
  if (sourceDir === stagingRoot || sourceDir.startsWith(stagingRoot + path.sep)) {
    await fs.rmdir(sourceDir).catch(() => undefined);
  }
}
```

- [ ] **Step 3: Add a regression test for the corrected pruning condition**

Add to `test/worker.test.ts`, inside the `describe('worker pipeline', ...)` block, after the `'cleans up a zip-extraction staging directory after archiving the file it contained'` test:

```ts
  it('does not prune a subfolder a file was dropped into directly - only .staging dirs get pruned', async () => {
    extractFile.mockResolvedValue({
      markdown: '# text',
      visionPages: [],
      ranOcr: false,
      archivalPdfPath: '/inbox/Mathe/AB1.pdf',
    });
    processFile.mockResolvedValue({ ...AUFGABENBLATT_RESULT, originalFileName: 'Mathe/AB1.pdf' });
    buildSolutionMarkdown.mockReturnValue('# solution markdown');
    renderSolutionPdf.mockResolvedValue(Buffer.from('%PDF fake'));
    writeResult.mockResolvedValue({ writtenPath: '/data/x.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/Mathe/AB1.pdf', originalFileName: 'Mathe/AB1.pdf', receivedAt: 'now' } };
    await handler(job);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rmdir).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new case and every pre-existing `test/worker.test.ts` case
unchanged (`rmdir` is still called with the same staging-dir paths as before for the OCR'd-PDF
and zip-extraction cases — both `/inbox/.staging/job-abc123` and `/inbox/.staging/uuid-1` match
the new `stagingRoot`-prefix condition exactly as they matched the old `sourceDir !== watchDir`
condition) and `test/ingest-watcher.test.ts` (uses real files, unaffected by the internal
`renameOrCopy` refactor — `vi.mock('node:fs', ...)` in `test/worker.test.ts` intercepts
`renameOrCopy`'s internal default `fs.rename` too, since both modules resolve the same mocked
`node:fs`, so the existing `expect(rename).toHaveBeenCalledWith(...)` assertions keep working
unchanged).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/watcher.ts src/worker/index.ts test/worker.test.ts
git commit -m "fix: archive via renameOrCopy, and only prune staging dirs (not subfolders)"
```

---

