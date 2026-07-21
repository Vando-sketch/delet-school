# teams-task-agent

Detects files shared in Microsoft Teams, downloads them via the Microsoft Graph API, uses the Claude Agent SDK to find open tasks/action items and draft solutions, and writes the result into a Nextcloud instance running on the same host.

```
Teams (SharePoint/OneDrive-backed)
        │  Graph API change notification (webhook)
        ▼
Webhook receiver (Express) ── validates + enqueues, responds < 3s
        │
        ▼
Redis queue (BullMQ)
        │
        ▼
Worker
        ├─ 1. Download file via Graph API
        ├─ 2. Claude Agent SDK: find open tasks & draft solutions
        └─ 3. Write result into Nextcloud's data dir + `occ files:scan`
```

## Layout

- `src/receiver/` — Express webhook endpoint (subscription validation handshake + change-notification intake). Only parses and enqueues; never processes inline.
- `src/queue/` — BullMQ queue/connection shared by the receiver and worker.
- `src/graph/` — Microsoft Graph API client (client-credentials auth via `@azure/msal-node`), file download, subscription create/renew.
- `src/claude/` — Claude Agent SDK integration that finds open tasks in a file and proposes solutions. The exact "what counts as a task" / output-shape logic is a placeholder default — see comments in `processFile.ts`; intended to be revisited.
- `src/nextcloud/` — writes the result directly into Nextcloud's data directory (no network hop, same host) and triggers `occ files:scan`.
- `src/worker/` — wires the above together: download → process → write, one BullMQ `Worker` consuming the queue.
- `scripts/renew-subscription.ts` — run on a schedule (cron/systemd timer) to `PATCH` the Graph subscription before it expires (subscriptions expire after days, up to 30 max).
- `docker/`, `docker-compose.yml` — containerized receiver + worker + Redis, with a bind mount for Nextcloud's data directory.

## Setup

```bash
npm install
cp .env.example .env   # fill in Azure AD app + Nextcloud values
npm run dev:receiver   # local webhook receiver
npm run dev:worker     # local worker
```

Required Azure AD app registration: client-credentials flow, `Files.Read.All` or `Sites.Read.All` (channel files) / `Chat.Read` (chat attachments), admin consent granted.

The webhook receiver must be publicly reachable for Microsoft to call it (e.g. via a Cloudflare Tunnel or Tailscale Funnel) — the "no public access needed" part of the architecture applies only to the Nextcloud write step, which happens locally on the worker's host.

`ANTHROPIC_API_KEY` is optional: the Claude Agent SDK subprocess can instead authenticate via a Claude Pro/Max subscription login (`claude login` in the worker's environment), which draws from subscription rate limits rather than separate API credits. `ANTHROPIC_MODEL` is also optional (defaults to Haiku, since task extraction is a simple, high-volume call).

## Commands

- `npm run typecheck` / `npm run lint` / `npm test` — must all pass before opening a PR (see `CLAUDE.md`).
- `npm run build` — compiles to `dist/`.
- `npm run renew-subscription` — manually trigger a subscription renewal (set `GRAPH_SUBSCRIPTION_ID` in `.env`).

## Known open items

- Graph notification payload shape (exact `resource`/`resourceData` fields for driveId/itemId) is implemented defensively based on documented Graph behavior, not yet verified against a live subscription.
- Claude processing prompt/output schema for "open tasks" is a first-pass default (see `src/claude/processFile.ts`), not a finalized product decision.
- Subscription IDs aren't persisted anywhere yet (`scripts/renew-subscription.ts` expects one via env var) — a persistence layer (e.g. a Redis key) is a likely next step once there's more than one subscription to manage.
