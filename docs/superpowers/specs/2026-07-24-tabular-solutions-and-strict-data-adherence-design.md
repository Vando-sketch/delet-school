# Design Spec: Tabular Solutions & Strict In-Document Data Adherence

## Summary

Enhance the Claude/Gemini system prompt (`src/claude/processFile.ts`) to ensure the solution pipeline:
1. Formats multi-case, multi-step, or comparative solutions as Markdown tables.
2. Strictly uses only the numbers, formulas, percentages, and guidelines provided within the input document and its batch sibling context, rather than relying on external or memorized figures.

## Problem Statement

When processing worksheets:
- Multi-case or multi-step calculation tasks (such as payroll, accounting, or decision matrices) were sometimes output as plain text lists instead of clear comparative Markdown tables.
- The model could occasionally introduce memorized external data (e.g. outdated tax rates or standard figures) rather than adhering strictly to the exact numbers, rates, and formulas given in the task sheet or material sheet.

## Proposed Changes

### 1. `SYSTEM_PROMPT` in `src/claude/processFile.ts`

Update `SYSTEM_PROMPT` to include explicit requirements:

- **Strict In-Document Data Adherence**:
  Instruct the LLM to use exclusively the numbers, percentages, parameters, formulas, and data provided in the file content (or sibling files from the same export batch). Forbid substituting external or memorized figures when the document provides specific data or instructions.

- **Tabular Solution Formatting**:
  Instruct the LLM to format `proposedSolution` using Markdown tables (`| ... |`) whenever a task contains multiple cases (e.g., *Fall 1, Fall 2, Fall 3*), multi-step calculations, or comparative data.
  Include an explicit GFM Markdown table example in `SYSTEM_PROMPT` to enforce consistent table syntax across passes.

### 2. Testing & Verification

- **Unit Tests (`test/processFile.test.ts`)**:
  Verify that `SYSTEM_PROMPT` includes instructions for strict document data adherence and Markdown table solution formatting.
- **Full Test Suite**:
  Ensure all 119 existing unit tests pass without breakage.

## Self-Review

1. **Placeholder scan**: No TBD/TODO or placeholder content.
2. **Internal consistency**: System prompt modifications integrate with Pass 1 and Pass 2 query flows (both Gemini `agy` and Claude Agent SDK fallback).
3. **Scope check**: Focused tightly on prompt behavior and test validation without schema modifications.
4. **Ambiguity check**: Clear instructions for GFM table formatting and strict document data usage.
