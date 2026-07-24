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
  const base = path.basename(result.originalFileName);
  const ext = path.extname(base);
  let stem = ext.length > 0 ? base.slice(0, -ext.length) : base;

  // Strip redundant leading subject / zip prefixes (e.g. AEuP_Kislik_, AEuP_, IT_Tec_, etc.)
  // since output files are already stored under the subject folder structure (Fächer/AEuP/...).
  stem = stem.replace(/^(?:AEuP|IT-Tec|IT|BGWP|Mathe|Deutsch|Englisch)_(?:Kislik_)?/i, '');
  stem = stem.replace(/^AEuP_Kislik_/i, '');

  const safeStem = sanitizePathSegment(stem);
  const finalStem = safeStem.length > 0 ? safeStem : 'untitled';

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
    async writeResult(result, content, datum) {
      const dirParts = deriveTargetDir(result);
      const targetDir = `/${dirParts.join('/')}`;
      const fileName = deriveFileName(result, content, datum);
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
