# Efficiency Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve throughput via worker concurrency and reduce API costs by splitting the Claude pipeline into a fast classification pass and a deep reasoning pass.

**Architecture:** We will expose a `WORKER_CONCURRENCY` env variable and pass it to BullMQ. We will split the Anthropic SDK call in `processFile.ts` into a Haiku pass for classification, followed by a Sonnet pass for solving tasks (if any exist).

**Tech Stack:** Node.js, BullMQ, `@anthropic-ai/claude-agent-sdk`, Vitest

## Global Constraints

- Must preserve the existing `FileProcessor` and `ProcessedFileResult` interfaces.
- The default worker concurrency must remain 1 if `WORKER_CONCURRENCY` is unset.
- All tests must pass before completing the work.

---

### Task 1: Add Concurrency Config

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Update config to support WORKER_CONCURRENCY**

Modify `src/config/index.ts` to add `worker: { concurrency: Number(optional('WORKER_CONCURRENCY', '1')) }` to the `config` object.

```typescript
export const config = {
  // ... existing redis, ingest etc ...
  worker: {
    concurrency: Number(optional('WORKER_CONCURRENCY', '1')),
  },
  anthropic: {
// ...
```

- [ ] **Step 2: Update worker instantiation**

Modify `src/worker/index.ts` to use this config when creating the BullMQ Worker.

```typescript
export function createFileJobWorker(): Worker<FileJobData> {
  const worker = new Worker<FileJobData>(QUEUE_NAME, handleJob, {
    connection: getRedisConnection(),
    concurrency: config.worker.concurrency,
  });
```

- [ ] **Step 3: Run Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/config/index.ts src/worker/index.ts
git commit -m "feat: add WORKER_CONCURRENCY configuration"
```

---

### Task 2: Refactor processFile for Two-Pass Architecture

**Files:**
- Modify: `src/claude/processFile.ts`
- Modify: `test/processFile.test.ts`

**Interfaces:**
- We keep the existing `FileProcessor.processFile` signature but change its internal logic.

- [ ] **Step 1: Update Schemas in processFile.ts**

Replace `RESULT_JSON_SCHEMA` with two schemas in `processFile.ts`:

```typescript
const PASS1_JSON_SCHEMA = {
  type: 'object',
  properties: {
    isMaterialblatt: { type: 'boolean', description: 'true wenn das Dokument keine zu lösenden Aufgaben enthält.' },
    fach: { type: 'string', enum: [...FACH_KEYS], description: 'Fester Fach-Schlüssel.' },
    lernfeld: { type: 'string', description: 'Optionales Kapitel/Lernfeld, falls im Dokument erkennbar.' },
    thema: { type: 'string', description: 'Kurzes Thema des Dokuments.' }
  },
  required: ['isMaterialblatt', 'fach', 'thema'],
  additionalProperties: false,
} as const;

const PASS2_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tasksFound: {
      type: 'array',
      description: 'Jede gefundene Aufgabe mit vollständiger Lösung. Leer bei einem Materialblatt.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Kurztitel für die Überschrift.' },
          taskDescription: { type: 'string', description: 'Vollständiger Aufgabentext.' },
          proposedSolution: { type: 'string', description: 'Vollständige, konkrete Lösung.' },
          quelle: { type: 'string', description: 'Paragraphen/Quellen/Kategorie, falls zutreffend.' },
        },
        required: ['title', 'taskDescription', 'proposedSolution'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasksFound'],
  additionalProperties: false,
} as const;
```

- [ ] **Step 2: Update processFile logic**

Modify the implementation of `processFile` to first make a query for Pass 1.
If `isMaterialblatt` is true, return immediately.
If `isMaterialblatt` is false, make a second query for Pass 2 (with the original text AND the Pass 1 result as context), then combine the results.

```typescript
// Inside processFile...
const pass1Options = {
  systemPrompt: SYSTEM_PROMPT,
  model: 'claude-3-5-haiku-latest', // Fast model for Pass 1
  tools: [],
  maxTurns: 3,
  outputFormat: { type: 'json_schema', schema: PASS1_JSON_SCHEMA },
};

// ... run queryFn for pass 1, parse result ...
const pass1Raw = resultMessage1.structured_output ?? parseModelJson(resultMessage1.result, fileName);
// Validate pass 1
const isMaterialblatt = Boolean(pass1Raw.isMaterialblatt);

if (isMaterialblatt) {
   return {
     originalFileName: fileName,
     isMaterialblatt: true,
     fach: pass1Raw.fach,
     thema: pass1Raw.thema,
     lernfeld: pass1Raw.lernfeld,
     tasksFound: []
   };
}

// Pass 2
const pass2PromptText = buildPromptText(fileName, extraction, siblings) + 
  `\n\nHinweis aus Pass 1: Fach=${pass1Raw.fach}, Thema=${pass1Raw.thema}. Bitte Aufgaben lösen.`;

const pass2Prompt = extraction.visionPages.length > 0 
  ? buildVisionPrompt(pass2PromptText, extraction.visionPages, readImageFile) 
  : pass2PromptText;

const pass2Options = {
  systemPrompt: SYSTEM_PROMPT,
  model: config.anthropic.model, // Slower model for Pass 2
  tools: [],
  maxTurns: 3,
  outputFormat: { type: 'json_schema', schema: PASS2_JSON_SCHEMA },
};

// ... run queryFn for pass 2, parse result ...
// return combined result
```

*(Note: Validation logic in `validateShape` will also need to be split or adapted to parse the two separate chunks safely).*

- [ ] **Step 3: Update Unit Tests**

Modify `test/processFile.test.ts` to expect two queries when `isMaterialblatt` is false.
For example, updating `fakeQuery` to maintain a call count:

```typescript
    let callCount = 0;
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      callCount++;
      if (callCount === 1) {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify({ isMaterialblatt: false, fach: 'BGWP', thema: 'Kaufvertragsrecht' }),
          structured_output: { isMaterialblatt: false, fach: 'BGWP', thema: 'Kaufvertragsrecht' },
        });
      } else {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify({ tasksFound: VALID_STRUCTURED_OUTPUT.tasksFound }),
          structured_output: { tasksFound: VALID_STRUCTURED_OUTPUT.tasksFound },
        });
      }
    }
```
And handle the single call case for when `isMaterialblatt` is true. Update all tests to mock the double call correctly.

- [ ] **Step 4: Verify Tests Pass**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/claude/processFile.ts test/processFile.test.ts
git commit -m "feat: implement two-pass LLM strategy"
```
