import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  // Treat an empty-string env var the same as an unset one (consistent with `required()`'s
  // `if (!value)` check below). Checked-in .env templates commonly leave optional keys
  // present but blank (e.g. `ANTHROPIC_MODEL=`) - `??` alone would take that literal '' as
  // the value and silently defeat the documented default.
  const value = process.env[name];
  return value ? value : fallback;
}

export const config = {
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },
  ingest: {
    // Folder watched for manually-downloaded files (zips, PDFs, docs, etc.) - e.g. a
    // Nextcloud-synced directory the user drops exported Teams files into by hand.
    watchDir: optional('INGEST_WATCH_DIR', '__INBOX__'),
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
  worker: {
    concurrency: Number(optional('WORKER_CONCURRENCY', '1')),
  },
  anthropic: {
    // No fallback default: leaving ANTHROPIC_API_KEY unset is valid and expected when the
    // Claude Agent SDK subprocess is authenticated via a Claude Pro/Max subscription login
    // (`claude login`) instead of API billing. The SDK subprocess inherits process.env and
    // resolves its own auth source; we don't require a key here.
    apiKey: (): string | undefined => process.env.ANTHROPIC_API_KEY,
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),
  },
  // Reached over Tailscale via WebDAV (see the `tailscale` sidecar service in
  // docker-compose.yml) - no filesystem or `occ` access to Nextcloud's host needed.
  nextcloud: {
    baseUrl: () => optional('NEXTCLOUD_BASE_URL', ''),
    username: () => optional('NEXTCLOUD_USERNAME', ''),
    appPassword: () => optional('NEXTCLOUD_APP_PASSWORD', ''),
    outboxDir: optional('OUTBOX_DIR', '__OUTBOX__'),
  },
  taildrop: {
    // Directory the tailscale sidecar drains its Taildrop queue into (shared Docker volume
    // with the ingest container - see docker-compose.yml).
    stagingDir: optional('TAILDROP_STAGING_DIR', '/taildrop-staging'),
    pollIntervalMs: Number(optional('TAILDROP_POLL_INTERVAL_MS', '5000')),
  },
  student: {
    name: (): string => optional('STUDENT_NAME', 'Schüler'),
    klasse: (): string => optional('STUDENT_KLASSE', 'Schule'),
  },
  poppler: {
    pdftotextBin: optional('PDFTOTEXT_BIN', 'pdftotext'),
    pdftoppmBin: optional('PDFTOPPM_BIN', 'pdftoppm'),
    pdfinfoBin: optional('PDFINFO_BIN', 'pdfinfo'),
    pdfimagesBin: optional('PDFIMAGES_BIN', 'pdfimages'),
  },
  ocr: {
    binary: optional('OCRMYPDF_BIN', 'ocrmypdf'),
    languages: optional('OCR_LANGUAGES', 'deu+eng'),
  },
  markitdown: {
    binary: optional('MARKITDOWN_BIN', './.venv/bin/markitdown'),
  },
  pandoc: {
    binary: optional('PANDOC_BIN', 'pandoc'),
    templatePath: optional('PANDOC_TEMPLATE_PATH', './docker/vorlage/template.html'),
    cssPath: optional('PANDOC_CSS_PATH', './docker/vorlage/style.css'),
    weasyprintBinary: optional('WEASYPRINT_BIN', './.venv/bin/weasyprint'),
  },
  dictionary: {
    deDicPath: optional('HUNSPELL_DE_DIC_PATH', '/usr/share/hunspell/de_DE.dic'),
    enDicPath: optional('HUNSPELL_EN_DIC_PATH', '/usr/share/hunspell/en_US.dic'),
  },
  agy: {
    pass1Model: optional('PASS1_MODEL', 'gemini-3.5-flash'),
    pass1Effort: optional('PASS1_EFFORT', 'low'),
    pass2Model: optional('PASS2_MODEL', 'gemini-3.5-flash'),
    pass2Effort: optional('PASS2_EFFORT', 'low'),
    printTimeout: optional('AGY_PRINT_TIMEOUT', '5m'),
    binary: optional('AGY_BIN', 'agy'),
  },
  nearDup: {
    skipDistance: Number(optional('NEAR_DUP_SKIP_DISTANCE', '3')),
    flagDistance: Number(optional('NEAR_DUP_FLAG_DISTANCE', '10')),
  },
};
