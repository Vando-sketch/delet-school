# Tabular Solutions & Strict Data Adherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the solution pipeline so multi-case/comparative solutions are formatted as Markdown tables and the model strictly uses in-document data, with proper CSS table styling in the rendered PDF.

**Architecture:** Two parallel changes — system prompt update in `src/claude/processFile.ts` and table CSS in `docker/vorlage/style.css` — plus tests validating both the prompt content (via the existing fake-queryFn/agyRunner capture pattern) and the visual output (manual render verification).

**Tech Stack:** TypeScript, Vitest, Pandoc + Weasyprint, CSS

## Global Constraints

- Do NOT modify `PASS2_JSON_SCHEMA`, `PASS1_JSON_SCHEMA`, or the `TaskSolution` type.
- Do NOT export `SYSTEM_PROMPT` from `processFile.ts` — tests capture it via `params.options?.systemPrompt` (Claude path) or the `-p` argument in the fake `agyRunner` (Gemini path).
- Do NOT modify `escapeForPandoc` — pipe (`|`) and dash (`-`) characters already survive unmodified.
- All existing 119 unit tests must continue to pass.
- Commit messages use conventional commit format.

---

### Task 1: Update SYSTEM_PROMPT with strict data adherence and tabular formatting instructions

**Files:**
- Modify: `src/claude/processFile.ts` (the `SYSTEM_PROMPT` const, lines ~38-79)

**Interfaces:**
- Consumes: Nothing from other tasks.
- Produces: Updated `SYSTEM_PROMPT` string containing two new instruction paragraphs, consumed by Task 3 (tests).

- [ ] **Step 1: Read the current SYSTEM_PROMPT**

Read `src/claude/processFile.ts` lines 38-79 to understand the existing prompt structure.

- [ ] **Step 2: Add strict data adherence paragraph**

Append to `SYSTEM_PROMPT` (before the final "Antworte ausschließlich…" line):

```typescript
DATEN-STRENGER-BEZUG:
Verwende zur Lösung der Aufgaben AUSSCHLIESSLICH die im Dokument (sowie in etwaigen
Geschwisterdateien desselben Batches) bereitgestellten Zahlen, Prozentsätze, Formeln, Vorgaben
und Tabellenwerte. Nutze KEINE erfundenen oder auswendig gelernten Altdaten oder abweichenden
Pauschalen, wenn das Aufgaben- oder Materialblatt konkrete Werte nennt. Wenn das Dokument
bestimmte Beitragssätze, Bemessungsgrenzen oder Steuersätze vorgibt, verwende exakt diese —
nicht allgemein bekannte Werte aus anderen Jahren oder Quellen.
```

- [ ] **Step 3: Add tabular formatting paragraph with example**

Append to `SYSTEM_PROMPT` (after the data adherence paragraph, before the final "Antworte ausschließlich…" line):

```typescript
TABELLARISCHE LÖSUNGS-STRUKTUR:
Wenn eine Aufgabe 3 oder mehr vergleichbare Fälle, Datensätze oder Zeilen enthält (z.B. Fall 1,
Fall 2, Fall 3; ein Lieferantenvergleich über mehrere Anbieter; eine Lohnabrechnung für mehrere
Mitarbeiter), MUSS die "proposedSolution" als übersichtliche Markdown-Tabelle aufgebaut sein.
Einfache Berechnungen mit nur 1-2 Schritten bleiben als Fließtext.

Beispiel für das Markdown-Tabellen-Format in proposedSolution:

| Position | Fall 1 (€) | Fall 2 (€) | Fall 3 (€) |
| :--- | :---: | :---: | :---: |
| Grundentgelt | 2.500,00 | 5.500,00 | 7.800,00 |
| + Zulagen | + 20,00 | + 20,00 | + 20,00 |
| **= Brutto** | **2.520,00** | **5.520,00** | **7.820,00** |
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests pass (prompt content is not asserted by existing tests, so nothing should break).

- [ ] **Step 6: Commit**

```bash
git add src/claude/processFile.ts
git commit -m "feat(claude): add strict data adherence and tabular formatting to SYSTEM_PROMPT"
```

---

### Task 2: Add table styling to `docker/vorlage/style.css`

**Files:**
- Modify: `docker/vorlage/style.css` (append after existing rules, currently 96 lines)

**Interfaces:**
- Consumes: Nothing from other tasks.
- Produces: CSS rules for `table`, `th`, `td` elements rendered by Weasyprint.

- [ ] **Step 1: Read the current CSS file**

Read `docker/vorlage/style.css` to understand the existing design language (colors, fonts, spacing).

- [ ] **Step 2: Add table styling rules**

Append to end of `docker/vorlage/style.css`:

```css
/* Tables — for comparative/multi-case solutions rendered from Markdown pipe tables */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0 14px;
  font-size: 13px;
  page-break-inside: avoid;
}

th,
td {
  border: 1px solid #d0d0d0;
  padding: 6px 10px;
  text-align: left;
}

th {
  background-color: #f4f4f4;
  font-family: 'Liberation Sans', sans-serif;
  font-weight: 700;
  font-size: 12px;
}

td {
  vertical-align: top;
}

tr:nth-child(even) td {
  background-color: #fafafa;
}
```

- [ ] **Step 3: Commit**

```bash
git add docker/vorlage/style.css
git commit -m "feat(pdf): add table styling rules for comparative solutions"
```

---

### Task 3: Add unit tests for prompt content verification

**Files:**
- Modify: `test/processFile.test.ts` (add new test cases at end of existing `describe('createFileProcessor', ...)` block)

**Interfaces:**
- Consumes: Updated `SYSTEM_PROMPT` from Task 1.
- Produces: Test assertions verifying prompt content via the fake `agyRunner` `-p` argument capture pattern.

- [ ] **Step 1: Read existing test patterns**

Read `test/processFile.test.ts` to understand how existing tests capture `systemPrompt` and `agyRunner` args.

- [ ] **Step 2: Write test for strict data adherence in agy prompt**

Add this test inside the existing `describe('createFileProcessor', ...)` block:

```typescript
it('includes strict data adherence instruction in the agy prompt', async () => {
  let capturedAgyPrompt = '';
  const capturingAgyRunner = async (_bin: string, args: string[]) => {
    const pIdx = args.indexOf('-p');
    if (pIdx !== -1) capturedAgyPrompt = args[pIdx + 1] ?? '';
    return {
      stdout: JSON.stringify({
        isMaterialblatt: true,
        fach: 'BGWP',
        thema: 'Test',
      }),
      stderr: '',
      exitCode: 0,
    };
  };

  const processor = createFileProcessor({
    queryFn: createDoubleFakeQuery(),
    agyRunner: capturingAgyRunner,
  });
  await processor.processFile('test.pdf', makeExtraction());

  expect(capturedAgyPrompt).toContain('AUSSCHLIESSLICH');
  expect(capturedAgyPrompt).toContain('DATEN-STRENGER-BEZUG');
});
```

- [ ] **Step 3: Write test for tabular formatting instruction in agy prompt**

Add this test inside the existing `describe('createFileProcessor', ...)` block:

```typescript
it('includes tabular formatting instruction in the agy prompt', async () => {
  let capturedAgyPrompt = '';
  const capturingAgyRunner = async (_bin: string, args: string[]) => {
    const pIdx = args.indexOf('-p');
    if (pIdx !== -1) capturedAgyPrompt = args[pIdx + 1] ?? '';
    return {
      stdout: JSON.stringify({
        isMaterialblatt: true,
        fach: 'BGWP',
        thema: 'Test',
      }),
      stderr: '',
      exitCode: 0,
    };
  };

  const processor = createFileProcessor({
    queryFn: createDoubleFakeQuery(),
    agyRunner: capturingAgyRunner,
  });
  await processor.processFile('test.pdf', makeExtraction());

  expect(capturedAgyPrompt).toContain('TABELLARISCHE');
  expect(capturedAgyPrompt).toContain('Markdown-Tabelle');
  expect(capturedAgyPrompt).toContain('| Position');
});
```

- [ ] **Step 4: Write test for strict data adherence in Claude systemPrompt**

Add this test inside the existing `describe('createFileProcessor', ...)` block:

```typescript
it('includes strict data adherence instruction in the Claude systemPrompt', async () => {
  let capturedSystemPrompt: unknown;
  let callCount = 0;
  const fakeQuery: QueryFn = async function* (params) {
    callCount++;
    if (callCount === 1) {
      capturedSystemPrompt = params.options?.systemPrompt;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(PASS1_OUTPUT),
        structured_output: PASS1_OUTPUT,
      });
    } else {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(PASS2_OUTPUT),
        structured_output: PASS2_OUTPUT,
      });
    }
  };

  const processor = createFileProcessor({ queryFn: fakeQuery, agyRunner: failingAgyRunner });
  await processor.processFile('test.pdf', makeExtraction());

  expect(capturedSystemPrompt).toContain('AUSSCHLIESSLICH');
  expect(capturedSystemPrompt).toContain('DATEN-STRENGER-BEZUG');
});
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add test/processFile.test.ts
git commit -m "test(claude): add prompt content tests for data adherence and tabular formatting"
```
