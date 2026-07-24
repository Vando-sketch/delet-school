# Gemini (via agy) as primary LLM provider, Claude Agent SDK as fallback

Date: 2026-07-24
Status: Approved, ready for implementation planning

## Context

`src/claude/processFile.ts` runs two LLM passes per ingested homework file (see
`2026-07-23-efficiency-improvements-design.md`): a cheap/fast classification pass and,
only when tasks are found, a deeper solving pass. Both passes currently go through
`@anthropic-ai/claude-agent-sdk`'s `query()`, authenticated either via `ANTHROPIC_API_KEY`
or a Claude Pro/Max subscription login (`claude login`) — no metered API credits are
required today.

The user wants to add Google Gemini as a second provider. The driving requirement,
established after several false starts in brainstorming, is **billing model, not
architecture**: Gemini usage must run against an existing subscription
(Google/Antigravity account entitlement), never metered per-token API credits. This
rules out the obvious "just add `@google/genai` with a `GEMINI_API_KEY`" approach —
that SDK only supports API-key billing. The only tool available that authenticates
Gemini against a subscription instead of a metered key is `agy` (Google's Antigravity
CLI, already used interactively by the user for development-workflow delegation via the
`delegating-to-agy` skill).

A cross-model review (via `agy` itself, `gemini-3.1-pro`) was run against an earlier
draft of this design (full SDK replacement) and raised valid concerns: no documented
headless auth for `agy`, subprocess fragility (zombie processes, stdout parsing, no
native JSON-schema mode), and retrying on any failure without classification. Those
concerns shaped the design below: Claude's existing, proven, already-subscription-billed
code path is kept completely unchanged and demoted to "fallback" rather than replaced,
so none of `agy`'s subprocess risk is introduced into the one path that already works.

## Goal

Both passes try Gemini (via `agy`) first. If that fails in a well-defined way, they fall
back to exactly the Claude call that runs today. Both providers are subscription-billed;
no API credits are consumed by either path in normal operation.

## Architecture

```
processFile(fileName, extraction, siblings)
  │
  ├─ Pass 1 (classification)
  │    primary:  agy subprocess, model=gemini-3.6-flash, effort=medium
  │    fallback: existing Claude Agent SDK call, model=claude-3-5-haiku-latest (unchanged)
  │
  ├─ (if isMaterialblatt) → return early, same as today
  │
  └─ Pass 2 (solving)
       primary:  agy subprocess, model=gemini-3.1-pro, effort=high
       fallback: existing Claude Agent SDK call, model=config.anthropic.model (unchanged)
```

- The existing `QueryFn`-based Claude call in `processFile.ts` is not modified. It is
  invoked as the fallback function for both passes, unchanged in behavior, model
  defaults, or vision handling.
- A new `src/agy/` module owns the Gemini path: building the `agy` invocation, running
  it as a subprocess, and extracting/validating JSON from its stdout.
- `processFile.ts` gains a small dispatcher per pass: try the agy call; on a *classified*
  failure, log a warning and call the existing Claude function; on success from either,
  proceed as today. Both attempts feed the same `parseModelJson` /
  `validateShapePass1`/`validateShapePass2` functions already in `processFile.ts` — a
  provider is just another source of raw JSON text to validate.

### `agy` invocation

Non-interactive print mode, one call per pass per file:

```
agy -p "<prompt>" --model <gemini-3.6-flash|gemini-3.1-pro> --effort <medium|high> \
    --print-timeout <duration> [--add-dir <workDir> --mode plan]
```

- Prompt text includes the same content built by today's `buildPromptText`, plus an
  explicit instruction to respond with only the JSON schema (described in prose, since
  `agy` has no native `outputFormat`/`json_schema` mode) — no markdown fences, no
  commentary.
- `--add-dir <workDir> --mode plan` (read-only project access) is only added when
  `extraction.visionPages.length > 0`, with the prompt referencing each page image's
  file path and asking the model to view it. This is the one part of the Gemini path
  that hasn't been validated to work reliably — if it doesn't, the classified-failure
  fallback routes to Claude's proven native vision handling instead, so a shaky Gemini
  vision path degrades gracefully rather than breaking the pipeline. A specific risk to
  check during that validation: in non-interactive `-p` mode, a tool-permission prompt
  for the file-read (rather than an auto-approval under `--mode plan`) could hang the
  call instead of erroring — if so, `AGY_PRINT_TIMEOUT` is the only backstop, and the
  spike should confirm the timeout reliably triggers the fallback rather than leaving
  the job stuck for the full timeout duration on every vision-fallback file.
- Stdout is stripped of a wrapping ```` ```json ... ``` ```` fence if present, then
  handed to the same `parseModelJson`/shape-validation functions the Claude path uses.

### Failure classification (what triggers fallback)

A single fallback attempt (no further retries) is triggered only by:
- non-zero `agy` exit code,
- empty stdout, or
- `parseModelJson`/`validateShapePass1`/`validateShapePass2` throwing on the extracted text.

Anything else (a successfully parsed, schema-valid response) is accepted as-is, even if
its content quality is debatable — that's a modeling problem, not a failure to recover
from. This avoids the "retry on everything" thundering-herd risk flagged in review:
under `WORKER_CONCURRENCY` > 1, only genuinely broken calls double up, not every
mediocre-but-valid response.

## Config changes (`src/config/index.ts`, `.env.example`)

New `agy` section:
- `PASS1_MODEL` (default `gemini-3.6-flash`), `PASS1_EFFORT` (default `medium`)
- `PASS2_MODEL` (default `gemini-3.1-pro`), `PASS2_EFFORT` (default `high`)
- `AGY_PRINT_TIMEOUT` (default e.g. `5m`)
- `AGY_BIN` (default `agy`), following the existing `optional()` pattern used for other
  binaries (`PDFTOTEXT_BIN`, `OCRMYPDF_BIN`, etc.)

No changes to `config.anthropic.*` — the Claude fallback path's config is untouched.

## Infra changes (`docker/Dockerfile`, `docker-compose.yml`)

- Install the `agy` binary in the worker image.
- **Auth (the one open risk to spike first, before the rest of this plan is built):**
  `agy`'s local auth is tied to an interactive Antigravity/Google account login, with
  state under `~/.gemini/antigravity/`. The proposed approach mirrors the existing
  Tailscale pattern in this repo — authenticate once, interactively, outside the
  container, then mount the resulting credential state into the worker container as a
  Docker volume (same shape as the existing `tailscale-state` volume), rather than
  attempting OAuth inside a headless container. This needs to be verified to actually
  work before the rest of the implementation depends on it, specifically:
  - **OS portability**: the credential state may be bound to macOS Keychain or other
    host-specific paths rather than being a portable flat file — if so, it will not
    work unmodified when mounted into the Linux-based worker container, and an
    alternative export/import mechanism (if `agy`/Antigravity offers one) would be
    needed instead of a raw volume mount.
  - **Unattended token refresh**: OAuth access tokens are typically short-lived (on the
    order of an hour); the mounted refresh token must be usable by `agy` to silently
    re-mint an access token inside the container, with no browser or local OAuth
    callback server available to complete an interactive re-auth.
  If neither holds up, this design's `agy` primary path is not viable as specified and
  needs to be revisited.

## Error handling

- Both passes: classified fallback as described above. If the fallback (Claude) call
  also fails, behavior is identical to today — the job fails, archives to `.failed/`,
  same as the existing error path in `src/worker/index.ts`.
- `agy` subprocess spawn failures (binary missing, timeout exceeded) are treated as a
  fallback trigger, same as a non-zero exit code.
- No cross-pass fallback (e.g. Pass 1 failing both providers does not affect how Pass 2
  is attempted) — Pass 2 only runs at all if Pass 1 (via whichever provider succeeded)
  returned `isMaterialblatt: false`, same as today.
- **Process lifecycle**: on `AGY_PRINT_TIMEOUT` expiry, the `agy` child process must be
  explicitly killed (SIGTERM, with a SIGKILL follow-up after a short grace period if it
  doesn't exit) rather than left to run in the background after the pipeline has already
  moved on to the fallback — otherwise a timed-out call leaks an orphaned process per
  occurrence. The same applies on worker shutdown: in-flight `agy` child processes need
  to be terminated, not abandoned, when the BullMQ worker stops.

## Testing

- The existing `CreateFileProcessorOptions.queryFn` injection point for the Claude call
  is unchanged and still used to test the fallback path in isolation.
- A new injectable subprocess-runner interface for the `agy` path, e.g.
  `(args: string[]) => Promise<{ stdout: string; exitCode: number }>`, following the same
  dependency-injection pattern, so tests never spawn a real `agy` process.
- Test cases: Gemini success (no fallback invoked), Gemini non-zero exit → Claude
  fallback invoked and used, Gemini malformed JSON → Claude fallback invoked, both
  providers fail → job throws (existing behavior), vision-pages path includes `--add-dir`.

## Out of scope

- No changes to worker concurrency, queue wiring, or archiving logic beyond what's
  described above.
- No UI/config for choosing Claude as primary instead of Gemini — Gemini-primary is the
  fixed default for both passes per this design; provider choice beyond primary/fallback
  order is not exposed as a runtime toggle.
- Cost/latency benchmarking of the two providers is not part of this design — if the
  `agy` auth spike fails or Gemini quality/latency proves unacceptable in practice, that's
  a follow-up decision, not something this spec resolves in advance.
