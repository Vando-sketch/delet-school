import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { config } from '../config/index.js';
import { FACH_SUBPATH } from '../fach.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';
import type { NextcloudWriteContent, NextcloudWriter, ProcessedFileResult } from '../types.js';

const logger = pino({ name: 'nextcloud-writer' });

const RESULT_ROOT = 'Fächer';
const MATERIAL_SUBDIRNAME = 'Material';

export interface NextcloudWriterDeps {
  execFile?: ExecFileFn;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences. `originalFileName`
 * and `lernfeld` are not trusted to be safe for direct filesystem-path construction (e.g.
 * `../../etc/passwd` or `foo/bar.txt`).
 */
function sanitizePathSegment(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const withoutTraversal = withoutSeparators.replace(/\.\./g, '_');
  const trimmed = withoutTraversal.trim();
  return trimmed.length > 0 ? trimmed : 'untitled';
}

function deriveTargetDir(result: ProcessedFileResult): string[] {
  const fachSubpath = FACH_SUBPATH[result.fach].split('/').map(sanitizePathSegment);
  const parts = [RESULT_ROOT, ...fachSubpath];
  if (result.isMaterialblatt) {
    parts.push(MATERIAL_SUBDIRNAME);
  } else if (result.lernfeld) {
    parts.push(sanitizePathSegment(result.lernfeld));
  }
  return parts;
}

function deriveFileName(result: ProcessedFileResult, content: NextcloudWriteContent, datum: string): string {
  const safeBase = sanitizePathSegment(result.originalFileName);
  const ext = path.extname(safeBase);
  const stem = ext.length > 0 ? safeBase.slice(0, -ext.length) : safeBase;
  const finalStem = stem.length > 0 ? stem : 'untitled';

  if (content.kind === 'pdf') {
    return `${finalStem}_Loesung_${datum}.pdf`;
  }
  const materialExt = path.extname(content.sourcePath) || '.txt';
  return `${finalStem}_${datum}${materialExt}`;
}

export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const execFile = deps.execFile ?? defaultExecFile;

  return {
    async writeResult(result, content, datum) {
      const targetUser = config.nextcloud.targetUser();
      const dirParts = deriveTargetDir(result);
      const targetDir = path.join(config.nextcloud.dataDir(), targetUser, 'files', ...dirParts);
      const fileName = deriveFileName(result, content, datum);
      const writtenPath = path.join(targetDir, fileName);

      const resolvedTargetDir = path.resolve(targetDir);
      const resolvedWrittenPath = path.resolve(writtenPath);
      if (resolvedWrittenPath !== resolvedTargetDir && !resolvedWrittenPath.startsWith(resolvedTargetDir + path.sep)) {
        throw new Error(`Refusing to write outside of target directory: ${writtenPath}`);
      }

      await fs.mkdir(targetDir, { recursive: true });
      if (content.kind === 'pdf') {
        await fs.writeFile(writtenPath, content.bytes);
      } else {
        await fs.copyFile(content.sourcePath, writtenPath);
      }

      const scanPath = `/${targetUser}/files/${dirParts.join('/')}`;
      try {
        await execFile(config.nextcloud.occBinary, ['files:scan', `--path=${scanPath}`]);
      } catch (err) {
        logger.error({ err, scanPath }, 'occ files:scan failed after writing Nextcloud result file');
      }

      return { writtenPath };
    },
  };
}
