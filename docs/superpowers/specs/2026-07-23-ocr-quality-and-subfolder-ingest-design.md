# OCR-quality dictionary gate + recursive subfolder ingest

Date: 2026-07-23
Status: Approved, ready for implementation planning

## Context

Two follow-up items were left open in [README.md](../../../README.md)'s "Known open items"
after the PDF-solve pipeline and Tailscale/Nextcloud decoupling work landed:

1. `isQualityText()` in `src/extract/pdfText.ts` gates whether a page's extracted text is
   good enough to use, or needs OCR / a vision fallback, using a simple alphanumeric-character
   ratio. This is a cheap proxy that both false-positives (Tesseract garbage like
   `"l|i1l!! O0--_x~~"` easily clears a raw ratio check) and, potentially, false-negatives on
   legitimate punctuation/number-heavy pages.
2. `createIngestWatcher()` in `src/ingest/watcher.ts` only watches the top level of
   `INGEST_WATCH_DIR` (`depth: 0`) and was flagged as "assumes a local/POSIX filesystem"
   without that assumption being pinned down precisely.

These are two independent, small-to-medium follow-ups (different files, different concerns);
this spec covers both because each is too small to warrant its own document, but they remain
separable in implementation — either can ship without the other.

## Goal

1. Replace the OCR-quality gate's alphanumeric-ratio heuristic with a real-word dictionary
   check, so garbled OCR/handwriting output is rejected more reliably without also rejecting
   legitimate formula-, table-, or citation-heavy pages.
2. Let the ingest watcher pick up files dropped into subfolders of `INGEST_WATCH_DIR`
   (unlimited recursion, no new config), and fix the specific filesystem assumptions in the
   current top-level-only code that don't hold once files can live in nested folders.

---

## Part 1: Dictionary-based OCR-quality gate

### Design

`isQualityText()` keeps its existing `MIN_CHARS` (100 non-whitespace characters) gate as a
cheap first filter, then replaces the alphanumeric-ratio check with a two-stage real-word
check:

1. **Tokenize** the text into candidate words: split on whitespace, strip surrounding
   punctuation/digits, lowercase, keep tokens with >= 2 alphabetic characters.
2. **Dictionary ratio**: look up each token in an in-memory `Set<string>` built from German
   and English word lists plus a small hardcoded domain whitelist (see below). Pass if
   `realWordCount / totalTokenCount >= 0.45`.
3. **Safety net for low-word-ratio pages**: a page that fails step 2 is not immediately
   rejected if it has "healthy" character structure — no run of >= 6 consecutive
   non-alphanumeric/non-space characters (the `O0--_x~~`-style pattern that's the actual
   OCR-garbage signature) — in which case it passes anyway. This exists specifically so
   formula-, table-, or legal-citation-heavy pages (`f(x) = x^2 + 2x`, `§ 437 BGB`) with a low
   real-word ratio aren't misclassified as garbage.

```
isQualityText(text):
  nonWhitespace = strip whitespace from text
  if nonWhitespace.length < MIN_CHARS: return false
  tokens = tokenize(text)                          # >=2 alpha chars, punctuation/digits stripped
  if tokens.length == 0: return not hasGarbageRun(text)
  realWordRatio = count(isRealWord(t) for t in tokens) / tokens.length
  if realWordRatio >= MIN_REAL_WORD_RATIO: return true
  return not hasGarbageRun(text)                   # safety net for formula/table pages
```

`hasQualityAlphanumericRatio()` (used elsewhere for short excerpts like document headers,
without the `MIN_CHARS` gate) gets the same tokenize + dictionary-ratio treatment, minus the
length gate, matching its existing contract.

### Dictionary source

Add `hunspell-de-de` and `hunspell-en-us` to `docker/Dockerfile`'s apt install list (small,
combined ~2-5MB). Their `.dic` files (plain `word/AFFIXFLAGS` lines under
`/usr/share/hunspell/`) are parsed once at process startup: split each line on `/`, keep the
word, lowercase, insert into a `Set<string>`. Hunspell's affix-rule engine is not needed —
this is a coarse "is this string anywhere in a known word list" check, not a spellchecker; it
undercounts inflected forms in edge cases, which is acceptable given the 0.45 ratio threshold
already tolerates some proportion of unmatched real words.

A hardcoded domain whitelist is merged into the same `Set` at load time: the `FACH_KEYS`
values from `src/fach.ts` (lowercased) plus a short list of legal/school abbreviations that
won't appear in a general dictionary (`bgb`, `lf`, `gg`, ...). This exists because subject
codes and citations are expected, legitimate vocabulary in this document domain, not noise.

### Interfaces

`isQualityText()`/`hasQualityAlphanumericRatio()` are called synchronously today (e.g. inside
`.some()`/`.filter()` callbacks in `src/extract/index.ts`, never awaited) — the dictionary
load must not turn them async. `loadWordSet()` is therefore synchronous, reading the `.dic`
files with `fs.readFileSync` (they're small, read once):

- New `src/extract/dictionary.ts`:
  - `loadWordSet(deps?: { readFileSync?, hunspellDicPaths?: string[] }): Set<string>` —
    reads and parses the `.dic` files synchronously; injectable `readFileSync` for testing
    without real files on disk.
  - `buildWordValidator(words: Set<string>): WordValidator` where
    `type WordValidator = (word: string) => boolean`.
- `src/extract/pdfText.ts`:
  - `isQualityText(text: string, isRealWord?: WordValidator): boolean`
  - `hasQualityAlphanumericRatio(text: string, isRealWord?: WordValidator): boolean`
  - Both default `isRealWord` to a validator built once from `loadWordSet()` at module load
    (module-level `const`, not lazy) — callers that inject their own `WordValidator` (all unit
    tests) never trigger the real dictionary read.
- `src/extract/index.ts`'s `ExtractDeps` gains an optional `isQualityText` override exactly as
  it already does for the other extraction functions — no shape change beyond the new
  optional `WordValidator` parameter flowing through.

### Testing

- `test/extract/dictionary.test.ts` (new): `loadWordSet()` parses a small fake `.dic` fixture
  (injected via `readFileSync`) into the expected `Set`; affix flags after `/` are stripped.
- `test/extract/pdfText.test.ts` (extended): inject a small fake `WordValidator` (e.g.
  `(w) => ['der', 'kaufvertrag', 'mangel'].includes(w)`) — no real dictionary file touched in
  unit tests. Cases: real German prose passes; `"l|i1l!! O0--_x~~".repeat(10)` fails (both low
  real-word ratio and a garbage run); a formula-heavy line with a healthy character structure
  but low real-word ratio passes via the safety net; a `_Unsortiert`-style low-ratio page *with*
  a garbage run fails.

### Risk carried forward (not resolved by this design)

The 0.45 ratio and the "6 consecutive non-alphanumeric chars" garbage-run threshold are
starting points, not empirically tuned — same caveat the original heuristic shipped with.
Tuning against real scanned/handwritten homework is expected follow-up once this is in use,
same as today.

---

## Part 2: Recursive subfolder ingest

### Design

**Watching:** remove `depth: 0` from the `chokidarWatch()` options in `createIngestWatcher()`
entirely — unlimited recursion, no new config surface. This mirrors how zip-extracted files
are already handled recursively via `listFilesRecursive()`, so the codebase stops having two
different depth policies for conceptually the same "process every file that shows up" job.

**Ignored-directory matching:** the current `ignored` callback anchors `.processed`/`.failed`/
`.staging` paths to the top level only (`candidate.startsWith(dir + path.sep)` where `dir` is
always `path.join(watchDir, name)` — a top-level path). Once files can live in subfolders,
this needs to catch those directory names at any depth:

```ts
const ignoredNames = new Set([
  config.ingest.processedDirName,
  config.ingest.failedDirName,
  config.ingest.stagingDirName,
]);

ignored: (candidate) => {
  const rel = path.relative(watchDir, candidate);
  return rel.split(path.sep).some((segment) => ignoredNames.has(segment));
};
```

**The actual "assumes a local/POSIX filesystem" issue:** auditing the code (not just the
README's docstring) turns up `fs.rename()`, used in both `watcher.ts:archiveFile()` and
`worker/index.ts`'s archive step, to move a fully-handled file into `.processed`/`.failed`.
POSIX `rename(2)` requires source and destination to be on the same filesystem/mount, and
throws `EXDEV` otherwise. This is harmless today because everything lives under one bind
mount, but stops being safe once arbitrary subfolders exist (e.g. a future setup where a
subfolder is itself a separate mount, network share, or Docker volume). Fix: wrap the archive
move in a helper that falls back to copy-then-unlink when `rename` fails with `EXDEV`.

Path-separator handling elsewhere (`path.join`, `path.sep`, `path.relative`) is already
platform-correct Node API usage, not a real bug — the only genuinely incorrect assumption is
the `fs.rename` one. Case-sensitivity is not addressed: the Docker deployment target (Linux
containers, per `docker-compose.yml`) is case-sensitive throughout, and it is out of scope to
support case-insensitive host filesystems.

**File naming and batching for nested files:**

- `originalFileName` for a subfolder-sourced file becomes its path relative to `watchDir`
  (e.g. `"Mathe/AB1.pdf"`) instead of just `path.basename(filePath)`. This flows unchanged
  into two existing consumers with no further code changes needed:
  - The Claude solve prompt sees the fuller relative path as free subject-classification
    context (folder name as a Fach hint), matching how zip-extracted files already surface
    their relative-to-staging-dir path today.
  - `nextcloud/writeResult.ts`'s `sanitizePathSegment()` already replaces `/` with `_` before
    building the final Nextcloud filename, so `"Mathe/AB1.pdf"` becomes
    `"Mathe_AB1_Loesung_<date>.pdf"` with no new sanitization logic required.
- A file dropped directly into a subfolder (not inside a zip) remains a standalone job, same
  as today's top-level plain files — sibling-batch treatment stays exclusive to zip contents.
- A zip dropped into a subfolder (e.g. `__INBOX__/Mathe/export.zip`) has its extracted files'
  `originalFileName` prefixed with that subfolder path (e.g. `"Mathe/file-a.txt"`), consistent
  with the rule above.

### Explicitly out of scope

- **Empty-subfolder cleanup**: once every file originally in `__INBOX__/Mathe/` has been
  archived into `.processed`/`.failed`, the now-empty `Mathe/` folder is left in place rather
  than pruned. Cosmetic, not correctness-affecting; noted here as a candidate future
  follow-up, not part of this plan.
- **Configurable depth limit**: no `INGEST_WATCH_DEPTH`-style cap is introduced. If unbounded
  recursion turns out to be a problem in practice (e.g. a user nests the watched folder inside
  something enormous), that is a separate follow-up.

### Interfaces

- `src/ingest/watcher.ts`:
  - `createIngestWatcher()`'s public signature is unchanged.
  - New internal helper `renameOrCopy(src: string, dest: string): Promise<void>` used by
    `archiveFile()`, catching `EXDEV` and falling back to `fs.copyFile` + `fs.unlink`.
  - `handlePlainFile()` and the zip-extraction path in `handleZip()` both compute
    `originalFileName` via `path.relative(watchDir, filePath)` instead of
    `path.basename(filePath)` (for the top-level plain-file case) / the existing
    `path.relative(stagingDir, filePath)` (for zip contents, prefixed with the zip's own
    subfolder-relative path when the zip itself was nested).
- `src/worker/index.ts`'s archive step reuses the same `renameOrCopy()` helper (moved to a
  shared location, e.g. `src/lib/renameOrCopy.ts`, since both `watcher.ts` and `worker/
  index.ts` need it — same rationale as the existing shared `src/lib/execFile.ts`).

### Testing

- `test/ingest-watcher.test.ts` (extended): a file dropped into a subfolder is enqueued with
  a relative-path `originalFileName`; `.processed`/`.failed`/`.staging` directories nested
  under a subfolder are still ignored; a zip dropped into a subfolder produces extracted-file
  jobs with the subfolder prefix in `originalFileName`.
- `test/lib/renameOrCopy.test.ts` (new): normal same-filesystem rename delegates to
  `fs.rename`; an injected `rename` that throws `EXDEV` falls back to copy+unlink, verified via
  injected `fs` function stubs (same DI pattern as `ExecFileFn`).

---

## Summary of decisions carried into the implementation plan

| Question | Decision |
|---|---|
| OCR-quality check approach | Real-word dictionary ratio (hunspell DE/EN word lists) + garbage-run safety net for formula/table pages |
| Dictionary dependency | `hunspell-de-de` / `hunspell-en-us` apt packages, parsed once at startup into an in-memory `Set` |
| Subfolder watch depth | Unlimited (remove `depth: 0`), no new config |
| POSIX fix scope | `fs.rename` → `EXDEV`-aware copy+unlink fallback; ignored-dir matching by path segment |
| Nested file naming | `originalFileName` = path relative to `watchDir` |
| Nested file batching | Standalone job unless inside a zip (unchanged rule, just no longer top-level-only) |
| Empty subfolder cleanup | Out of scope |
| Configurable depth cap | Out of scope |
