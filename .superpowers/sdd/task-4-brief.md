### Task 4: Shared `renameOrCopy` helper

**Files:**
- Create: `src/lib/renameOrCopy.ts`
- Test: `test/lib/renameOrCopy.test.ts`

**Interfaces:**
- Produces: `renameOrCopy(src: string, dest: string, deps?: { rename?: (src: string, dest: string) => Promise<void>; copyFile?: (src: string, dest: string) => Promise<void>; unlink?: (path: string) => Promise<void> }): Promise<void>` — consumed by Task 5 (`src/ingest/watcher.ts`, `src/worker/index.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/renameOrCopy.test.ts
import { describe, expect, it, vi } from 'vitest';
import { renameOrCopy } from '../../src/lib/renameOrCopy.js';

function exdevError(): NodeJS.ErrnoException {
  const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
  err.code = 'EXDEV';
  return err;
}

describe('renameOrCopy', () => {
  it('delegates to rename when the destination is on the same filesystem', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const copyFile = vi.fn();
    const unlink = vi.fn();

    await renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile, unlink });

    expect(rename).toHaveBeenCalledWith('/src/a.pdf', '/dest/a.pdf');
    expect(copyFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('falls back to copy+unlink when rename fails with EXDEV', async () => {
    const rename = vi.fn().mockRejectedValue(exdevError());
    const copyFile = vi.fn().mockResolvedValue(undefined);
    const unlink = vi.fn().mockResolvedValue(undefined);

    await renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile, unlink });

    expect(copyFile).toHaveBeenCalledWith('/src/a.pdf', '/dest/a.pdf');
    expect(unlink).toHaveBeenCalledWith('/src/a.pdf');
  });

  it('propagates a non-EXDEV rename failure instead of falling back', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('permission denied'));
    const copyFile = vi.fn();

    await expect(renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile })).rejects.toThrow(
      'permission denied',
    );
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('actually moves a file across real directories on the local filesystem (no injected deps)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-or-copy-test-'));
    const src = path.join(tmpDir, 'a.txt');
    const dest = path.join(tmpDir, 'b.txt');
    await fs.writeFile(src, 'hello');

    await renameOrCopy(src, dest);

    expect(await fs.readFile(dest, 'utf-8')).toBe('hello');
    await expect(fs.stat(src)).rejects.toThrow();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/lib/renameOrCopy.test.ts`
Expected: FAIL with "Cannot find module '../../src/lib/renameOrCopy.js'".

- [ ] **Step 3: Implement**

```ts
// src/lib/renameOrCopy.ts
import { promises as fs } from 'node:fs';

export interface RenameOrCopyDeps {
  rename?: (src: string, dest: string) => Promise<void>;
  copyFile?: (src: string, dest: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
}

/**
 * fs.rename() requires source and destination to be on the same filesystem/mount and throws
 * EXDEV otherwise (POSIX rename(2) semantics) - harmless while every archive destination lives
 * under one bind mount, but not once files can be dropped into arbitrary subfolders that might
 * span mounts. Falls back to copy+unlink only for that specific error; any other rename
 * failure still surfaces as-is.
 */
export async function renameOrCopy(src: string, dest: string, deps: RenameOrCopyDeps = {}): Promise<void> {
  const rename = deps.rename ?? fs.rename;
  const copyFile = deps.copyFile ?? fs.copyFile;
  const unlink = deps.unlink ?? fs.unlink;

  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(src, dest);
    await unlink(src);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/lib/renameOrCopy.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/renameOrCopy.ts test/lib/renameOrCopy.test.ts
git commit -m "feat: add EXDEV-safe rename-or-copy helper for cross-filesystem archiving"
```

---

