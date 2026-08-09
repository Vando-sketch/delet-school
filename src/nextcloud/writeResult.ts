import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createClient, type WebDAVClient } from 'webdav';
import { config } from '../config/index.js';
import { SUBJECT_SUBPATH } from '../subjects.js';
import type { NextcloudWriteContent, NextcloudWriter, ProcessedFileResult } from '../types.js';

const RESULT_ROOT = 'Subjects';
const REFERENCE_SUBDIRNAME = 'Reference';

type NextcloudWebDAVClient = Pick<WebDAVClient, 'createDirectory' | 'putFileContents'>;

export interface NextcloudWriterDeps {
  webdavClient?: NextcloudWebDAVClient;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences. `originalFileName`
 * and `module` are not trusted to be safe for direct path construction (e.g.
 * `../../etc/passwd` or `foo/bar.txt`).
 */
function sanitizePathSegment(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const withoutTraversal = withoutSeparators.replace(/\.\./g, '_');
  const trimmed = withoutTraversal.trim();
  return trimmed.length > 0 ? trimmed : 'untitled';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveTargetDir(result: ProcessedFileResult): string[] {
  const subjectFolder = SUBJECT_SUBPATH[result.subject];
  if (subjectFolder === undefined) {
    throw new Error(`nextcloud/writeResult: no folder mapping configured for subject "${result.subject}".`);
  }
  const subjectSubpath = subjectFolder.split('/').map(sanitizePathSegment);
  const parts = [RESULT_ROOT, ...subjectSubpath];
  if (result.isReferenceSheet) {
    parts.push(REFERENCE_SUBDIRNAME);
  } else if (result.module) {
    parts.push(sanitizePathSegment(result.module));
  }
  return parts;
}

function deriveFileName(result: ProcessedFileResult, content: NextcloudWriteContent, date: string): string {
  const base = path.basename(result.originalFileName);
  const ext = path.extname(base);
  let stem = ext.length > 0 ? base.slice(0, -ext.length) : base;

  // Strip a redundant leading subject-key prefix (e.g. "Math_01_..." under Subjects/Math/...)
  // since output files are already stored under the subject folder structure.
  const subjectKeys = Object.keys(SUBJECT_SUBPATH);
  if (subjectKeys.length > 0) {
    const prefixPattern = new RegExp(`^(?:${subjectKeys.map(escapeRegExp).join('|')})_`, 'i');
    stem = stem.replace(prefixPattern, '');
  }

  const safeStem = sanitizePathSegment(stem);
  const finalStem = safeStem.length > 0 ? safeStem : 'untitled';

  if (content.kind === 'pdf') {
    return `${finalStem}_Solution_${date}.pdf`;
  }
  const materialExt = path.extname(content.sourcePath) || '.txt';
  return `${finalStem}_${date}${materialExt}`;
}

/**
 * `createDirectory(path, { recursive: true })` from the `webdav` package already stats each
 * path segment before creating it, so it's idempotent against an already-existing folder on
 * its own. This cache only avoids repeating that network round trip for every file written
 * into a subject folder that's already been confirmed to exist earlier in the same process.
 */
export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const baseUrl = config.nextcloud.baseUrl();
  const client: NextcloudWebDAVClient | null =
    deps.webdavClient ??
    (baseUrl
      ? createClient(`${baseUrl}/remote.php/dav/files/${config.nextcloud.username()}`, {
          username: config.nextcloud.username(),
          password: config.nextcloud.appPassword(),
        })
      : null);
  const knownDirs = new Set<string>();

  return {
    async writeResult(result, content, date) {
      const dirParts = deriveTargetDir(result);
      const targetDir = `/${dirParts.join('/')}`;
      const fileName = deriveFileName(result, content, date);
      const writtenPath = `${targetDir}/${fileName}`;

      if (client) {
        if (!knownDirs.has(targetDir)) {
          await client.createDirectory(targetDir, { recursive: true });
          knownDirs.add(targetDir);
        }

        const bytes = content.kind === 'pdf' ? content.bytes : await fs.readFile(content.sourcePath);
        const ok = await client.putFileContents(writtenPath, bytes);
        if (ok === false) {
          throw new Error(`nextcloud/writeResult: failed to upload "${writtenPath}" via WebDAV`);
        }
      } else {
        const localDir = path.resolve(config.nextcloud.outboxDir, ...dirParts);
        await fs.mkdir(localDir, { recursive: true });
        const localFilePath = path.join(localDir, fileName);
        const bytes = content.kind === 'pdf' ? content.bytes : await fs.readFile(content.sourcePath);
        await fs.writeFile(localFilePath, bytes);
      }

      return { writtenPath };
    },
  };
}
