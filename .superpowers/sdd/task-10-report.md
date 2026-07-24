# Task 10 Report: Solution-markdown builder

## What Was Implemented

Created `src/pdf/buildMarkdown.ts` which exports `buildSolutionMarkdown(result: ProcessedFileResult, datum: string): string`. This function:

1. Builds YAML frontmatter with metadata: lang, fach, lernfeld (optional), thema with "– Lösungen" suffix, student name/klasse, and datum
2. Generates pandoc-ready fenced-div blocks for each task:
   - `:::: {.task}` wrapper per task
   - Numbered heading (`## 1. Title`, etc.)
   - `::: {.frage}` block with task description
   - `::: {.antwort}` block with proposed solution
   - `::: {.quelle}` block (conditionally included only if quelle field present)
3. Passes all LLM-authored text (title, taskDescription, proposedSolution, quelle) through `escapeForPandoc` before embedding
4. Uses `escapeYamlString` to safely escape YAML values for the frontmatter
5. Tasks are numbered sequentially starting at 1 regardless of array indices

## Testing Evidence

### Step 1: Wrote failing tests
Created 7 test cases in `test/pdf/buildMarkdown.test.ts` covering:
- Frontmatter structure and content
- Conditional lernfeld inclusion
- Task block structure with fenced divs
- Quelle block omission for tasks without quelle
- Sequential task numbering
- Escaping of LLM-authored text

### Step 2: Confirmed tests fail (RED)
```
$ npm test -- test/pdf/buildMarkdown.test.ts
FAIL - Error: Failed to load url ../../src/pdf/buildMarkdown.js
```

### Step 3: Implemented per brief specification
Implemented exact code from brief, including:
- `escapeYamlString` helper for YAML value escaping
- `buildFrontmatter` helper to construct YAML frontmatter with optional lernfeld
- `buildTaskBlock` helper to construct individual task blocks with proper fenced-div nesting and conditional quelle
- Main `buildSolutionMarkdown` export combining frontmatter and task blocks

### Step 4: Confirmed tests pass (GREEN)
```
$ npm test -- test/pdf/buildMarkdown.test.ts
✓ test/pdf/buildMarkdown.test.ts (7 tests)
Test Files  1 passed (1)
Tests       7 passed (7)
```

### Full Test Suite
```
$ npm test
✓ 12 test files passed
✓ 51 total tests passed
```

## Self-Review Checklist

- **LLM-authored text escaping**: Every field (title, taskDescription, proposedSolution, quelle) is passed through `escapeForPandoc` before embedding ✓
  - Line 29: `escapeForPandoc(task.title)` in heading
  - Line 33: `escapeForPandoc(task.taskDescription)` in frage block
  - Line 37: `escapeForPandoc(task.proposedSolution)` in antwort block
  - Line 39: `escapeForPandoc(task.quelle)` in conditional quelle block

- **Lernfeld conditional inclusion**: Omitted when absent, included when present ✓
  - Line 18: `result.lernfeld ? ... : undefined`
  - Line 23: Filter removes undefined lines

- **Quelle conditional rendering**: Only rendered if quelle field exists ✓
  - Lines 38-40: `if (task.quelle) { lines.push(...) }`

- **Task numbering**: Sequential starting at 1 ✓
  - Line 27: `const number = index + 1`
  - Verified by test case with 2 tasks showing "## 1. Erste" and "## 2. Zweite"

- **All 7 test cases pass**: ✓
  1. Frontmatter with required fields
  2. Lernfeld omitted when absent
  3. Lernfeld included when present
  4. Task block structure with nested fenced divs
  5. Quelle block omitted for tasks without quelle
  6. Multiple tasks numbered sequentially
  7. LLM-authored text properly escaped

## Files Changed

- `src/pdf/buildMarkdown.ts` (new, 46 lines)
- `test/pdf/buildMarkdown.test.ts` (new, 119 lines)

## Commits

- `0a2815d` feat: build pandoc-ready solution markdown from ProcessedFileResult

## Issues or Concerns

None. Implementation matches brief specification exactly, all tests pass, and self-review confirms correct behavior for all requirements including edge cases.
