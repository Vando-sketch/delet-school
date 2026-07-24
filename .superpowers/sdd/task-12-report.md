# Task 12: Claude solve step rewrite — Report

## What I implemented

Full rewrite of `src/claude/processFile.ts` per the brief's exact code (Step 3), and a
full rewrite of `test/processFile.test.ts` per the brief's exact code (Step 1), with two
narrowly-scoped, necessary deviations described below.

`createFileProcessor(options?: { queryFn?: QueryFn; readImageFile?: ReadImageFileFn })`
now returns a `FileProcessor` whose `processFile(fileName: string, extraction:
ExtractionResult): Promise<ProcessedFileResult>`:

- Builds a German system prompt describing the Materialblatt-vs-Aufgabenblatt
  classification task and the fixed `Fach` enum.
- Builds a JSON schema (`outputFormat: { type: 'json_schema', schema: ... }`) whose
  `fach` property is `{ type: 'string', enum: [...FACH_KEYS] }` — a structural guardrail,
  not just a description string.
- When `extraction.visionPages` is empty, `prompt` is a plain string embedding the
  extracted markdown.
- When `extraction.visionPages` is non-empty, `prompt` is an `AsyncGenerator<SDKUserMessage>`
  (`buildVisionPrompt`) that reads each vision page's image file (via the injectable
  `readImageFile`, defaulting to `fs.readFile`), base64-encodes it, and yields exactly one
  `SDKUserMessage` whose `message.content` is `[textBlock, ...imageBlocks]`.
- Validates the parsed/structured JSON shape by hand (`validateShape`), throwing
  descriptive errors for missing/invalid fields, non-success SDK result subtypes, or no
  result message at all.

## What I tested and test results

Ran the brief's 8 test cases in `test/processFile.test.ts`:
1. well-formed SDK response → correctly parsed `ProcessedFileResult`
2. `model=claude-sonnet-5` passed to the SDK by default
3. plain-string prompt (containing the markdown) when no vision pages
4. async-iterable prompt with `['text','image']` content blocks when vision pages present
5. missing-field JSON → throws `/isMaterialblatt/`
6. non-success SDK result subtype → throws `/Claude query failed/`
7. no result message at all → throws `/received no result/`
8. Materialblatt (`isMaterialblatt: true`) → empty `tasksFound`

All 8 pass. Full suite (`npm test`): **13 test files, 53 tests, all passing.**

## TDD Evidence

### RED

Command: `npm test -- test/processFile.test.ts` (test file rewritten, `processFile.ts` still
the old "find open tasks" extractor)

```
 FAIL  test/processFile.test.ts > createFileProcessor > includes the extracted markdown in a plain string prompt when there are no vision pages
TypeError: The "path" argument must be of type string. Received undefined
 ❯ isPlainTextFile src/claude/processFile.ts:40:15
...
 Test Files  1 failed (1)
      Tests  8 failed (8)
```
All 8 tests failed (old `processFile(file: DownloadedFile)` signature incompatible with the
new `processFile(fileName, extraction)` calls; `extname(file.fileName)` threw because
`file` was actually the new `fileName` string argument).

### GREEN

Command: `npm test -- test/processFile.test.ts` (after rewriting `processFile.ts`)

```
 ✓ test/processFile.test.ts (8 tests) 7ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

## Files changed

- `src/claude/processFile.ts` — full rewrite (verbatim per brief Step 3)
- `test/processFile.test.ts` — full rewrite (per brief Step 1, with one line changed — see below)
- `src/config/index.ts` — one-line fix to `optional()`, required to make test #2 pass (see below)

## Vision-prompt typing (the flagged risk)

**No adjustment needed.** `buildVisionPrompt`'s hand-built `ImageBlockParam`/`TextBlockParam`-shaped
object literals compiled against the installed `@anthropic-ai/sdk` types with zero errors,
exactly as written in the brief. I independently verified the type defs before compiling
(`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`):
- `ImageBlockParam { source: Base64ImageSource | URLImageSource; type: 'image'; cache_control?: ... }`
- `Base64ImageSource { data: string; media_type: 'image/jpeg'|'image/png'|...; type: 'base64' }`
- `TextBlockParam { text: string; type: 'text'; cache_control?: ...; citations?: ... }`

All fields beyond what the brief's literals populate are optional, so the object literals
structurally satisfy `MessageParam.content: string | Array<ContentBlockParam>`. `tsc --noEmit`
confirms: zero errors anywhere touching `buildVisionPrompt`.

## Two deviations from the brief's literal code (both required to compile/pass, both minimal)

1. **`test/processFile.test.ts`, "passes model=claude-sonnet-5 to the SDK by default" test**:
   the brief's `fakeQuery` declares `params: { prompt: string; options?: { model?: string } }`.
   Under this repo's `strict: true` (`strictFunctionTypes`), a function typed to accept only
   `prompt: string` is not assignable to `QueryFn` (`prompt: string | AsyncIterable<SDKUserMessage>`)
   — TypeScript correctly rejects the narrower parameter type in a contravariant position
   (`TS2322`). The brief's *other* three `fakeQuery` declarations in the same file already
   type `prompt: unknown` for exactly this reason, so I made this one consistent with them:
   ```diff
   - async function* fakeQuery(params: { prompt: string; options?: { model?: string } })
   + async function* fakeQuery(params: { prompt: unknown; options?: { model?: string } })
   ```
   This doesn't touch runtime behavior or test intent (the test only reads `options.model`).

2. **`src/config/index.ts`, `optional()` helper**: the repo's checked-in `.env` (stale — it
   still has commented defaults from before the watched-folder pipeline rewrite, e.g.
   references "claude-haiku-4-5-20251001") sets `ANTHROPIC_MODEL=` (present, blank). dotenv
   loads it via `config/index.ts`'s `import 'dotenv/config'`, and the old `optional()`:
   ```ts
   function optional(name: string, fallback: string): string {
     return process.env[name] ?? fallback;
   }
   ```
   uses `??`, which does **not** treat `''` as unset — so `config.anthropic.model` silently
   resolved to `''` instead of the documented `'claude-sonnet-5'` default, failing the
   brief's test #2 verbatim (`expected '' to be 'claude-sonnet-5'`). This is inconsistent
   with `required()` in the same file, which already correctly treats blank values as
   missing (`if (!value) throw`). I fixed `optional()` to match:
   ```ts
   function optional(name: string, fallback: string): string {
     const value = process.env[name];
     return value ? value : fallback;
   }
   ```
   This is a genuine latent bug (not something introduced by this task) that would also
   silently break `ANTHROPIC_MODEL`, `NEXTCLOUD_OCC_BIN`, `OCR_LANGUAGES`, etc. in real
   deployments if left blank in `.env`. Committed separately as its own `fix:` commit ahead
   of the `feat:` commit, per this repo's conventional-commit-per-concern workflow. I did
   *not* touch `.env`'s contents — the fix is in the loader, not the environment file.
   Confirmed no regression: `test/config.test.ts`'s existing "defaults ANTHROPIC_MODEL to
   claude-sonnet-5" test (which works around this via `delete process.env.ANTHROPIC_MODEL`
   + `vi.resetModules()`) still passes.

## `npm run typecheck` output (full, unedited)

```
src/nextcloud/writeResult.ts(70,46): error TS2339: Property 'summaryMarkdown' does not exist on type 'ProcessedFileResult'.
src/worker/index.ts(10,15): error TS2305: Module '"../types.js"' has no exported member 'DownloadedFile'.
src/worker/index.ts(47,40): error TS2554: Expected 2 arguments, but got 1.
src/worker/index.ts(48,51): error TS2554: Expected 3 arguments, but got 2.
test/nextcloudWriter.test.ts(6,15): error TS2305: Module '"../src/types.js"' has no exported member 'DownloadedFile'.
test/nextcloudWriter.test.ts(19,18): error TS2741: Property 'title' is missing in type '{ taskDescription: string; proposedSolution: string; }' but required in type 'TaskSolution'.
test/nextcloudWriter.test.ts(46,42): error TS2554: Expected 3 arguments, but got 2.
test/nextcloudWriter.test.ts(52,33): error TS2339: Property 'summaryMarkdown' does not exist on type 'ProcessedFileResult'.
test/nextcloudWriter.test.ts(59,42): error TS2554: Expected 3 arguments, but got 2.
test/nextcloudWriter.test.ts(63,33): error TS2339: Property 'summaryMarkdown' does not exist on type 'ProcessedFileResult'.
test/nextcloudWriter.test.ts(70,42): error TS2554: Expected 3 arguments, but got 2.
test/nextcloudWriter.test.ts(89,42): error TS2554: Expected 3 arguments, but got 2.
test/nextcloudWriter.test.ts(105,42): error TS2554: Expected 3 arguments, but got 2.
test/nextcloudWriter.test.ts(111,33): error TS2339: Property 'summaryMarkdown' does not exist on type 'ProcessedFileResult'.
test/nextcloudWriter.test.ts(125,18): error TS2554: Expected 3 arguments, but got 2.
```

Zero errors in `src/claude/processFile.ts` or `test/processFile.test.ts`. All remaining
errors are in `src/worker/index.ts`, `src/nextcloud/writeResult.ts`, and
`test/nextcloudWriter.test.ts` — exactly the files flagged as out of scope (still using the
pre-Task-2 `DownloadedFile`/`summaryMarkdown` shapes; presumably Task 13/14's job).

## Self-review

- `createFileProcessor` accepts optional `queryFn` and optional `readImageFile` — yes,
  `CreateFileProcessorOptions { queryFn?: QueryFn; readImageFile?: ReadImageFileFn }`.
- `processFile` takes `(fileName: string, extraction: ExtractionResult)` — yes.
- `fach` constrained via `enum: [...FACH_KEYS]` in the actual JSON schema object (not just a
  description string) — yes, confirmed at `RESULT_JSON_SCHEMA.properties.fach.enum`.
- Empty `visionPages` → `prompt` stays a plain string — yes, confirmed by test #3 and code
  path (`extraction.visionPages.length > 0 ? buildVisionPrompt(...) : promptText`).
- Non-empty `visionPages` → async generator yields exactly one `SDKUserMessage` with
  `[text, ...images]` content — yes, confirmed by test #4 (`blockTypes` = `['text', 'image']`,
  `messages` has length 1).
- `npm run typecheck` passes with zero errors in the two in-scope files — confirmed, full
  output above.

## Issues or concerns

- Two files needed touching beyond the brief's stated file list: one line in
  `test/processFile.test.ts` (contravariant parameter typing, made consistent with the
  brief's own pattern elsewhere in the same file) and one function in `src/config/index.ts`
  (a genuine, independently-verifiable `optional()` bug, not introduced by this task, but
  which blocks the brief's literal test #2 from passing under the current `.env`). Both are
  minimal, justified, and documented above and in their commit messages. No `as any` or
  type-widening escape hatch was used anywhere.
- `src/worker/index.ts` and `src/nextcloud/writeResult.ts` (plus their tests) are now
  further out of sync with the new `ProcessedFileResult`/`ExtractionResult` shapes (they
  still reference `DownloadedFile` and `summaryMarkdown`) — expected, and presumably the
  subject of a later task (worker/writeResult wiring), not touched here.
