# Autonomous Improvement Sweep — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Executed inline in this session (single integration branch `chore/autonomous-improvement-sweep`), TDD, one commit per task.

**State:** REVIEWED (Phase 3 — reconciled with Claude subagent + agy/Gemini reviews; plan-review feedback folded in)

**Goal:** Make the build green (typecheck + lint + test), then land only high-value, low-risk fixes (correctness, robustness, lint hygiene) from `docs/findings/01-raw-findings.md`, each backed by a test. Large/risky items are deferred.

**Architecture:** delet-school is a homework-automation pipeline: folder watcher → text extraction (poppler/OCR/MarkItDown) → LLM solve (Gemini via `agy` primary, Claude Agent SDK fallback) → styled PDF (pandoc+weasyprint) → Nextcloud over WebDAV, wired through a BullMQ worker.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥20, vitest, eslint 9 (flat config), tsc.

## Global Constraints

- Never commit to `main`; work only on `chore/autonomous-improvement-sweep`. Open ONE PR at the end, do not merge.
- Every code change is backed by a passing test (TDD: red → green). No production code without a failing test first (exceptions: pure config/lint-config edits, which are verified by the existing test/lint runs they turn green).
- `npm run typecheck && npm run lint && npm test` must all be green at the end. `eslint .` fails only on **errors**; the 5 baseline warnings do not fail it, but this run clears them anyway (Tasks 2–3).
- Keep changes minimal and reviewable. Respect documented/intentional design (fixed Fach table, watched-folder ingest, unbounded-Redis accepted risk, untuned OCR threshold).
- Resolve the F1 model-version drift by fixing **`src/config/index.ts`** to match the tests + `.env.example` (both reviewers independently concurred: the config side drifted; tests + env template + the two-pass architecture are the source of truth).

## Baseline (Phase 0, real output)

- `typecheck`: GREEN. `lint`: RED (3 errors, 5 warnings). `test`: RED (2 failed / 156 passed of 158).

## File map

| File | Task | Change |
|---|---|---|
| `src/config/index.ts` | 1, 3 | Restore two-pass agy defaults; remove dead `required()` |
| `test/processFile.test.ts` | 2 | Drop 3 `as any` casts |
| `eslint.config.js` | 3 | Add `caughtErrorsIgnorePattern: '^_'` |
| `test/ingest-dedup.test.ts` | 3 | Rename unused `key` → `_key` |
| `src/ingest/nearDup.ts` | 4 | Thread `originalFileName` into `checkNearDuplicate`, store it |
| `src/worker/index.ts` | 4 | Pass `originalFileName` at callsite |
| `test/ingest-nearDup.test.ts` | 4 | Update callsites; add record→match test |
| `src/pdf/buildMarkdown.ts` | 5 | Neutralize control chars in `escapeYamlString` |
| `test/pdf/buildMarkdown.test.ts` | 5 | Add control-char frontmatter test |
| `src/lib/execFile.ts` | 6 | Raise `maxBuffer` to 64 MiB |
| `test/lib/execFile.test.ts` | 6 | New: >1 MiB stdout is captured, not thrown |

---

### Task 1: Fix the red build — Gemini model-version config drift (F1) — IN-SCOPE, P0

**Files:** Modify `src/config/index.ts:92-95`. Tests already exist and are red: `test/config.test.ts:64-67`, `test/processFile.test.ts:377-383`.

- [ ] **Step 1: Confirm the red tests fail for the documented reason**

Run: `npx vitest run test/config.test.ts test/processFile.test.ts`
Expected: FAIL — `expected 'gemini-3.5-flash' to be 'gemini-3.6-flash'` and args do not include `gemini-3.6-flash`.

- [ ] **Step 2: Restore the two-pass defaults**

In `src/config/index.ts`, the `agy` block becomes:

```ts
  agy: {
    pass1Model: optional('PASS1_MODEL', 'gemini-3.6-flash'),
    pass1Effort: optional('PASS1_EFFORT', 'medium'),
    pass2Model: optional('PASS2_MODEL', 'gemini-3.1-pro'),
    pass2Effort: optional('PASS2_EFFORT', 'high'),
    printTimeout: optional('AGY_PRINT_TIMEOUT', '5m'),
    binary: optional('AGY_BIN', 'agy'),
  },
```

- [ ] **Step 3: Verify the tests pass**

Run: `npx vitest run test/config.test.ts test/processFile.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/config/index.ts
git commit -m "fix(config): restore two-pass agy model defaults to match tests and .env.example"
```

---

### Task 2: Fix the red lint — drop unnecessary `as any` (F2) — IN-SCOPE, P0

**Files:** Modify `test/processFile.test.ts:558,576,594`.

- [ ] **Step 1: Confirm lint is red**

Run: `npx eslint test/processFile.test.ts`
Expected: 3 errors, `@typescript-eslint/no-explicit-any` at 558/576/594.

- [ ] **Step 2: Replace the casts**

Line 558 — narrow instead of `any`:

```ts
    const props = (PASS2_JSON_SCHEMA as { properties: Record<string, { type: string }> }).properties;
```

Lines 576 and 594 — `validateShapePass2(raw: unknown, …)` already accepts `unknown`; drop the casts:

```ts
    const result = validateShapePass2(validJson);
```

- [ ] **Step 3: Verify lint + the affected tests**

Run: `npx eslint test/processFile.test.ts && npx vitest run test/processFile.test.ts`
Expected: 0 errors; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add test/processFile.test.ts
git commit -m "fix(test): remove unnecessary any casts flagged by no-explicit-any"
```

---

### Task 3: Lint hygiene — caught-errors ignore, unused arg, dead helper (F5, F6, F7) — IN-SCOPE, P2/P3

**Files:** Modify `eslint.config.js`, `test/ingest-dedup.test.ts:21`, `src/config/index.ts:3-9`.

- [ ] **Step 1: Confirm the 5 warnings**

Run: `npx eslint .`
Expected: warnings at `src/config/index.ts:3` (`required`), `src/ingest/dedup.ts:19,63` (`_err`), `src/ingest/nearDup.ts:141` (`_parseErr`), `test/ingest-dedup.test.ts:21` (`key`).

- [ ] **Step 2: Ignore `_`-prefixed caught errors in eslint config**

In `eslint.config.js`, the `no-unused-vars` rule becomes:

```js
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
```

- [ ] **Step 3: Rename the unused mock arg**

In `test/ingest-dedup.test.ts:21`, rename `key` → `_key` in the `del` mock implementation signature.

- [ ] **Step 4: Remove the dead `required()` helper**

Delete the unused `required()` function (`src/config/index.ts:3-9`). Verify it has no references first:

Run: `grep -rn "required(" src/`
Expected: no callsites (only the declaration). `optional()` is used everywhere.

Also trim the now-stale reference in the `optional()` doc comment (`src/config/index.ts:12`), which reads "consistent with `required()`'s `if (!value)` check below" — remove the `required()` mention (reviewer note #2). Keep the substantive note about treating empty strings as unset.

- [ ] **Step 5: Verify zero errors and zero warnings, and typecheck still green**

Run: `npx eslint . && npm run typecheck`
Expected: clean (0 errors, 0 warnings); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.js test/ingest-dedup.test.ts src/config/index.ts
git commit -m "chore(lint): clear unused-var warnings (caught errors, mock arg, dead helper)"
```

---

### Task 4: Thread `originalFileName` into near-duplicate recording (F3) — IN-SCOPE, P2

**Why:** The signature store is only ever written by `checkNearDuplicate`, which hardcodes `originalFileName: ''`. So in production every `matchedFile` the worker logs (`src/worker/index.ts:71,78`) is empty — the design's "log which file matched" never works. No current test catches it (`worker.test.ts` mocks the function; `ingest-nearDup.test.ts` pre-seeds named records). Severity is P2: it degrades observability of a fail-open signal; it never changes a tier decision.

**Interfaces:**
- Produces: `checkNearDuplicate(markdown: string, originalFileName: string): Promise<NearDupVerdict>` (was single-arg).

- [ ] **Step 1: Write the failing test (record → match path)**

Add to `test/ingest-nearDup.test.ts`, inside `describe('checkNearDuplicate', …)`:

```ts
    it("records the new document's own originalFileName so a later near-duplicate names it", async () => {
      await checkNearDuplicate(baseText, 'worksheet-a.pdf');

      const noisyDuplicate =
        'berechne die ableitung der funktion f x  3x^2 2x 5 und bestimme die nullstellen';
      const verdict = await checkNearDuplicate(noisyDuplicate, 'worksheet-b.pdf');

      expect(verdict.tier).toBe('duplicate');
      expect(verdict.matchedFile).toBe('worksheet-a.pdf');
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/ingest-nearDup.test.ts -t "records the new document"`
Expected: FAIL — `expected '' to be 'worksheet-a.pdf'` (currently stored empty), and a TS/arity mismatch surfaces on the other single-arg callsites once the signature changes in Step 3.

- [ ] **Step 3: Add the parameter and store it**

In `src/ingest/nearDup.ts`, change the signature and the stored record:

```ts
export async function checkNearDuplicate(markdown: string, originalFileName: string): Promise<NearDupVerdict> {
```

and

```ts
    const newRecord: SignatureRecord = {
      simhash: fingerprint.toString(),
      originalFileName,
      recordedAt: new Date().toISOString(),
    };
```

- [ ] **Step 4: Update the worker callsite**

In `src/worker/index.ts:68`:

```ts
    const verdict = await checkNearDuplicate(extraction.markdown, originalFileName);
```

(`originalFileName` is already destructured from `job.data` at the top of `handleJob`.)

- [ ] **Step 5: Update the existing single-arg test callsites**

In `test/ingest-nearDup.test.ts`, every existing `checkNearDuplicate(<text>)` call (the `returns unique…`, `unconditionally records…`, `classifies as duplicate…`, `classifies as flagged…`, `classifies as unique…`, `always records…`, both `fails open…` tests) gets a second filename argument, e.g. `checkNearDuplicate(baseText, 'new-doc.pdf')`. The assertions are unchanged (they check tier/distance/matchedFile of *pre-seeded* records, not the new doc's own name).

- [ ] **Step 6: Verify tests + typecheck**

Run: `npx vitest run test/ingest-nearDup.test.ts && npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/nearDup.ts src/worker/index.ts test/ingest-nearDup.test.ts
git commit -m "fix(near-dup): record the document's originalFileName so matched-file logging works"
```

---

### Task 5: Neutralize control chars in YAML frontmatter (F8) — IN-SCOPE, P2

**Why:** `escapeYamlString` escapes only `\` and `"`. A model-produced `thema`/`lernfeld` with a raw newline/tab breaks the double-quoted YAML scalar and fails the pandoc render for that job. Model output is untrusted everywhere else (`escapeForPandoc`, `sanitizePathSegment`); this closes the frontmatter gap.

**Files:** Modify `src/pdf/buildMarkdown.ts:5-7`; add a test to `test/pdf/buildMarkdown.test.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/pdf/buildMarkdown.test.ts`, reusing the file's existing `makeResult()` factory (Phase-3 reviewer nice-to-have #3 — typed and consistent with the rest of the file):

```ts
  it('neutralizes control characters in frontmatter fields so the YAML scalar stays on one line', () => {
    const md = buildSolutionMarkdown(makeResult({ thema: 'Bruch\nrechnung\tteil' }), '2026-07-23');
    const frontmatter = md.slice(0, md.indexOf('\n---', 3) + 4);
    expect(frontmatter).not.toMatch(/thema: "[^"]*[\n\t]/);
    expect(frontmatter).toContain('thema: "Bruch rechnung teil – Lösungen"');
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/pdf/buildMarkdown.test.ts -t "neutralizes control characters"`
Expected: FAIL — raw newline/tab present in the `thema` frontmatter line.

- [ ] **Step 3: Strip control chars before escaping**

In `src/pdf/buildMarkdown.ts`:

```ts
function escapeYamlString(text: string): string {
  return text
    // Collapse C0 control chars to spaces first: a raw newline breaks the single-line double-quoted
    // YAML scalar these values are interpolated into. IMPLEMENT THE NEXT LINE AS THE ESCAPED RANGE
    // FORM `.replace(/[\x00-\x1F]/g, ' ')` (NOT literal control bytes) — reviewer note #1. The line
    // below may render mangled in this doc due to byte-flattening; the escaped form is authoritative.
    .replace(/[ -]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run test/pdf/buildMarkdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/buildMarkdown.ts test/pdf/buildMarkdown.test.ts
git commit -m "fix(pdf): neutralize control chars in YAML frontmatter fields"
```

---

### Task 6: Raise subprocess `maxBuffer` (F4) — IN-SCOPE, P2 (sequenced last)

**Why:** `defaultExecFile` uses Node's default 1 MiB `maxBuffer`. `convertToMarkdown` (`src/extract/markitdown.ts`) and `renderSolutionPdf` have no fallback, so >1 MiB tool output throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and fails the job. (`getAllPagesText` and `getPagesWithContentImages` already fail open, so they're unaffected — narrower blast radius than the raw findings implied.) Raising the ceiling fixes all callers uniformly. Low-risk behavior change; the test spawns a real subprocess (deterministic, not flaky).

**Files:** Modify `src/lib/execFile.ts`; add `test/lib/execFile.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/lib/execFile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { defaultExecFile } from '../../src/lib/execFile.js';

describe('defaultExecFile', () => {
  it('captures stdout larger than the default 1 MiB maxBuffer without throwing', async () => {
    const bytes = 2 * 1024 * 1024; // 2 MiB, exceeds Node's 1 MiB default
    const { stdout } = await defaultExecFile(process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`]);
    expect(stdout.length).toBe(bytes);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/lib/execFile.test.ts`
Expected: FAIL — rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` ("stdout maxBuffer length exceeded").

- [ ] **Step 3: Raise the ceiling**

Rewrite `src/lib/execFile.ts`:

```ts
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFileCallback);

// Node's default child-process stdout/stderr cap is 1 MiB; MarkItDown / pandoc / pdftotext
// output for a long worksheet can exceed that, and an overflow throws
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER and fails the whole job. Raise the ceiling so large-but-
// legitimate tool output is captured instead of turning into a hard failure.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export const defaultExecFile: ExecFileFn = (file, args) =>
  execFileAsync(file, args as string[], { maxBuffer: MAX_BUFFER_BYTES });
```

- [ ] **Step 4: Verify test + typecheck + full suite**

Run: `npx vitest run test/lib/execFile.test.ts && npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execFile.ts test/lib/execFile.test.ts
git commit -m "fix(exec): raise child-process maxBuffer to 64 MiB to avoid failing jobs on large tool output"
```

---

## Final verification (Phase 5)

- [ ] Run `npm run typecheck && npm run lint && npm test`; capture real output. All three must be green (typecheck exit 0; lint 0 errors / 0 warnings; test 158/158 passing).
- [ ] Run `/security-review` on the actual diff of this branch vs. `main`; fold any real findings in (or record none).

---

## DEFERRED follow-ups (NOT implemented this run)

Recorded for a future pass; each is either risky, larger, or needs data/infra this run can't provide.

- **B1 — Near-dup signature recorded before solve, no BullMQ retry guard.** `src/worker/index.ts:68` records the signature, then solves at `:81`. Jobs are enqueued with no `attempts` (`src/ingest/watcher.ts:50`; BullMQ default = 1 = no retry), so it's safe *today*. But if anyone sets `attempts > 1`, a job failing after `:68` will, on retry, match its own freshly-stored signature (distance 0) and be silently skipped — never solved. Fix later: move the `hset` to after a successful solve, or add an explicit comment/guard. DEFERRED (behavior change touching worker ordering; no live bug forcing it now).
- **B2 — `FACH_SUBPATH[result.fach]` unguarded lookup.** `src/nextcloud/writeResult.ts:30`. Defensive-only: `validateShapePass1` constrains `fach` to `FACH_KEYS`, but a value slipping through would throw a cryptic `Cannot read 'split' of undefined`. DEFERRED (harden with a clear error later).
- **B3 — `stripJsonFence` requires a newline before the closing fence.** `src/agy/index.ts:11`. A model emitting ```` ```json\n{…}``` ```` with no trailing newline isn't stripped and fails JSON parse (which then falls back to the Claude path). Narrow model-output edge case. DEFERRED.
- **Unbounded Redis growth** (`dedup.ts` set, `nearDup.ts` hash) — documented accepted risk in the near-dup design spec. DEFERRED.
- **OCR-quality dictionary-ratio threshold (0.45)** — README "Known open item"; needs real scanned-homework data to tune. DEFERRED.
- **Nextcloud config migration** (`NEXTCLOUD_DATA_DIR` → WebDAV vars) — documented breaking change / migration note, not a bug. No action.
- **agy install + credential-mount E2E** (`docker/Dockerfile`, `docker-compose.yml`) — explicitly UNVERIFIED by design; needs a real Docker host. No action.

## Reviewer contributions folded into this plan

- **Claude reviewer:** downgraded F3 P1→P2 (empty `matchedFile` never changes a tier decision, only log observability); narrowed F4's blast radius (`getPagesWithContentImages` already fails open) and flagged its test as the awkward part → resolved with a deterministic real-subprocess test; corrected `eslint.config.mjs`→`.js`; noted the 5 warnings don't fail lint (only the 3 errors do); surfaced deferred B1/B2/B3.
- **agy/Gemini reviewer:** independently confirmed F1's "config side is wrong" conclusion and all F2–F8 verdicts; argued F8 P3→P2 (control chars break the pandoc render, not merely cosmetic) — adopted; confirmed the missing record→match test gap for F3.

## Plan-review outcomes (Phase 3)

The plan itself was reviewed by a fresh Claude subagent (full-repo verification) and an agy/Gemini reviewer (text-only snippet check, after the read-only project-access mode was auto-denied in headless mode).

- **Claude plan reviewer — verdict: NO BLOCKING ISSUES.** Confirmed every task compiles, each test is genuine fail-first and deterministic, and Task 4's callsite enumeration is complete (8 test calls + 1 worker call; `test/worker.test.ts`'s `vi.fn()` mock is untyped so the arity change causes no `tsc` error). Raised 3 non-blocking nice-to-haves — **all adopted**: (1) implement the F8 regex as the escaped range `/[\x00-\x1F]/g`, not literal control bytes; (2) trim the stale `required()` reference in the `optional()` comment when removing the helper; (3) use the existing `makeResult()` factory in the F8 test.
- **agy/Gemini plan reviewer — two "BUG" claims, both verified against the repo and REJECTED** (receiving-code-review rigor):
  - *Task 4 "make the param optional / worker-test mock assertions break":* rejected. The only production caller is the worker, which always has `originalFileName`; a required param is safer and all callsites are updated. Verified `test/worker.test.ts` never asserts `checkNearDuplicate`'s call args (only `mockResolvedValue`), so nothing breaks at runtime or compile time.
  - *Task 5 "missing `/g` flag / escaping-order double-escape":* rejected as a misread. The regex has `/g`; and control chars are replaced with a **space** (not an escape sequence), so no backslashes are introduced and the strip-then-escape order is correct. (agy's only useful nudge — also covering DEL/C1/line-separator chars — noted as optional; C0 covers the real `\n`/`\r`/`\t` risk.)

**Plan is APPROVED for implementation.**
