### Task 7: Full verification and README update

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Run the full automated suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three exit 0.

- [ ] **Step 2: Update the README's "Known open items" section**

Replace:

```
## Known open items

- **Breaking change (Nextcloud config)**: The old `NEXTCLOUD_DATA_DIR`, `NEXTCLOUD_TARGET_USER`,
  and `NEXTCLOUD_OCC_BIN` environment variables are no longer supported. They have been replaced
  with `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, and `NEXTCLOUD_APP_PASSWORD` (WebDAV-based).
  Existing `.env` files must be updated to use the new variables.
- The OCR-quality gate (`isQualityText` in `src/extract/pdfText.ts`) uses a simple
  alphanumeric-ratio heuristic; a stronger check (e.g. dictionary-based) is a reasonable
  follow-up if it proves too permissive/strict in practice.
- The ingest watcher watches only the top level of `INGEST_WATCH_DIR` (no subfolders) and
  assumes a local/POSIX filesystem.
```

with:

```
## Known open items

- **Breaking change (Nextcloud config)**: The old `NEXTCLOUD_DATA_DIR`, `NEXTCLOUD_TARGET_USER`,
  and `NEXTCLOUD_OCC_BIN` environment variables are no longer supported. They have been replaced
  with `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, and `NEXTCLOUD_APP_PASSWORD` (WebDAV-based).
  Existing `.env` files must be updated to use the new variables.
- The OCR-quality gate's dictionary-ratio threshold (0.45, `src/extract/pdfText.ts`) is a
  starting point, not empirically tuned; adjusting it against real scanned/handwritten homework
  is expected follow-up once this is in regular use.
```

Also update the `Layout` section's `src/ingest/` bullet to mention subfolder support. Replace:

```
- `src/ingest/` — watches a local folder (chokidar) for dropped files; extracts zip archives
  and enqueues one job per contained file, or enqueues a single job for any other file directly.
```

with:

```
- `src/ingest/` — watches a local folder and its subfolders (chokidar) for dropped files;
  extracts zip archives and enqueues one job per contained file, or enqueues a single job for
  any other file directly.
```

- [ ] **Step 3: Confirm no stale references remain**

Run: `grep -n "alphanumeric-ratio heuristic\|only the top level" README.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for the dictionary OCR gate and subfolder ingest support"
```
