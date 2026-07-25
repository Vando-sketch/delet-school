### Task 6: Recursive subfolder watching, segment-based ignore matching, relative-path naming

**Files:**
- Modify: `src/ingest/watcher.ts` (the `chokidarWatch` options, `handlePlainFile`, `handleZip`, the `add` listener)
- Modify: `test/ingest-watcher.test.ts` (3 new cases)

**Interfaces:**
- Consumes: nothing new (uses existing `path`, `config.ingest.*` already imported in `watcher.ts`).
- Produces: no exported-signature change — `createIngestWatcher()`'s public shape is untouched. Internally, `handlePlainFile` gains a `watchDir` parameter and both it and `handleZip` now produce `originalFileName` values that are paths relative to `watchDir` instead of bare basenames.

- [ ] **Step 1: Write the new failing tests**

Add to `test/ingest-watcher.test.ts`, after the existing `'does not re-enqueue files already sitting in .processed/.failed/.staging'` test (still inside the outer `describe('createIngestWatcher', ...)` block, before its closing `});`):

```ts
  it('enqueues a job for a file dropped into a subfolder, using its relative path as originalFileName', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.mkdir(path.join(tmpDir, 'Mathe'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'Mathe', 'AB1.pdf'), 'content');

    await waitFor(() => add.mock.calls.length >= 1);

    expect(add).toHaveBeenCalledWith(
      'process-file',
      expect.objectContaining({
        filePath: path.join(tmpDir, 'Mathe', 'AB1.pdf'),
        originalFileName: path.join('Mathe', 'AB1.pdf'),
      }),
    );
  });

  it('ignores a .processed directory nested under a subfolder, not just at the top level', async () => {
    await fs.mkdir(path.join(tmpDir, 'Mathe', '.processed'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'Mathe', '.processed', 'old-result.pdf'), 'already handled');

    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(add).not.toHaveBeenCalled();
  });

  it('prefixes extracted zip-content originalFileName with the subfolder the zip itself was dropped into', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.mkdir(path.join(tmpDir, 'Mathe'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from('file a'));
    zip.addFile('b.txt', Buffer.from('file b'));
    zip.writeZip(path.join(tmpDir, 'Mathe', 'export.zip'));

    await waitFor(() => add.mock.calls.length >= 2);

    const enqueuedNames = (add.mock.calls as [string, { originalFileName: string }][])
      .map(([, data]) => data.originalFileName)
      .sort();
    expect(enqueuedNames).toEqual([path.join('Mathe', 'a.txt'), path.join('Mathe', 'b.txt')]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/ingest-watcher.test.ts`
Expected: FAIL — the subfolder file is never picked up (`depth: 0` still in place) and, once it is, `originalFileName` is still a bare basename, not a relative path.

- [ ] **Step 3: Update the `chokidarWatch` options in `src/ingest/watcher.ts`**

Replace:

```ts
  const ignoredDirs = [config.ingest.processedDirName, config.ingest.failedDirName, config.ingest.stagingDirName].map(
    (name) => path.join(watchDir, name),
  );

  const watcher = chokidarWatch(watchDir, {
    ignoreInitial: false,
    // Top-level dot-directories (.processed/.failed/.staging) hold this watcher's own
    // output and must never be re-ingested.
    ignored: (candidate) => ignoredDirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep)),
    // Files land here via copy/upload/sync, which can take a moment; wait for the file
    // size to stop changing before treating it as "added" so partial files aren't ingested.
    awaitWriteFinish: {
      stabilityThreshold: config.ingest.stabilityThresholdMs,
      pollInterval: 100,
    },
    depth: 0,
  });
```

with:

```ts
  const ignoredNames = new Set([
    config.ingest.processedDirName,
    config.ingest.failedDirName,
    config.ingest.stagingDirName,
  ]);

  const watcher = chokidarWatch(watchDir, {
    ignoreInitial: false,
    // .processed/.failed/.staging hold this watcher's own output and must never be
    // re-ingested, wherever they occur - not just at the top level, now that subfolders are
    // watched too. Split on /[/\\]/ rather than the OS-native path.sep alone - chokidar
    // normalizes candidate paths to forward slashes internally regardless of host OS.
    ignored: (candidate) => {
      const rel = path.relative(watchDir, candidate);
      return rel.split(/[/\\]/).some((segment) => ignoredNames.has(segment));
    },
    // Files land here via copy/upload/sync, which can take a moment; wait for the file
    // size to stop changing before treating it as "added" so partial files aren't ingested.
    awaitWriteFinish: {
      stabilityThreshold: config.ingest.stabilityThresholdMs,
      pollInterval: 100,
    },
  });
```

- [ ] **Step 4: Update `handlePlainFile` and its call site**

Replace:

```ts
async function handlePlainFile(queue: FileJobQueueLike, filePath: string): Promise<void> {
  await enqueueFile(queue, filePath, path.basename(filePath));
}
```

with:

```ts
async function handlePlainFile(queue: FileJobQueueLike, watchDir: string, filePath: string): Promise<void> {
  await enqueueFile(queue, filePath, path.relative(watchDir, filePath));
}
```

Replace the `add` listener:

```ts
  watcher.on('add', (filePath) => {
    void (isZipFile(filePath) ? handleZip(queue, watchDir, filePath) : handlePlainFile(queue, filePath)).catch(
      (err: unknown) => {
        logger.error({ err, filePath }, 'Failed to ingest file');
      },
    );
  });
```

with:

```ts
  watcher.on('add', (filePath) => {
    void (isZipFile(filePath) ? handleZip(queue, watchDir, filePath) : handlePlainFile(queue, watchDir, filePath)).catch(
      (err: unknown) => {
        logger.error({ err, filePath }, 'Failed to ingest file');
      },
    );
  });
```

- [ ] **Step 5: Update `handleZip` to prefix extracted-file names with the zip's own subfolder**

Replace:

```ts
async function handleZip(queue: FileJobQueueLike, watchDir: string, zipPath: string): Promise<void> {
  const stagingDir = path.join(watchDir, config.ingest.stagingDirName, randomUUID());
  await fs.mkdir(stagingDir, { recursive: true });

  new AdmZip(zipPath).extractAllTo(stagingDir, true);

  const extractedFiles = await listFilesRecursive(stagingDir);
  if (extractedFiles.length === 0) {
    logger.warn({ zipPath }, 'Zip archive contained no files; nothing to enqueue');
  }

  // Captured once upfront, before any file in the batch can be archived away by the worker -
  // every job embeds its siblings' excerpts directly rather than reading them live off disk later.
  const batchId = randomUUID();
  const manifestByPath = await buildSiblingManifest(
    extractedFiles.map((filePath) => ({ filePath, relativeName: path.relative(stagingDir, filePath) })),
  );

  for (const filePath of extractedFiles) {
    const siblingManifest = boundSiblingManifest(
      extractedFiles
        .filter((other) => other !== filePath)
        .map((other) => manifestByPath.get(other))
        .filter((entry): entry is SiblingManifestEntry => entry !== undefined),
    );
    await enqueueFile(queue, filePath, path.relative(stagingDir, filePath), { batchId, siblingManifest });
  }

  await archiveFile(watchDir, zipPath, config.ingest.processedDirName);
}
```

with:

```ts
async function handleZip(queue: FileJobQueueLike, watchDir: string, zipPath: string): Promise<void> {
  const stagingDir = path.join(watchDir, config.ingest.stagingDirName, randomUUID());
  await fs.mkdir(stagingDir, { recursive: true });

  new AdmZip(zipPath).extractAllTo(stagingDir, true);

  const extractedFiles = await listFilesRecursive(stagingDir);
  if (extractedFiles.length === 0) {
    logger.warn({ zipPath }, 'Zip archive contained no files; nothing to enqueue');
  }

  // A zip dropped into a subfolder (e.g. watchDir/Mathe/export.zip) prefixes its own subfolder
  // path onto every extracted file's originalFileName, same rule as a plain file dropped there
  // directly - "." (zip was at the top level) contributes no prefix.
  const zipRelativeDir = path.dirname(path.relative(watchDir, zipPath));
  const namePrefix = zipRelativeDir === '.' ? '' : `${zipRelativeDir}${path.sep}`;

  // Captured once upfront, before any file in the batch can be archived away by the worker -
  // every job embeds its siblings' excerpts directly rather than reading them live off disk later.
  const batchId = randomUUID();
  const manifestByPath = await buildSiblingManifest(
    extractedFiles.map((filePath) => ({ filePath, relativeName: path.relative(stagingDir, filePath) })),
  );

  for (const filePath of extractedFiles) {
    const siblingManifest = boundSiblingManifest(
      extractedFiles
        .filter((other) => other !== filePath)
        .map((other) => manifestByPath.get(other))
        .filter((entry): entry is SiblingManifestEntry => entry !== undefined),
    );
    const originalFileName = `${namePrefix}${path.relative(stagingDir, filePath)}`;
    await enqueueFile(queue, filePath, originalFileName, { batchId, siblingManifest });
  }

  await archiveFile(watchDir, zipPath, config.ingest.processedDirName);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- test/ingest-watcher.test.ts`
Expected: PASS, all 8 tests green (5 existing + 3 new).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass, including `test/worker.test.ts` (unaffected — it only exercises `handleJob`, not the watcher).

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/ingest/watcher.ts test/ingest-watcher.test.ts
git commit -m "feat: watch subfolders of INGEST_WATCH_DIR, not just the top level"
```

---

