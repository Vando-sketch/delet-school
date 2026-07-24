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
