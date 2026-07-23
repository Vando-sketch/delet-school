# AGENTS.md

This file provides guidance to AI Agents working in this repository.

## Git Workflow

Follow this workflow for every implementation task without waiting to be prompted:

1. **Task Classification**: Classify the task as `feat` (new capability), `fix` (bug fix), or another conventional commit type (`refactor`, `chore`, `docs`, `test`) based on the diff content.
2. **Branch Creation**: Always create a branch named `<type>/<short-kebab-description>` (e.g., `feat/wardrobe-photo-batching`, `fix/dashboard-auth-bypass`) off the current base branch before making changes. Never commit directly to `main` or base branches.
3. **Implement & Test**: Perform implementation, test execution, and commit changes on the task branch.
4. **Pull Request**: Open a pull request (`gh pr create`) targeting the base branch once implementation, linting, and tests pass and are fully verified.

### Large Task Breakdown & Subagent Workflow

For tasks large enough to split into independent subtasks:

1. **Integration Branch**: Create the `<type>/<description>` branch first as the main integration branch.
2. **Subtask Dispatch**: Split work into independent subtasks and dispatch to subagents appropriately based on complexity.
3. **Subagent Workflows**: Each subagent creates a branch off the integration branch following `<type>/<description>`, implements, tests, and commits locally on their branch without merging or creating PRs directly.
4. **Integration Merge**: The primary agent merges completed subagent branches into the integration branch, resolving any merge conflicts.
5. **Final Verification & PR**: The primary agent runs full linting and tests across the merged integration branch before opening a single pull request for the overall task.
