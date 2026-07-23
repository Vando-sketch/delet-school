import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { config } from '../config/index.js';

const logger = pino({ name: 'taildrop-drain' });

async function uniqueDestPath(watchDir: string, fileName: string): Promise<string> {
  const candidate = path.join(watchDir, fileName);
  const exists = await fs.stat(candidate).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return candidate;
  }
  const ext = path.extname(fileName);
  const stem = ext.length > 0 ? fileName.slice(0, -ext.length) : fileName;
  return path.join(watchDir, `${stem}_${Date.now().toString(36)}${ext}`);
}

/**
 * Moves every file currently sitting in `stagingDir` into `watchDir`. Files land unchanged
 * when no same-named file is already in `watchDir` (the common case - output filenames flow
 * straight into the final solved-PDF name via `originalFileName`, so this must not touch them
 * unconditionally); a same-named collision gets a short suffix instead of silently overwriting.
 */
export async function drainOnce(stagingDir: string, watchDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(stagingDir);
  } catch (err) {
    logger.error({ err, stagingDir }, 'Failed to read Taildrop staging directory');
    return;
  }

  for (const name of entries) {
    const src = path.join(stagingDir, name);
    try {
      const stats = await fs.stat(src);
      if (!stats.isFile()) {
        continue;
      }
      const dest = await uniqueDestPath(watchDir, name);
      await fs.rename(src, dest);
      logger.info({ src, dest }, 'Drained Taildrop file into inbox');
    } catch (err) {
      logger.error({ err, src }, 'Failed to drain Taildrop file');
    }
  }
}

export interface TaildropDrain {
  stop(): void;
}

export interface CreateTaildropDrainOptions {
  stagingDir?: string;
  watchDir?: string;
  intervalMs?: number;
}

export function createTaildropDrain(options: CreateTaildropDrainOptions = {}): TaildropDrain {
  const stagingDir = path.resolve(options.stagingDir ?? config.taildrop.stagingDir);
  const watchDir = path.resolve(options.watchDir ?? config.ingest.watchDir);
  const intervalMs = options.intervalMs ?? config.taildrop.pollIntervalMs;

  const timer = setInterval(() => {
    void drainOnce(stagingDir, watchDir);
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
