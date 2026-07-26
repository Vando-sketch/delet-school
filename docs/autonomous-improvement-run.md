# Autonomous Improvement Run — delet-school

Paste everything in the fenced block below as a single message to start the run.
It executes fully autonomously and stops only after opening a PR and writing a summary.

```
You are running FULLY AUTONOMOUSLY on the delet-school project. From now until you
have opened a pull request and written a final summary, you MUST NOT stop to ask me
anything. Resolve every ambiguity yourself using sensible defaults and the guardrails
below, record the decision, and keep going. Treat "I need input" as a bug in your plan.

## Mission
Sweep the entire project for potential improvements and flaws, have those findings
independently reviewed (by a fresh Claude agent AND a cross-model agy/Gemini agent),
turn the reviewed findings into an implementation plan, get the plan reviewed the same
way, implement the reviewed plan, verify everything is green, open ONE pull request,
and finish with a summary of all changes.

## Non-negotiable guardrails (autonomy safety)
- Follow the project git workflow in CLAUDE.md: work on branches, NEVER commit to main.
- Open a PR at the end. DO NOT merge it. DO NOT push to or force-push main. The merge
  is mine to make.
- Scope for THIS run = prioritized & low-risk: (1) make the build green, then
  (2) implement only high-value + low-risk findings (bugs, security, correctness,
  cheap wins, test/lint gaps). Large or risky refactors are NOT implemented — they are
  written into the plan as clearly-labeled deferred follow-ups.
- Respect intentional design. Do NOT "fix" documented/intentional decisions (e.g. the
  fixed Fach routing table, the watched-folder/Taildrop ingest instead of a push API).
  If in doubt, check docs/, README, and CLAUDE.md before changing behavior.
- Never touch secrets or real credentials. Never weaken auth, disable security checks,
  or add telemetry/exfiltration. Do not delete files you did not create without
  recording why.
- Every code change must be backed by a passing test. Use TDD.
- Hard stop conditions that DO require you to stop and write a summary instead of
  continuing: a guardrail would have to be violated to proceed, or the same
  verification step fails 3 times after genuine fix attempts. In that case, stop,
  leave the branch intact, and explain in the summary. Otherwise, never stop.

## Skills / tools to use (invoke them, don't reinvent)
- superpowers:writing-plans, superpowers:test-driven-development,
  superpowers:systematic-debugging, superpowers:requesting-code-review,
  superpowers:verification-before-completion, superpowers:finishing-a-development-branch.
- delegating-to-agy for every cross-model (agy/Gemini) review step.
- /security-review for the security pass.
- Keep a running TODO list (TodoWrite) reflecting the phases below.

## Phase 0 — Baseline
1. Create the integration branch off main: `chore/autonomous-improvement-sweep`.
2. Run `npm run typecheck`, `npm run lint`, `npm test`. Record the exact current state
   (as of this writing main is RED: 2 failing tests from a gemini model-version config
   drift in src/config/index.ts vs test expectations, and 3 eslint no-explicit-any
   errors in test/processFile.test.ts). Capture real output — do not assume.

## Phase 1 — Discovery (find improvements & flaws)
1. Walk the whole project (src/, test/, docker/, config, docs/). Use the existing
   graphify graph (graphify-out/graph.json) via `graphify query "..."` to orient fast
   before reading files.
2. Produce docs/findings/01-raw-findings.md: every potential improvement or flaw, each
   with location (file:line), category (security | correctness | bug | test-gap |
   lint | perf | maintainability | ops/deploy), severity, rough effort, and a one-line
   rationale. Include the known red-build items and the README "Known open items"
   (untuned OCR dictionary-ratio threshold, breaking Nextcloud config change).
3. Run `/security-review` on the branch. Fold its findings into the same document,
   tagged as security, de-duplicating against what you already found.

## Phase 2 — Independent review of the findings (two reviewers)
Run BOTH in parallel, give each the raw findings doc:
1. A fresh Claude subagent (Agent tool, general-purpose): critique the findings —
   what's wrong, missing, mis-prioritized, or actually intentional design — and draft
   an implementation plan for the in-scope subset.
2. A delegating-to-agy (agy/Gemini) agent: same task, independent cross-model take.
Then YOU reconcile both reviews into a single plan: docs/findings/02-implementation-plan.md.
Use superpowers:writing-plans. The plan must be ordered, each task test-first, each
task labeled IN-SCOPE (implement now) or DEFERRED (follow-up), with the red-build fix
as task 1. For the gemini model-version drift, pick the correct values by checking the
actual commit history / intent and make config and tests agree — state which side you
chose and why.

## Phase 3 — Review the plan
Have the plan itself reviewed the same two ways in parallel: a fresh Claude reviewer
subagent AND a delegating-to-agy agent. Incorporate their feedback into
docs/findings/02-implementation-plan.md (bump to a "reviewed" state). Use
superpowers:receiving-code-review to judge feedback rigorously — apply what's correct,
reject with reason what isn't.

## Phase 4 — Implement
Execute the IN-SCOPE tasks of the reviewed plan in order, TDD, committing on the
integration branch (or per-task sub-branches merged back in, your choice — main agent
does all merges). Fix the red build first. Keep changes minimal and reviewable.

## Phase 5 — Verify (evidence, not assertions)
`npm run typecheck && npm run lint && npm test` must all pass. Paste the real output
into the summary. Do not claim done without green output. If lint/tests were red at
baseline, they must be green now.

## Phase 6 — Ship & summarize
1. Open ONE pull request with `gh pr create` targeting main, from
   chore/autonomous-improvement-sweep. Body = what changed and why, plus the DEFERRED
   follow-ups list. Do NOT merge.
2. Write a final summary in the chat AND to docs/findings/03-run-summary.md containing:
   - every change made (file-by-file, grouped by finding/task)
   - baseline vs final typecheck/lint/test results (real numbers)
   - what each reviewer (Claude + agy) contributed or changed
   - the DEFERRED follow-ups not done this run and why
   - the PR link.

Begin now with Phase 0. Do not ask me anything until the summary is written.
```
