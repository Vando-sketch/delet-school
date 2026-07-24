# Gemini (via agy) Integration Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Google Gemini via the `agy` CLI subprocess as the primary LLM provider for document classification (Pass 1) and task solving (Pass 2), falling back to the existing Claude Agent SDK implementation on classified failures.

**Architecture:** 
- `src/config/index.ts` and `.env.example`: Add configuration settings for `PASS1_MODEL`, `PASS1_EFFORT`, `PASS2_MODEL`, `PASS2_EFFORT`, `AGY_PRINT_TIMEOUT`, and `AGY_BIN`.
- `src/agy/index.ts`: Export `runAgyPass` function, subprocess execution runner with `AgySubprocessRunner` injection, child process lifecycle management with `AbortController` / timers (SIGTERM + SIGKILL grace period), and JSON fence extraction.
- `src/claude/processFile.ts`: Integrate `runAgyPass` before each pass (Pass 1 & Pass 2). If Gemini execution succeeds and produces valid schema-compliant JSON, return the result. If Gemini fails (non-zero exit code, empty stdout, JSON parse error, or schema validation failure), fall back to the existing Claude Agent SDK path.
- `test/agy.test.ts` & `test/processFile.test.ts`: Test subprocess execution, timeout/kill lifecycle, markdown fence stripping, Gemini success paths, vision page handling, classified fallback to Claude, and total failure cases.

## Global Constraints

- Do NOT touch `docker/Dockerfile`, `docker-compose.yml`, or anything under `docker/`.
- Do NOT modify `src/worker/index.ts` or change `FileProcessor`/`ProcessedFileResult` public interface.
- Do NOT change Claude Agent SDK defaults, prompts, or schemas in the fallback path.
- Default `PASS1_MODEL`: `gemini-3.6-flash`, `PASS1_EFFORT`: `medium`.
- Default `PASS2_MODEL`: `gemini-3.1-pro`, `PASS2_EFFORT`: `high`.
- Default `AGY_PRINT_TIMEOUT`: `5m`, `AGY_BIN`: `agy`.
- Follow established dependency injection patterns (`CreateFileProcessorOptions`).

---

### Task 1: Add configuration for `agy`

**Files:**
- Modify: `src/config/index.ts`
- Modify: `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `config.agy` object containing `pass1Model`, `pass1Effort`, `pass2Model`, `pass2Effort`, `printTimeout`, and `binary`.

- [ ] **Step 1: Write failing config tests**

Add tests to `test/config.test.ts` verifying `config.agy` default values.

```typescript
describe('config.agy', () => {
  it('provides default values for agy configuration', () => {
    expect(config.agy.pass1Model).toBe('gemini-3.6-flash');
    expect(config.agy.pass1Effort).toBe('medium');
    expect(config.agy.pass2Model).toBe('gemini-3.1-pro');
    expect(config.agy.pass2Effort).toBe('high');
    expect(config.agy.printTimeout).toBe('5m');
    expect(config.agy.binary).toBe('agy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (`config.agy` is undefined)

- [ ] **Step 3: Update `src/config/index.ts` and `.env.example`**

Add `agy` config section in `src/config/index.ts`:

```typescript
export const config = {
  // ... existing sections
  agy: {
    pass1Model: optional('PASS1_MODEL', 'gemini-3.6-flash'),
    pass1Effort: optional('PASS1_EFFORT', 'medium'),
    pass2Model: optional('PASS2_MODEL', 'gemini-3.1-pro'),
    pass2Effort: optional('PASS2_EFFORT', 'high'),
    printTimeout: optional('AGY_PRINT_TIMEOUT', '5m'),
    binary: optional('AGY_BIN', 'agy'),
  },
};
```

Update `.env.example` with comments and default environment variable keys under `# Gemini (agy)` section.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts .env.example test/config.test.ts
git commit -m "feat(config): add agy configuration options"
```

---

### Task 2: Implement `src/agy/index.ts` module & tests

**Files:**
- Create: `src/agy/index.ts`
- Create: `test/agy.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type AgySubprocessRunner = (
    command: string,
    args: string[],
    options?: { timeoutMs?: number }
  ) => Promise<{ stdout: string; exitCode: number }>;

  export function stripJsonFence(text: string): string;
  export function parseDurationToMs(durationStr: string): number;
  export function defaultSubprocessRunner(
    command: string,
    args: string[],
    options?: { timeoutMs?: number }
  ): Promise<{ stdout: string; exitCode: number }>;
  ```

- [ ] **Step 1: Write failing tests in `test/agy.test.ts`**

Write tests for `stripJsonFence`, `parseDurationToMs`, and `defaultSubprocessRunner` (mocking or testing process kill behavior).

```typescript
import { describe, expect, it } from 'vitest';
import { stripJsonFence, parseDurationToMs } from '../src/agy/index.js';

describe('stripJsonFence', () => {
  it('strips ```json ... ``` code fence', () => {
    const input = '```json\n{"hello": "world"}\n```';
    expect(stripJsonFence(input)).toBe('{"hello": "world"}');
  });

  it('passes unfenced JSON through as-is', () => {
    const input = '{"hello": "world"}';
    expect(stripJsonFence(input)).toBe('{"hello": "world"}');
  });
});

describe('parseDurationToMs', () => {
  it('parses duration strings correctly', () => {
    expect(parseDurationToMs('5m')).toBe(300000);
    expect(parseDurationToMs('30s')).toBe(30000);
    expect(parseDurationToMs('1h')).toBe(3600000);
    expect(parseDurationToMs('500')).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agy.test.ts`
Expected: FAIL (module `src/agy/index.js` not found)

- [ ] **Step 3: Implement `src/agy/index.ts`**

Implement helper functions and `defaultSubprocessRunner` using `node:child_process` `spawn`. Enforce process lifecycle:
- Listen to spawn errors / completion.
- If `timeoutMs` expires, send `SIGTERM` to child process.
- Set a short grace timer (e.g. 2000ms); if child hasn't exited, send `SIGKILL`.

```typescript
import { spawn } from 'node:child_process';

export type AgySubprocessRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<{ stdout: string; exitCode: number }>;

export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (match && match[1] !== undefined) {
    return match[1].trim();
  }
  return trimmed;
}

export function parseDurationToMs(durationStr: string): number {
  const trimmed = durationStr.trim();
  const unitMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  if (!unitMatch) return 300000; // default 5m
  const num = parseFloat(unitMatch[1]);
  const unit = (unitMatch[2] || 'ms').toLowerCase();
  switch (unit) {
    case 's':
    case 'sec':
    case 'seconds':
      return Math.round(num * 1000);
    case 'm':
    case 'min':
    case 'minutes':
      return Math.round(num * 60 * 1000);
    case 'h':
    case 'hour':
    case 'hours':
      return Math.round(num * 3600 * 1000);
    case 'ms':
    default:
      return Math.round(num);
  }
}

export const defaultSubprocessRunner: AgySubprocessRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let sigkillTimer: NodeJS.Timeout | undefined;

    const timeoutMs = options?.timeoutMs;
    let timeoutTimer: NodeJS.Timeout | undefined;

    if (timeoutMs && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000);
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (killedByTimeout) {
        resolve({ stdout: '', exitCode: 124 }); // 124 timeout exit code
      } else {
        resolve({ stdout, exitCode: code ?? 1 });
      }
    });
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agy/index.ts test/agy.test.ts
git commit -m "feat(agy): implement agy subprocess runner and stdout parsing"
```

---

### Task 3: Modify `src/claude/processFile.ts` to add Gemini (agy) primary with classified Claude fallback

**Files:**
- Modify: `src/claude/processFile.ts`
- Test: `test/processFile.test.ts`

**Interfaces:**
- Updates `CreateFileProcessorOptions` to accept optional `agyRunner?: AgySubprocessRunner`.
- `processFile` attempts Gemini primary pass (Pass 1 & Pass 2) via `agyRunner`.
- On classified failure (non-zero exit code, empty stdout, JSON syntax error, or shape validation failure), logs warning and falls back to Claude Agent SDK.

- [ ] **Step 1: Write failing test in `test/processFile.test.ts` for Gemini primary & fallback**

Extend `test/processFile.test.ts` to test:
- agy success (Claude queryFn not called)
- agy failure (non-zero exit code) -> Claude fallback called and succeeds
- agy malformed JSON -> Claude fallback called and succeeds
- both agy and Claude fail -> throws error
- vision pages -> agy receives `--add-dir` and `--mode plan`

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/processFile.test.ts`
Expected: FAIL

- [ ] **Step 3: Modify `src/claude/processFile.ts`**

Update `CreateFileProcessorOptions`:
```typescript
import { config } from '../config/index.js';
import { defaultSubprocessRunner, parseDurationToMs, stripJsonFence, type AgySubprocessRunner } from '../agy/index.js';

export interface CreateFileProcessorOptions {
  queryFn?: QueryFn;
  readImageFile?: ReadImageFileFn;
  agyRunner?: AgySubprocessRunner;
}
```

Implement `runAgyPass`:
- Build prompt text.
- If `extraction.visionPages.length > 0`, append image file path note: `\n\nBilder der Seiten: ${extraction.visionPages.map(p => `Seite ${p.pageNumber}: ${p.imagePath}`).join(', ')}. Bitte schaue dir diese Bild-Dateien an.`
- Build `agy` command args:
  ```typescript
  const args = [
    '-p',
    promptText,
    '--model',
    model,
    '--effort',
    effort,
    '--print-timeout',
    config.agy.printTimeout,
  ];
  if (extraction.visionPages.length > 0) {
    const workDir = path.dirname(extraction.visionPages[0].imagePath);
    args.push('--add-dir', workDir, '--mode', 'plan');
  }
  ```
- Run `agyRunner(config.agy.binary, args, { timeoutMs: parseDurationToMs(config.agy.printTimeout) + 5000 })`.
- Validate exit code === 0 and stdout is non-empty.
- Run `stripJsonFence(stdout)` -> `parseModelJson` -> `validateShapePass1` / `validateShapePass2`.
- Wrap in try/catch to classify failures and trigger Claude fallback.

- [ ] **Step 4: Run tests to verify all tests pass**

Run: `npx vitest run test/processFile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/claude/processFile.ts test/processFile.test.ts
git commit -m "feat(processFile): add Gemini primary path with classified Claude fallback"
```

---

### Task 4: Full Verification and Cleanup

**Files:**
- All touched files

- [ ] **Step 1: Run typecheck**
Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run linter**
Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Run all tests**
Run: `npm test`
Expected: PASS (100% tests passing)

- [ ] **Step 4: Verify git status and commit final changes**
Verify branch `feat/gemini-agy-integration-core` is clean and ready.
