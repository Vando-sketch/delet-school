# 03 — Autonomous improvement run summary

Branch: `chore/autonomous-improvement-sweep` (off `main`)
Date: 2026-07-25 → 2026-07-26
PR: _(see below)_

## Outcome

Swept the project, had findings + plan independently reviewed twice each (a fresh Claude subagent AND a cross-model agy/Gemini reviewer), implemented the reviewed in-scope subset TDD-first, and verified a fully green build. One PR opened; not merged.

## Baseline vs final (real numbers)

| Check | Baseline (`main`) | Final (this branch) |
|---|---|---|
| `npm run typecheck` | ✅ exit 0 | ✅ exit 0 |
| `npm run lint` | ❌ **3 errors, 5 warnings** | ✅ **0 errors, 0 warnings** |
| `npm test` | ❌ **2 failed / 156 passed** (158 total, 20 files) | ✅ **161 passed** (161 total, 21 files) |

Net test delta: the 2 red tests fixed + 3 new tests added (near-dup record→match, YAML control-char, execFile maxBuffer).

## Changes, file-by-file, grouped by task/finding

### Task 1 — F1 red-build fix (config drift)
- `src/config/index.ts`: restored the two-pass agy defaults — `pass1Model=gemini-3.6-flash`/`medium`, `pass2Model=gemini-3.1-pro`/`high` (were `gemini-3.5-flash`/`low` for both). Fixes the 2 failing tests. **Chosen side: config.** Rationale: the tests (`test/config.test.ts`, `test/processFile.test.ts`) AND `.env.example` all encode the two-pass design; only `src/config/index.ts` drifted (via commit `b6ff6a2`, whose "newer versions" message contradicts its 3.6→3.5 downgrade and flash-collapse). Both independent reviewers reached the same conclusion.

### Task 2 — F2 red-lint fix (`no-explicit-any`)
- `test/processFile.test.ts`: replaced `(PASS2_JSON_SCHEMA as any).properties` with a typed narrowing; dropped two redundant `validateShapePass2(x as any)` casts (the param is already `unknown`). Clears the 3 eslint errors.

### Task 3 — F5/F6/F7 lint hygiene
- `eslint.config.js`: added `caughtErrorsIgnorePattern: '^_'` so intentional `_err`/`_parseErr` catch bindings stop warning.
- `test/ingest-dedup.test.ts`: renamed unused mock arg `key` → `_key`.
- `src/config/index.ts`: removed the dead `required()` helper and trimmed its now-stale mention in the `optional()` comment. Lint is now 0/0.

### Task 4 — F3 near-duplicate filename threading (correctness)
- `src/ingest/nearDup.ts`: `checkNearDuplicate(markdown, originalFileName)` now stores the real filename instead of `''`.
- `src/worker/index.ts`: passes `originalFileName` at the callsite.
- `test/ingest-nearDup.test.ts`: added a record→match test (exercises the real path no prior test covered) and updated the 8 existing callsites.
- Why: the signature store is only ever written by this function, so in production every `matchedFile` the worker logged was empty — the design's "log which file matched" never worked.

### Task 5 — F8 YAML frontmatter control-char neutralization (robustness)
- `src/pdf/buildMarkdown.ts`: `escapeYamlString` collapses C0 control chars (`/[\x00-\x1F]/g`) to spaces before escaping, so a model-authored `thema`/`lernfeld` with a raw newline/tab can't break the single-line double-quoted YAML scalar and fail the pandoc render.
- `test/pdf/buildMarkdown.test.ts`: added a control-char frontmatter test.

### Task 6 — F4 subprocess maxBuffer (robustness)
- `src/lib/execFile.ts`: `defaultExecFile` now sets `maxBuffer: 64 MiB`. Node's 1 MiB default made `convertToMarkdown`/`renderPdf` (which have no fallback) fail a job on large-but-legitimate tool output with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
- `test/lib/execFile.test.ts` (new): deterministic real-subprocess test emitting 2 MiB of stdout.

## Security pass

`/security-review` run against the branch diff: **no HIGH/MEDIUM findings**. The changes are net-neutral to net-positive — the Task 5 control-char strip actually removes a latent YAML-frontmatter-breakout surface. No path/command/query construction added from untrusted input.

## What each reviewer contributed

**Findings review (Phase 2):**
- **Claude subagent:** independently reproduced the baseline; confirmed F1–F8; **downgraded F3 P1→P2** (empty `matchedFile` only degrades log observability, never changes a tier decision); **narrowed F4's blast radius** (`getPagesWithContentImages` already fails open) and flagged its test as the awkward part (→ solved with a deterministic real-subprocess test); corrected the eslint file name (`.js` not `.mjs`); noted the 5 warnings don't fail lint (only the 3 errors do); surfaced 3 new deferred items (B1/B2/B3).
- **agy/Gemini reviewer:** independently confirmed the F1 "config side is wrong" conclusion and all F2–F8 verdicts; argued **F8 P3→P2** (control chars break the pandoc render, not merely cosmetic) — adopted; confirmed the missing record→match test gap for F3.

**Plan review (Phase 3):**
- **Claude subagent:** verdict **no blocking issues** — verified every task compiles, each test is genuine fail-first and deterministic, and Task 4's callsite enumeration is complete (8 test + 1 worker; `worker.test.ts`'s untyped `vi.fn()` mock means the arity change is safe). Contributed 3 adopted nice-to-haves: escaped regex form, trim stale `required()` comment, reuse the `makeResult()` factory.
- **agy/Gemini reviewer:** raised 2 "BUG" claims — both **verified against the repo and rejected** (make-param-optional was ungrounded; the missing-`/g`/escape-order claim was a misread — the regex has `/g` and control chars become spaces, so order is correct).

## DEFERRED follow-ups (not done this run, and why)

- **B1 — near-dup signature recorded before solve + no BullMQ retry guard.** Safe today (jobs enqueue with default `attempts: 1`); becomes a silent-skip trap only if `attempts > 1` is ever set. Deferred: touches worker ordering with no live bug forcing it. Fix later: record after a successful solve, or add a guard/comment.
- **B2 — `FACH_SUBPATH[result.fach]` unguarded lookup** (`src/nextcloud/writeResult.ts`). Defensive-only; `validateShapePass1` already constrains `fach`. Deferred: harden with a clear error later.
- **B3 — `stripJsonFence` requires a newline before the closing fence** (`src/agy/index.ts`). Narrow model-output edge case that merely falls back to the Claude path. Deferred.
- **Unbounded Redis growth** (`dedup.ts` set, `nearDup.ts` hash) — documented accepted risk in the near-dup design spec. Deferred.
- **OCR-quality dictionary-ratio threshold (0.45)** — README "Known open item"; needs real scanned-homework data to tune. Deferred.
- **Nextcloud config migration** (`NEXTCLOUD_DATA_DIR` → WebDAV vars) — documented breaking change / migration note, not a bug. No action.
- **agy install + credential-mount E2E** (`docker/`, `docker-compose.yml`) — explicitly UNVERIFIED by design; needs a real Docker host. No action.
- **Respected intentional design (not touched):** fixed `FACH_KEYS`/`FACH_SUBPATH` routing table; watched-folder + Taildrop ingest instead of a push/Graph API.

## Artifacts
- `docs/findings/01-raw-findings.md` — discovery output + manual security sweep.
- `docs/findings/02-implementation-plan.md` — reviewed, approved plan.
- `docs/findings/03-run-summary.md` — this file.
