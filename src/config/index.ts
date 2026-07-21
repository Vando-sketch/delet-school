import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },
  ingest: {
    // Folder watched for manually-downloaded files (zips, PDFs, docs, etc.) - e.g. a
    // Nextcloud-synced directory the user drops exported Teams files into by hand.
    watchDir: optional('INGEST_WATCH_DIR', './inbox'),
    // Subfolders of watchDir that ingested files are moved into after processing, so the
    // watcher never re-enqueues its own output. Kept inside watchDir so a single bind mount
    // covers everything.
    processedDirName: optional('INGEST_PROCESSED_DIRNAME', '.processed'),
    failedDirName: optional('INGEST_FAILED_DIRNAME', '.failed'),
    // Scratch subfolder zip contents are extracted into before being enqueued file-by-file.
    stagingDirName: optional('INGEST_STAGING_DIRNAME', '.staging'),
    // How long a file must sit unmodified before it's considered fully written (avoids
    // enqueuing a partially-copied/uploaded file). Passed to chokidar's awaitWriteFinish.
    stabilityThresholdMs: Number(optional('INGEST_STABILITY_THRESHOLD_MS', '2000')),
  },
  anthropic: {
    // No fallback default: leaving ANTHROPIC_API_KEY unset is valid and expected when the
    // Claude Agent SDK subprocess is authenticated via a Claude Pro/Max subscription login
    // (`claude login`) instead of API billing. The SDK subprocess inherits process.env and
    // resolves its own auth source; we don't require a key here.
    apiKey: (): string | undefined => process.env.ANTHROPIC_API_KEY,
    model: optional('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
  },
  nextcloud: {
    dataDir: () => required('NEXTCLOUD_DATA_DIR'),
    targetUser: () => required('NEXTCLOUD_TARGET_USER'),
    occBinary: optional('NEXTCLOUD_OCC_BIN', '/var/www/nextcloud/occ'),
  },
};
