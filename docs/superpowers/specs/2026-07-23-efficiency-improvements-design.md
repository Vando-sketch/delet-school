# Efficiency Improvements: Throughput and Cost Optimization

## Goal
Improve the efficiency of the `teams-task-agent` pipeline in two main areas:
1. **Processing Speed & Throughput**: Process multiple files concurrently.
2. **API Cost & Token Efficiency**: Reduce the cost of LLM classification and avoid sending pure material/info sheets to the expensive model.

## Proposed Architecture

The improvements will be implemented through two core changes:

### 1. Worker Concurrency (Throughput)
- Add a new environment variable `WORKER_CONCURRENCY` to control how many BullMQ jobs can be processed in parallel.
- Default the value to `1` in `src/config/index.ts` to maintain backward compatibility, but allow overriding via `.env` (e.g., `WORKER_CONCURRENCY=4`).
- Update `src/worker/index.ts` to pass the `concurrency` option when instantiating the BullMQ `Worker`.

### 2. Two-Pass LLM Strategy (API Efficiency)
- Refactor the `processFile` method in `src/claude/processFile.ts` to split the currently monolithic Anthropic SDK call into a two-pass architecture.

**Pass 1: Classification (Fast & Cheap)**
- Model: `claude-3-5-haiku-latest` (or `claude-3-haiku-20240307` depending on configuration).
- JSON Schema: Only requests `isMaterialblatt`, `fach`, `thema`, and `lernfeld`.
- Purpose: Quickly determine if a file is an `Aufgabenblatt` (contains tasks) or a `Materialblatt` (no tasks).

**Pass 2: Solving (Deep Reasoning)**
- Trigger: Only runs if Pass 1 returned `isMaterialblatt: false`.
- Model: `claude-3-5-sonnet-latest`.
- Context Provided: Extracted text/vision pages *and* the classification data from Pass 1.
- JSON Schema: Only requests the `tasksFound` array.
- Output: The final combined `ProcessedFileResult`.

If Pass 1 returns `isMaterialblatt: true`, we immediately return an empty `tasksFound` array without invoking Pass 2, saving significant tokens and processing time.

## Migration Path
- The `.env.example` will be updated to document the new `WORKER_CONCURRENCY` variable.
- The `claude/processFile.ts` refactoring will maintain the existing `FileProcessor` interface, so `src/worker/index.ts` requires no changes related to the LLM split.
