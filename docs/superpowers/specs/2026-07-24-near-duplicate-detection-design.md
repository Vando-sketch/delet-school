# Near-duplicate detection for the ingest pipeline

Date: 2026-07-24
Status: Approved, ready for implementation planning

## Context

`src/ingest/dedup.ts` (fixed for a TOCTOU race in a prior change: `claimHash()` atomically
checks-and-records a SHA-256 of a file's raw bytes) only catches byte-identical duplicates. A
student re-scanning, re-exporting from Teams, or re-saving the same worksheet produces different
bytes — different PDF producer metadata, different recompression, different OCR pass — so it
sails through as "new" and gets solved and filed a second time.

Two things simplify the design space:

1. `extractFile()` (`src/extract/index.ts`) already produces normalized `markdown` for every
   job, run once in `src/worker/index.ts:handleJob()` before the LLM-solve step
   (`fileProcessor.processFile`). That extraction — including OCR when needed — is the most
   expensive step before the LLM call itself; reusing its output for a duplicate check avoids
   paying for a second extraction pass.
2. The pipeline only ever accepts `.pdf`, `.docx`, `.txt`, `.md` (`extractFile()` throws
   `unsupported file type` on anything else). A phone photo of a worksheet is not a distinct
   ingest type — it has to already be a scanned PDF to get in at all, and that goes through the
   same OCR path as any other PDF. So a single text-based signal covers every input type; no
   separate perceptual-image-hash path is needed.

## Goal

Catch near-duplicate submissions — same underlying worksheet, different bytes — without
introducing a real risk of silently dropping a genuinely different piece of homework. The
asymmetry matters: missing a near-duplicate costs a redundant solve; wrongly treating two
different worksheets as duplicates costs a student's homework never being solved, with no
visible signal that it happened. The design must bias toward the cheaper failure.

## Design

### Where it runs

Inside `src/worker/index.ts:handleJob()`, immediately after `extractFile()` returns and before
`fileProcessor.processFile()` is called. This reuses the `markdown` the job already computed —
no separate extraction pass at ingest time, and the check happens before the pipeline's most
expensive step (the LLM solve), not after it.

### Signal: SimHash over normalized text

New module `src/ingest/nearDup.ts`, parallel to `dedup.ts`:

- `normalizeText(markdown: string): string` — lowercase, collapse whitespace, strip
  punctuation. Blunts OCR noise (differing whitespace/punctuation between two OCR passes of the
  same worksheet) without needing a dictionary or language-aware normalization.
- `simhash(text: string): bigint` — a 64-bit SimHash: shingle the normalized text into
  word-trigrams, hash each shingle (`crypto.createHash('sha256')`, truncated to 64 bits, same
  direct use of node's `crypto` module `computeFileHash` already relies on — no new
  dependency), then bit-vote across all shingle hashes to produce one 64-bit fingerprint.
  Near-identical text produces a fingerprint a few bits away; unrelated text produces one close
  to random (~32 bits away on average for 64 bits).
- `hammingDistance(a: bigint, b: bigint): number` — popcount of `a XOR b`.

### Storage and comparison

Redis hash `delet_school:content_signatures`. Each entry: field = a random id
(`crypto.randomUUID()`), value = JSON `{ simhash: string, originalFileName: string, recordedAt:
string }`. On every job, after computing the new document's SimHash:

1. `HGETALL` the whole hash (fine at this pipeline's scale — a school's homework volume, not
   internet-scale — so brute-force comparison against every stored signature needs no LSH
   bucketing or index).
2. Compute Hamming distance against every stored signature, keep the minimum and its entry.
3. Classify into a tier by distance against two configurable thresholds (see below).
4. **Unconditionally** store the new document's own signature, regardless of tier — so a third
   copy of the same worksheet later still has something to match against, even if this one was
   itself flagged or skipped as a duplicate.

No TTL or bounding on the hash's growth, matching the precedent already accepted for
`dedup.ts`'s own unbounded Redis set — solving unbounded growth for either is out of scope here.

### Thresholds and config

Two new entries under `config.ingest` (or a new `config.nearDup` block), following the existing
`optional(name, fallback)` pattern used throughout `src/config/index.ts`:

```ts
nearDup: {
  skipDistance: Number(optional('NEAR_DUP_SKIP_DISTANCE', '3')),
  flagDistance: Number(optional('NEAR_DUP_FLAG_DISTANCE', '10')),
},
```

Both are Hamming distances out of 64 bits. Starting values are not empirically tuned — same
caveat every heuristic threshold in this codebase ships with (e.g. the OCR-quality dictionary
ratio) — and are expected to need adjustment once real near-duplicate traffic is observed.

### Verdict and per-tier behavior

`checkNearDuplicate(markdown: string): Promise<NearDupVerdict>` where

```ts
type NearDupVerdict = {
  tier: 'duplicate' | 'flagged' | 'unique';
  distance: number | null;       // null when there was nothing to compare against, or Redis was unavailable
  matchedFile: string | null;    // originalFileName of the closest stored signature, if any
};
```

- `distance <= skipDistance` → **`duplicate`**. Same handling as today's exact-hash duplicate
  path in `watcher.ts`: skip `fileProcessor.processFile`/`buildSolutionMarkdown`/
  `renderSolutionPdf`/`writeResult`, archive the file to `config.ingest.processedDirName`, log
  at `info` with the matched file and distance. Return early from `handleJob()`.
- `skipDistance < distance <= flagDistance` → **`flagged`**. The homework is still solved and
  filed exactly as normal — this tier only ever adds visibility, never withholds output. Log a
  `warn` with the matched file and distance so an operator can notice a pattern in logs. No new
  review folder or UI in this pass (see "Explicitly out of scope").
- `distance > flagDistance`, or no stored signatures yet → **`unique`**. Proceeds normally, no
  log beyond the signature being recorded.

### Error handling

If Redis is unavailable when `checkNearDuplicate()` runs (connection not `ready`, or an error
thrown mid-call), fail open: log a `warn` and return `{ tier: 'unique', distance: null,
matchedFile: null }` — treat as if there was nothing to compare against, proceed to solve. This
is a secondary, best-effort signal on top of the exact-hash check; it must never block a real
submission from being processed. Mirrors `dedup.ts`'s own Redis-error fallback philosophy.

## Interfaces

- New `src/ingest/nearDup.ts`:
  - `normalizeText(markdown: string): string`
  - `simhash(text: string): bigint`
  - `hammingDistance(a: bigint, b: bigint): number`
  - `checkNearDuplicate(markdown: string): Promise<NearDupVerdict>` (exported `NearDupVerdict`
    type alongside it)
- `src/config/index.ts`: new `nearDup: { skipDistance, flagDistance }` block.
- `src/worker/index.ts`: `handleJob()` calls `checkNearDuplicate(extraction.markdown)` right
  after `extractFile()`; on `tier === 'duplicate'`, archive and return early (same shape as the
  existing success-path archive call, just skipping the solve/render/write steps in between).

## Testing

- `test/ingest-nearDup.test.ts` (new):
  - `simhash`/`hammingDistance`: near-identical strings (typos, whitespace/punctuation
    differences simulating OCR noise) produce a low distance; unrelated strings produce a high
    one.
  - `checkNearDuplicate()` with a mocked Redis (same DI pattern as `ingest-dedup.test.ts`'s
    `mockRedis`): empty store → `unique`; a stored signature within `skipDistance` → `duplicate`;
    within `flagDistance` but beyond `skipDistance` → `flagged`; beyond `flagDistance` →
    `unique`; the new signature is always recorded regardless of tier; a Redis error → fails
    open to `unique` with `distance: null`.
- `test/worker.test.ts` (extended): a `flagged` verdict still calls `processFile`/
  `buildSolutionMarkdown`/`renderSolutionPdf`/`writeResult` (proceeds normally); a `duplicate`
  verdict skips all of those and archives to `.processed` instead (mirrors the existing
  exact-hash duplicate test already present for the watcher layer, at the worker layer this
  time).

## Explicitly out of scope

- **A manual-review queue/folder/UI for `flagged` matches.** This pass only adds log
  visibility. Building an actual review workflow (a folder, a notification, a dashboard) is
  separate, larger scope and not needed for the core detection logic to be useful.
- **Threshold auto-tuning.** `skipDistance`/`flagDistance` are fixed config values with
  reasonable starting guesses, not adjusted based on observed match-rate data.
- **Bounding/expiring the Redis signature store.** Same accepted risk as the existing
  exact-hash `Set`/Redis set in `dedup.ts` — unbounded growth is a known, deferred concern for
  both, not solved here.
- **LSH/indexed similarity search.** Brute-force comparison against every stored signature is
  adequate at this pipeline's expected volume; an index is unnecessary complexity until proven
  otherwise.

## Summary of decisions carried into the implementation plan

| Question | Decision |
|---|---|
| Signal | 64-bit SimHash over normalized-text word-trigrams (hand-rolled, no new dependency) |
| Where it runs | Worker, after `extractFile()`, before `fileProcessor.processFile()` |
| Comparison scope | All previously recorded signatures (Redis hash, brute-force distance) |
| Storage | Every job's signature is recorded, regardless of tier |
| Tiering | `duplicate` (<= skipDistance) auto-skips like exact-hash dup; `flagged` (<= flagDistance) still solves, just logs a warning; `unique` proceeds silently |
| Defaults | `skipDistance = 3`, `flagDistance = 10` (out of 64 bits), both configurable via env |
| Redis unavailable | Fail open to `unique` |
| Manual-review workflow | Out of scope — log-only visibility for `flagged` |
| Signature store bounding | Out of scope, same accepted risk as the existing exact-hash store |
