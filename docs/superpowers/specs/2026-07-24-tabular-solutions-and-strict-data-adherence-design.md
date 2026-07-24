# Design Spec: Tabular Solutions & Strict In-Document Data Adherence

## Summary

Enhance the Claude/Gemini system prompt (`src/claude/processFile.ts`) and render pipeline
(`docker/vorlage/style.css`) to ensure the solution pipeline:
1. Formats multi-case or comparative solutions as Markdown tables.
2. Renders those tables with proper visual styling in the output PDF.
3. Strictly uses only the numbers, formulas, percentages, and guidelines provided within the
   input document and its batch sibling context, rather than relying on external or memorized
   figures.

## Problem Statement

When processing worksheets:
- Tasks with 3+ comparable cases or rows (such as payroll across multiple employees, supplier
  comparisons, or decision matrices) were output as plain text lists instead of clear
  comparative Markdown tables.
- The model could occasionally introduce memorized external data (e.g. outdated tax rates or
  standard figures) rather than adhering strictly to the exact numbers, rates, and formulas
  given in the task sheet or material sheet.
- Even when Markdown table syntax is used, `docker/vorlage/style.css` has zero rules for
  `table`/`th`/`td`, so Weasyprint renders unstyled HTML tables with no borders, padding, or
  header distinction — potentially worse than the plain-text output it replaces.

## Proposed Changes

### 1. `SYSTEM_PROMPT` in `src/claude/processFile.ts`

Update `SYSTEM_PROMPT` to include explicit requirements:

- **Strict In-Document Data Adherence**:
  Instruct the LLM to use exclusively the numbers, percentages, parameters, formulas, and
  data provided in the file content (or sibling files from the same export batch). Forbid
  substituting external or memorized figures when the document provides specific data or
  instructions.

- **Tabular Solution Formatting**:
  Instruct the LLM to format `proposedSolution` using Markdown tables (`| ... |`) when a
  task contains **3 or more comparable cases or data rows** (e.g. *Fall 1, Fall 2, Fall 3*;
  a supplier comparison across multiple suppliers; a multi-employee payroll). Single-case or
  simple two-step calculations remain prose — this avoids forcing trivial answers like
  "compute net price, then add VAT" into unnecessary tables.
  Include an explicit GFM Markdown table example in `SYSTEM_PROMPT` to enforce consistent
  table syntax across passes.

### 2. Table CSS in `docker/vorlage/style.css`

Add a `table`/`th`/`td` ruleset so Weasyprint renders Markdown tables with proper visual
styling:
- Collapsed borders, thin solid lines.
- Cell padding for readability.
- Header row distinction (bold, subtle background).
- `page-break-inside: avoid` on `<table>` where practical.

This is a required companion to the prompt change — without it the feature's stated goal
("clear comparative Markdown tables") isn't delivered in the actual PDF output.

### 3. Testing & Verification

- **Unit Tests (`test/processFile.test.ts`)**:
  Verify that the system prompt includes instructions for strict document data adherence and
  Markdown table solution formatting. New tests follow the existing capture pattern: the
  fake `queryFn` captures `params.options?.systemPrompt` (Claude path) and the fake
  `agyRunner` captures the `-p` argument (Gemini path) — `SYSTEM_PROMPT` is not exported
  as a const, matching this codebase's convention.
- **Full Test Suite**:
  Ensure all existing unit tests continue to pass, plus the new prompt-content tests.
- **Visual Verification**:
  Render a sample PDF containing a table solution through the full pipeline
  (`buildMarkdown` → `renderPdf`) and visually confirm styled table output before merging.

## Explicitly Out of Scope

- Schema modifications to `PASS2_JSON_SCHEMA` or `TaskSolution` type.
- Changes to `escapeForPandoc` — confirmed it only touches `<`, `>`, `:::` runs, and
  unbalanced backticks; pipe (`|`) and dash (`-`) characters survive unmodified.

## Self-Review

1. **Placeholder scan**: No TBD/TODO or placeholder content.
2. **Internal consistency**: System prompt modifications integrate with Pass 1 and Pass 2
   query flows (both Gemini `agy` and Claude Agent SDK fallback). CSS change covers the
   render path that prompt-generated tables flow through.
3. **Scope check**: Focused on prompt behavior, CSS styling, and test validation. No schema
   modifications.
4. **Ambiguity check**: Table trigger tightened to "3+ comparable cases/rows" to avoid
   over-triggering on simple multi-step math. Testing mechanism explicitly specified as
   capture-based (not export-based).
