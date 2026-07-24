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
cheap first filter. Below that gate, the text must pass **either** a new dictionary real-word
check **or** the original alphanumeric-ratio check (kept unchanged, now acting as a safety net
rather than the primary signal):

1. **Tokenize** the text into candidate words: extract maximal runs of Unicode letters
   (`\p{L}+`), keep tokens with >= 2 characters (this naturally strips digits/punctuation as
   token boundaries, no separate stripping step needed).
2. **Dictionary ratio** (primary check): look up each token, lowercased, in an in-memory
   `Set<string>` built from German and English word lists plus a small hardcoded domain
   whitelist (see below). Passes if there is at least one token and
   `realWordCount / totalTokenCount >= 0.45`.
3. **Alphanumeric ratio** (safety net, same threshold as today but broadened from a hardcoded
   `[a-zA-Z0-9äöüÄÖÜß]` list to the Unicode `\p{L}\p{N}` classes — a deliberate correctness
   improvement, not an oversight: it matches the tokenizer's own Unicode-letter definition
   instead of special-casing German umlauts, at the cost of also counting non-Latin-script OCR
   noise as "alphanumeric" for the rare page containing it): fraction of non-whitespace
   characters that are letters or digits, passes at `>= 0.6`. A page that fails the dictionary
   check (e.g. `f(x) = x^2 + 2x`, `§ 437 BGB` — few or no recognizable dictionary words) still
   passes overall if its characters are structurally healthy prose/formula text rather than
   OCR noise.

An earlier draft of this check used a "run of consecutive symbol characters" pattern as the
safety net instead of the alphanumeric ratio. Tracing it against this codebase's own gibberish
fixture (`'l|i1l!! O0--_x~~ '.repeat(10)`, from the existing `isQualityText` tests) showed that
pattern does **not** fire on it — the symbol runs in that string are only 2-3 characters long,
never 6+ — so that version would have wrongly classified the existing gibberish test case as
quality text. The alphanumeric-ratio safety net does not have this problem: that same
gibberish string is roughly 47% alphanumeric (well under the 0.6 threshold), so it's correctly
rejected by both checks, while a formula/citation-heavy page (mostly letters, digits, and a few
symbols like `§`/`^`/`=`) clears 0.6 easily.

```
isQualityText(text, isRealWord):
  nonWhitespace = strip whitespace from text
  if nonWhitespace.length < MIN_CHARS: return false
  return dictionaryRatioPasses(text, isRealWord) or alphanumericRatioPasses(text)

dictionaryRatioPasses(text, isRealWord):
  tokens = extract runs of Unicode letters with length >= 2
  if tokens.length == 0: return false
  return count(isRealWord(t) for t in tokens) / tokens.length >= MIN_REAL_WORD_RATIO   # 0.45

alphanumericRatioPasses(text):                      # same threshold, Unicode letter/digit classes
  nonWhitespace = strip whitespace from text
  alnumCount = count of Unicode letters/digits in nonWhitespace
  return alnumCount / nonWhitespace.length >= MIN_ALPHANUMERIC_RATIO                   # 0.6
```

`hasQualityAlphanumericRatio()` (used elsewhere for short excerpts like document headers,
without the `MIN_CHARS` gate) gets the same `dictionaryRatioPasses or alphanumericRatioPasses`
treatment, minus the length gate, matching its existing contract.

### Dictionary source

Add `hunspell-de-de` and `hunspell-en-us` to `docker/Dockerfile`'s apt install list (small,
combined ~2-5MB), which install to the standard Debian paths `/usr/share/hunspell/de_DE.dic`
and `/usr/share/hunspell/en_US.dic`. `config.dictionary.deDicPath` / `.enDicPath` (new,
following the existing `config.poppler`/`config.pandoc` pattern of env-overridable binary/
asset paths, default to those two paths) tell `loadWordSet()` where to read from. Their `.dic`
files (plain `word/AFFIXFLAGS` lines) are parsed on first use (see the lazy-singleton note
below): split each line on `/`, keep the word, lowercase, insert into a `Set<string>`.
Hunspell's affix-rule engine is not needed —
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
  - Both default `isRealWord` to a validator resolved by `getDefaultIsRealWord()`, a lazily
    memoized singleton (built on first call that doesn't supply its own `isRealWord`, then
    cached) — **not** built eagerly at module load. Eager module-load construction would make
    `import`ing this file throw on any machine without the hunspell dictionaries installed
    (any dev machine or CI run outside the Docker image), since `loadWordSet()` reads real
    files from disk. `getDefaultIsRealWord()` wraps its one-time `loadWordSet()` call in a
    try/catch: on failure (missing dictionary files), it logs a warning once and falls back to
    an always-true validator, so the dictionary check always passes when there's at least one
    token and quality gating degrades to the alphanumeric-ratio check alone — exactly today's
    shipped behavior, so this is a graceful degradation, not a silent correctness loss, and it
    only affects environments without hunspell installed (i.e. never the production Docker
    image). Every unit test supplies its own `WordValidator`, so the lazy loader — and its
    filesystem access — is never exercised by the test suite.
- `src/extract/index.ts`'s `ExtractDeps` gains an optional `isQualityText` override exactly as
  it already does for the other extraction functions — no shape change beyond the new
  optional `WordValidator` parameter flowing through.

### Testing

- `test/extract/dictionary.test.ts` (new): `loadWordSet()` parses a small fake `.dic` fixture
  (injected via `readFileSync`) into the expected `Set`; affix flags after `/` are stripped.
- `test/extract/pdfText.test.ts` (extended, and its 3 existing cases updated to pass an
  explicit fake `WordValidator` instead of relying on the real default — the suite must not
  depend on whether hunspell happens to be installed on the machine running it): real German
  prose passes with a permissive fake validator; `"l|i1l!! O0--_x~~ ".repeat(10)` fails with a
  validator that recognizes no words (zero qualifying tokens *and* alphanumeric ratio ~41%,
  under the 0.6 threshold — fails both checks); a formula/citation-style line with real
  2+-letter tokens but a validator that recognizes none of them as real words still passes,
  because its alphanumeric ratio is high (safety net); a line with word-shaped tokens *and*
  heavy symbol noise, with a validator that recognizes no words, fails both checks.

### Risk carried forward (not resolved by this design)

The 0.45 dictionary-ratio threshold is a starting point, not empirically tuned — same caveat
the original 0.6 alphanumeric-ratio heuristic shipped with (and which is kept, unchanged, as
the safety net here).
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
| OCR-quality check approach | Real-word dictionary ratio (hunspell DE/EN word lists), OR the original alphanumeric-ratio check as a safety net for formula/table pages |
| Dictionary dependency | `hunspell-de-de` / `hunspell-en-us` apt packages, parsed once at startup into an in-memory `Set` |
| Subfolder watch depth | Unlimited (remove `depth: 0`), no new config |
| POSIX fix scope | `fs.rename` → `EXDEV`-aware copy+unlink fallback; ignored-dir matching by path segment |
| Nested file naming | `originalFileName` = path relative to `watchDir` |
| Nested file batching | Standalone job unless inside a zip (unchanged rule, just no longer top-level-only) |
| Empty subfolder cleanup | Out of scope |
| Configurable depth cap | Out of scope |
