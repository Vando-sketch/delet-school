import { promises as fs } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { config } from '../config/index.js';
import type { NextcloudWriter } from '../types.js';

const logger = pino({ name: 'nextcloud-writer' });

const RESULT_SUBFOLDER = 'teams-task-agent';

type ExecFileFn = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(execFileCallback);

export interface NextcloudWriterDeps {
  /**
   * Injection point for the `occ` invocation, used by tests to stub out the
   * CLI call without depending on a real Nextcloud install. Defaults to
   * Node's promisified `child_process.execFile`.
   */
  execFile?: ExecFileFn;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences in a
 * filename. `originalFileName` ultimately originates from an external Graph
 * API response, so it must never be trusted to build a filesystem path
 * directly (e.g. `../../etc/passwd` or `foo/bar.txt`).
 */
function sanitizeBaseName(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const withoutTraversal = withoutSeparators.replace(/\.\./g, '_');
  const trimmed = withoutTraversal.trim();
  return trimmed.length > 0 ? trimmed : 'untitled';
}

/**
 * Derives the markdown result filename from the original filename by
 * stripping its extension (if any, gracefully handling filenames with none)
 * and appending `.tasks.md`.
 */
function deriveResultFileName(originalFileName: string): string {
  const safeBase = sanitizeBaseName(originalFileName);
  const ext = path.extname(safeBase);
  const stem = ext.length > 0 ? safeBase.slice(0, -ext.length) : safeBase;
  const finalStem = stem.length > 0 ? stem : 'untitled';
  return `${finalStem}.tasks.md`;
}

export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const execFile = deps.execFile ?? defaultExecFile;

  return {
    async writeResult(result, _originalFile) {
      const targetUser = config.nextcloud.targetUser();
      const targetDir = path.join(config.nextcloud.dataDir(), targetUser, 'files', RESULT_SUBFOLDER);
      const fileName = deriveResultFileName(result.originalFileName);
      const writtenPath = path.join(targetDir, fileName);

      // Defense in depth: sanitizeBaseName already strips separators/`..`
      // from fileName, so this should be structurally impossible to trip,
      // but we verify it anyway before touching the filesystem.
      const resolvedTargetDir = path.resolve(targetDir);
      const resolvedWrittenPath = path.resolve(writtenPath);
      if (
        resolvedWrittenPath !== resolvedTargetDir &&
        !resolvedWrittenPath.startsWith(resolvedTargetDir + path.sep)
      ) {
        throw new Error(`Refusing to write outside of target directory: ${writtenPath}`);
      }

      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(writtenPath, result.summaryMarkdown, 'utf8');

      // Scope the rescan to just this user's subfolder (rather than a full
      // instance-wide `files:scan`) for efficiency. `occ files:scan` accepts
      // a `--path=<user>/files/<subpath>` option (leading slash optional) to
      // limit the scan to one user's directory tree; see
      // https://docs.nextcloud.com/server/latest/admin_manual/occ_command.html#files-label
      const scanPath = `/${targetUser}/files/${RESULT_SUBFOLDER}`;
      try {
        await execFile(config.nextcloud.occBinary, ['files:scan', `--path=${scanPath}`]);
      } catch (err) {
        // The file write already succeeded, which is the important side
        // effect here — the rescan is just to make it show up immediately.
        // A failed rescan (missing occ binary, Nextcloud down, etc.) means
        // the file will instead be picked up on Nextcloud's next periodic
        // background scan, or when the user opens the containing folder.
        // We log and swallow rather than throw so callers don't treat a
        // successful write as a failure.
        logger.error({ err, scanPath }, 'occ files:scan failed after writing Nextcloud result file');
      }

      return { writtenPath };
    },
  };
}
