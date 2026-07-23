import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createClient, type WebDAVClient } from 'webdav';
import { config } from '../config/index.js';
import { FACH_SUBPATH } from '../fach.js';
import type { NextcloudWriteContent, NextcloudWriter, ProcessedFileResult } from '../types.js';

const RESULT_ROOT = 'Fächer';
const MATERIAL_SUBDIRNAME = 'Material';

type NextcloudWebDAVClient = Pick<WebDAVClient, 'createDirectory' | 'putFileContents'>;

export interface NextcloudWriterDeps {
  webdavClient?: NextcloudWebDAVClient;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences. `originalFileName`
 * and `lernfeld` are not trusted to be safe for direct path construction (e.g.
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

/**
 * `createDirectory(path, { recursive: true })` from the `webdav` package already stats each
 * path segment before creating it, so it's idempotent against an already-existing folder on
 * its own. This cache only avoids repeating that network round trip for every file written
 * into a Fach folder that's already been confirmed to exist earlier in the same process.
 */
export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const client: NextcloudWebDAVClient =
    deps.webdavClient ??
    createClient(`${config.nextcloud.baseUrl()}/remote.php/dav/files/${config.nextcloud.username()}`, {
      username: config.nextcloud.username(),
      password: config.nextcloud.appPassword(),
    });
  const knownDirs = new Set<string>();

  return {
    async writeResult(result, content, datum) {
      const dirParts = deriveTargetDir(result);
      const targetDir = `/${dirParts.join('/')}`;
      const fileName = deriveFileName(result, content, datum);
      const writtenPath = `${targetDir}/${fileName}`;

      if (!knownDirs.has(targetDir)) {
        await client.createDirectory(targetDir, { recursive: true });
        knownDirs.add(targetDir);
      }

      const bytes = content.kind === 'pdf' ? content.bytes : await fs.readFile(content.sourcePath);
      const ok = await client.putFileContents(writtenPath, bytes);
      if (ok === false) {
        throw new Error(`nextcloud/writeResult: failed to upload "${writtenPath}" via WebDAV`);
      }

      return { writtenPath };
    },
  };
}
