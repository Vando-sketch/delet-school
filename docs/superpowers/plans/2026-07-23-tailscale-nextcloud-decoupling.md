# Decoupling from Nextcloud via Tailscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `teams-task-agent` run on any Docker host with tailnet access instead of requiring co-location with Nextcloud, by routing inbound files through Tailscale Taildrop and outbound writes through Nextcloud's WebDAV API, all over a Tailscale sidecar container.

**Architecture:** A `tailscale` sidecar container (custom image wrapping `tailscale/tailscale`) joins the tailnet via OAuth client credentials and shares its network namespace with `redis`, `ingest`, and `worker`. The sidecar also drains Tailscale's Taildrop queue on an interval into a shared volume; a new `taildropDrain` module inside the `ingest` container moves those files (collision-safe) into the existing watched inbox directory, which `chokidar` picks up unchanged. `src/nextcloud/writeResult.ts` is rewritten to upload via WebDAV (MKCOL/PUT through the `webdav` npm package) instead of writing to a bind-mounted data directory and shelling out to `occ files:scan`.

**Tech Stack:** TypeScript (Node 20, ESM), vitest, BullMQ, chokidar, the `webdav` npm package, Docker Compose, the official `tailscale/tailscale` Docker image.

## Global Constraints

- Node >=20, ESM (`"type": "module"` in `package.json`) — all new files use `.js`-suffixed relative imports per existing convention (e.g. `from '../config/index.js'`).
- `npm run typecheck`, `npm run lint`, and `npm test` must all pass before any task's commit (per this repo's `CLAUDE.md`).
- The `NextcloudWriter` interface (`src/types.ts`) — `writeResult(result, content, datum) => Promise<{ writtenPath: string }>` — must not change; `src/worker/index.ts` must require no changes.
- `createIngestWatcher()`'s public behavior and signature (`src/ingest/watcher.ts`) must not change — only its self-executing bootstrap block at the bottom of the file gains one extra line.
- Follow the existing dependency-injection pattern for testability: a `Pick<LibraryType, 'methodsActuallyUsed'>` minimal interface injected via an optional `deps` parameter, exactly as `src/queue/index.ts`'s `FileJobQueueLike` and `src/nextcloud/writeResult.ts`'s current `execFile` injection already do.
- Out of scope: `src/extract/`, `src/claude/`, `src/pdf/` — untouched by this plan.
- Spec reference: `docs/superpowers/specs/2026-07-23-tailscale-nextcloud-decoupling-design.md`.

---

### Task 1: Add the `webdav` dependency

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: the `webdav` package (exports `createClient`, `type WebDAVClient`) available to later tasks.

- [ ] **Step 1: Install the dependency**

Run: `npm install webdav`

Expected: `package.json`'s `dependencies` gains a `"webdav": "^..."` entry and `package-lock.json` updates.

- [ ] **Step 2: Verify the install**

Run: `npm ls webdav`
Expected: prints the installed `webdav` version with no `UNMET DEPENDENCY` error.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add webdav dependency for Nextcloud WebDAV writes"
```

---

### Task 2: Config — Nextcloud WebDAV + Taildrop settings

**Files:**
- Modify: `src/config/index.ts`
- Modify: `test/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Tasks 3–6):
  - `config.nextcloud.baseUrl(): string` — required, e.g. `https://nextcloud.<tailnet>.ts.net`
  - `config.nextcloud.username(): string` — required
  - `config.nextcloud.appPassword(): string` — required
  - `config.taildrop.stagingDir: string` — optional, default `/taildrop-staging`
  - `config.taildrop.pollIntervalMs: number` — optional, default `5000`

- [ ] **Step 1: Update the failing config test**

Edit `test/config.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = {
  NEXTCLOUD_BASE_URL: 'https://nextcloud.example.ts.net',
  NEXTCLOUD_USERNAME: 'alice',
  NEXTCLOUD_APP_PASSWORD: 'app-password',
  STUDENT_NAME: 'Elias Helmer',
  STUDENT_KLASSE: 'IT10b',
};

describe('config defaults', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    delete process.env.INGEST_WATCH_DIR;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.TAILDROP_STAGING_DIR;
    delete process.env.TAILDROP_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults INGEST_WATCH_DIR to __INBOX__', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.ingest.watchDir).toBe('__INBOX__');
  });

  it('defaults ANTHROPIC_MODEL to claude-sonnet-5', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.anthropic.model).toBe('claude-sonnet-5');
  });

  it('exposes required STUDENT_NAME / STUDENT_KLASSE', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.student.name()).toBe('Elias Helmer');
    expect(config.student.klasse()).toBe('IT10b');
  });

  it('exposes required Nextcloud WebDAV settings', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.nextcloud.baseUrl()).toBe('https://nextcloud.example.ts.net');
    expect(config.nextcloud.username()).toBe('alice');
    expect(config.nextcloud.appPassword()).toBe('app-password');
  });

  it('defaults TAILDROP_STAGING_DIR and TAILDROP_POLL_INTERVAL_MS', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.taildrop.stagingDir).toBe('/taildrop-staging');
    expect(config.taildrop.pollIntervalMs).toBe(5000);
  });

  it('reads TAILDROP_POLL_INTERVAL_MS as a number when set', async () => {
    process.env.TAILDROP_POLL_INTERVAL_MS = '2000';
    const { config } = await import('../src/config/index.js');
    expect(config.taildrop.pollIntervalMs).toBe(2000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `config.nextcloud.baseUrl is not a function` (or similar) for the two new tests; other tests still pass.

- [ ] **Step 3: Update `src/config/index.ts`**

Replace the existing `nextcloud` block:

```typescript
  nextcloud: {
    dataDir: () => required('NEXTCLOUD_DATA_DIR'),
    targetUser: () => required('NEXTCLOUD_TARGET_USER'),
    occBinary: optional('NEXTCLOUD_OCC_BIN', '/var/www/nextcloud/occ'),
  },
```

with:

```typescript
  // Reached over Tailscale via WebDAV (see the `tailscale` sidecar service in
  // docker-compose.yml) - no filesystem or `occ` access to Nextcloud's host needed.
  nextcloud: {
    baseUrl: () => required('NEXTCLOUD_BASE_URL'),
    username: () => required('NEXTCLOUD_USERNAME'),
    appPassword: () => required('NEXTCLOUD_APP_PASSWORD'),
  },
  taildrop: {
    // Directory the tailscale sidecar drains its Taildrop queue into (shared Docker volume
    // with the ingest container - see docker-compose.yml).
    stagingDir: optional('TAILDROP_STAGING_DIR', '/taildrop-staging'),
    pollIntervalMs: Number(optional('TAILDROP_POLL_INTERVAL_MS', '5000')),
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Update `.env.example`**

Replace:

```
# Nextcloud (same host as the worker, direct data-dir write)
NEXTCLOUD_DATA_DIR=/var/www/nextcloud/data
NEXTCLOUD_TARGET_USER=
NEXTCLOUD_OCC_BIN=/var/www/nextcloud/occ
```

with:

```
# Nextcloud - reached over Tailscale via WebDAV (see the tailscale service in
# docker-compose.yml), not by sharing a filesystem/host with Nextcloud.
NEXTCLOUD_BASE_URL=https://nextcloud.<your-tailnet>.ts.net
NEXTCLOUD_USERNAME=
# Create under Nextcloud's Settings > Security > "Create new app password" - scoped to one
# account, revocable independently of the login password.
NEXTCLOUD_APP_PASSWORD=

# Tailscale sidecar (docker/tailscale/) - joins the tailnet and drains Taildrop-sent files.
# TS_AUTHKEY holds an OAuth client secret (format tskey-client-...?ephemeral=false), not a
# classic auth key - create an OAuth client under the Tailscale admin console's Settings >
# OAuth clients, and a `tag:teams-task-agent` ACL tag in the tailnet's ACL policy (OAuth-issued
# keys require a tag).
TS_AUTHKEY=
TS_HOSTNAME=teams-task-agent
# Shared volume path both the tailscale sidecar and the ingest container mount - must match
# between the two (see docker-compose.yml).
TAILDROP_STAGING_DIR=/taildrop-staging
TAILDROP_POLL_INTERVAL_MS=5000
```

Also update the `REDIS_URL` comment at the top of the file:

```
# Redis (job queue) - defaults to localhost because redis, ingest, and worker all share the
# tailscale sidecar's network namespace (see docker-compose.yml); there's no Compose-DNS
# service-name lookup happening once they're on that shared namespace.
REDIS_URL=redis://localhost:6379
```

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/config/index.ts test/config.test.ts .env.example
git commit -m "feat: replace Nextcloud data-dir/occ config with WebDAV + Taildrop settings"
```

---

### Task 3: Nextcloud writer — WebDAV instead of filesystem + `occ`

**Files:**
- Modify: `src/nextcloud/writeResult.ts`
- Modify: `test/nextcloudWriter.test.ts`

**Interfaces:**
- Consumes: `config.nextcloud.baseUrl()` / `.username()` / `.appPassword()` from Task 2; `webdav`'s `createClient`/`WebDAVClient` from Task 1; `NextcloudWriteContent`, `NextcloudWriter`, `ProcessedFileResult` from `src/types.ts` (unchanged); `FACH_SUBPATH` from `src/fach.ts` (unchanged).
- Produces: `createNextcloudWriter(deps?: { webdavClient?: Pick<WebDAVClient, 'createDirectory' | 'putFileContents'> }): NextcloudWriter` — same public shape as today, so `src/worker/index.ts`'s `const nextcloudWriter = createNextcloudWriter();` and its single `nextcloudWriter.writeResult(...)` call site need no changes.

- [ ] **Step 1: Replace the test file with WebDAV-mocked tests**

Replace the full contents of `test/nextcloudWriter.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNextcloudWriter } from '../src/nextcloud/writeResult.js';
import type { ProcessedFileResult } from '../src/types.js';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isMaterialblatt: false,
    fach: 'BGWP',
    thema: 'Kaufvertragsrecht',
    tasksFound: [],
    ...overrides,
  };
}

function makeFakeClient() {
  return {
    createDirectory: vi.fn().mockResolvedValue(undefined),
    putFileContents: vi.fn().mockResolvedValue(true),
  };
}

describe('createNextcloudWriter().writeResult', () => {
  beforeEach(() => {
    process.env.NEXTCLOUD_BASE_URL = 'https://nextcloud.example.ts.net';
    process.env.NEXTCLOUD_USERNAME = 'alice';
    process.env.NEXTCLOUD_APP_PASSWORD = 'secret';
  });

  afterEach(() => {
    delete process.env.NEXTCLOUD_BASE_URL;
    delete process.env.NEXTCLOUD_USERNAME;
    delete process.env.NEXTCLOUD_APP_PASSWORD;
  });

  it('creates the Fach directory (recursive) and PUTs a solved PDF under Fächer/<Fach>/<subpath>/ with a date-suffixed filename', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const pdfBytes = Buffer.from('%PDF-1.4 fake');

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: pdfBytes }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/BGWP/Grünig/arbeitsblatt1_Loesung_2026-07-23.pdf');
    expect(client.createDirectory).toHaveBeenCalledWith('/Fächer/BGWP/Grünig', { recursive: true });
    expect(client.putFileContents).toHaveBeenCalledWith(writtenPath, pdfBytes);
  });

  it('nests under lernfeld when present', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ fach: 'IT-Tec', lernfeld: 'LF 3' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/IT-Tec/LF 3/arbeitsblatt1_Loesung_2026-07-23.pdf');
    expect(client.createDirectory).toHaveBeenCalledWith('/Fächer/IT-Tec/LF 3', { recursive: true });
  });

  it('routes an unclassifiable Fach to Fächer/_Unsortiert/', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ fach: '_Unsortiert' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/_Unsortiert/arbeitsblatt1_Loesung_2026-07-23.pdf');
  });

  it('routes Materialblatt content into Fächer/<Fach>/Material/ with no _Loesung suffix, reading bytes from sourcePath', async () => {
    const client = makeFakeClient();
    const materialSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-src-'));
    const sourcePath = path.join(materialSourceDir, 'gesetzestext.pdf');
    await fs.writeFile(sourcePath, 'source bytes');

    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ isMaterialblatt: true, fach: 'Deutsch', originalFileName: 'gesetzestext.pdf' });
    const { writtenPath } = await writer.writeResult(result, { kind: 'material', sourcePath }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/Deutsch/Material/gesetzestext_2026-07-23.pdf');
    expect(client.putFileContents).toHaveBeenCalledWith(writtenPath, Buffer.from('source bytes'));

    await fs.rm(materialSourceDir, { recursive: true, force: true });
  });

  it('sanitizes a path-traversal originalFileName before it reaches the WebDAV path', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ originalFileName: '../../etc/passwd' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath.startsWith('/Fächer/BGWP/Grünig/')).toBe(true);
    expect(writtenPath).not.toContain('..');
  });

  it('only calls createDirectory once across multiple writes to the same Fach directory', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });

    await writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');
    await writer.writeResult(
      makeResult({ originalFileName: 'arbeitsblatt2.pdf' }),
      { kind: 'pdf', bytes: Buffer.from('y') },
      '2026-07-23',
    );

    expect(client.createDirectory).toHaveBeenCalledTimes(1);
    expect(client.putFileContents).toHaveBeenCalledTimes(2);
  });

  it('throws when putFileContents resolves false', async () => {
    const client = makeFakeClient();
    client.putFileContents.mockResolvedValue(false);
    const writer = createNextcloudWriter({ webdavClient: client });

    await expect(
      writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23'),
    ).rejects.toThrow(/failed to upload/);
  });

  it('propagates a createDirectory failure instead of swallowing it', async () => {
    const client = makeFakeClient();
    client.createDirectory.mockRejectedValue(new Error('network unreachable'));
    const writer = createNextcloudWriter({ webdavClient: client });

    await expect(
      writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23'),
    ).rejects.toThrow('network unreachable');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/nextcloudWriter.test.ts`
Expected: FAIL — `createNextcloudWriter({ webdavClient: ... })` doesn't match the current (`execFile`-based) implementation; several assertions fail or the module errors on missing env vars (`NEXTCLOUD_DATA_DIR`).

- [ ] **Step 3: Rewrite `src/nextcloud/writeResult.ts`**

Replace the full file contents:

```typescript
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createClient, type WebDAVClient } from 'webdav';
import { config } from '../config/index.js';
import { FACH_SUBPATH } from '../fach.js';
import type { NextcloudWriteContent, NextcloudWriter, ProcessedFileResult } from '../types.js';

const RESULT_ROOT = 'Fächer';
const MATERIAL_SUBDIRNAME = 'Material';

type NextcloudWebDAVClient = Pick<WebDAVClient, 'createDirectory' | 'putFileContents'>;

export interface NextcloudWriterDeps {
  webdavClient?: NextcloudWebDAVClient;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences. `originalFileName`
 * and `lernfeld` are not trusted to be safe for direct path construction (e.g.
 * `../../etc/passwd` or `foo/bar.txt`).
 */
function sanitizePathSegment(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const withoutTraversal = withoutSeparators.replace(/\.\./g, '_');
  const trimmed = withoutTraversal.trim();
  return trimmed.length > 0 ? trimmed : 'untitled';
}

function deriveTargetDir(result: ProcessedFileResult): string[] {
  const fachSubpath = FACH_SUBPATH[result.fach].split('/').map(sanitizePathSegment);
  const parts = [RESULT_ROOT, ...fachSubpath];
  if (result.isMaterialblatt) {
    parts.push(MATERIAL_SUBDIRNAME);
  } else if (result.lernfeld) {
    parts.push(sanitizePathSegment(result.lernfeld));
  }
  return parts;
}

function deriveFileName(result: ProcessedFileResult, content: NextcloudWriteContent, datum: string): string {
  const safeBase = sanitizePathSegment(result.originalFileName);
  const ext = path.extname(safeBase);
  const stem = ext.length > 0 ? safeBase.slice(0, -ext.length) : safeBase;
  const finalStem = stem.length > 0 ? stem : 'untitled';

  if (content.kind === 'pdf') {
    return `${finalStem}_Loesung_${datum}.pdf`;
  }
  const materialExt = path.extname(content.sourcePath) || '.txt';
  return `${finalStem}_${datum}${materialExt}`;
}

/**
 * `createDirectory(path, { recursive: true })` from the `webdav` package already stats each
 * path segment before creating it, so it's idempotent against an already-existing folder on
 * its own. This cache only avoids repeating that network round trip for every file written
 * into a Fach folder that's already been confirmed to exist earlier in the same process.
 */
export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const client: NextcloudWebDAVClient =
    deps.webdavClient ??
    createClient(`${config.nextcloud.baseUrl()}/remote.php/dav/files/${config.nextcloud.username()}`, {
      username: config.nextcloud.username(),
      password: config.nextcloud.appPassword(),
    });
  const knownDirs = new Set<string>();

  return {
    async writeResult(result, content, datum) {
      const dirParts = deriveTargetDir(result);
      const targetDir = `/${dirParts.join('/')}`;
      const fileName = deriveFileName(result, content, datum);
      const writtenPath = `${targetDir}/${fileName}`;

      if (!knownDirs.has(targetDir)) {
        await client.createDirectory(targetDir, { recursive: true });
        knownDirs.add(targetDir);
      }

      const bytes = content.kind === 'pdf' ? content.bytes : await fs.readFile(content.sourcePath);
      const ok = await client.putFileContents(writtenPath, bytes);
      if (ok === false) {
        throw new Error(`nextcloud/writeResult: failed to upload "${writtenPath}" via WebDAV`);
      }

      return { writtenPath };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/nextcloudWriter.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/nextcloud/writeResult.ts test/nextcloudWriter.test.ts
git commit -m "feat: write Nextcloud results over WebDAV instead of data-dir + occ scan"
```

---

### Task 4: Taildrop drain — move staged files into the watched inbox

**Files:**
- Create: `src/ingest/taildropDrain.ts`
- Create: `test/taildrop-drain.test.ts`
- Modify: `src/ingest/watcher.ts` (bootstrap block only)

**Interfaces:**
- Consumes: `config.taildrop.stagingDir` / `config.taildrop.pollIntervalMs` and `config.ingest.watchDir` from Task 2.
- Produces:
  - `drainOnce(stagingDir: string, watchDir: string): Promise<void>` — moves every file in `stagingDir` into `watchDir`, unchanged unless a same-named file already exists there (then suffixed).
  - `createTaildropDrain(options?: { stagingDir?: string; watchDir?: string; intervalMs?: number }): { stop(): void }` — runs `drainOnce` on an interval.

- [ ] **Step 1: Write the failing tests**

Create `test/taildrop-drain.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTaildropDrain, drainOnce } from '../src/ingest/taildropDrain.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('drainOnce', () => {
  let stagingDir: string;
  let watchDir: string;

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-staging-'));
    watchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-watch-'));
  });

  afterEach(async () => {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(watchDir, { recursive: true, force: true });
  });

  it('moves a staged file into the watch dir unchanged when no name collision exists', async () => {
    await fs.writeFile(path.join(stagingDir, 'Scan.pdf'), 'contents');

    await drainOnce(stagingDir, watchDir);

    expect(await fs.readFile(path.join(watchDir, 'Scan.pdf'), 'utf8')).toBe('contents');
    expect(await fs.readdir(stagingDir)).toEqual([]);
  });

  it('suffixes the filename instead of overwriting when a same-named file already exists in the watch dir', async () => {
    await fs.writeFile(path.join(watchDir, 'Scan.pdf'), 'first');
    await fs.writeFile(path.join(stagingDir, 'Scan.pdf'), 'second');

    await drainOnce(stagingDir, watchDir);

    expect(await fs.readFile(path.join(watchDir, 'Scan.pdf'), 'utf8')).toBe('first');
    const entries = await fs.readdir(watchDir);
    const suffixed = entries.find((name) => name !== 'Scan.pdf');
    expect(suffixed).toBeDefined();
    expect(await fs.readFile(path.join(watchDir, suffixed as string), 'utf8')).toBe('second');
  });

  it('drains multiple files in one pass', async () => {
    await fs.writeFile(path.join(stagingDir, 'a.pdf'), 'a');
    await fs.writeFile(path.join(stagingDir, 'b.pdf'), 'b');

    await drainOnce(stagingDir, watchDir);

    expect((await fs.readdir(watchDir)).sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('does nothing (no throw) when the staging directory does not exist yet', async () => {
    await fs.rm(stagingDir, { recursive: true, force: true });

    await expect(drainOnce(stagingDir, watchDir)).resolves.toBeUndefined();
  });
});

describe('createTaildropDrain', () => {
  let stagingDir: string;
  let watchDir: string;
  let drain: { stop(): void } | undefined;

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-staging-'));
    watchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-watch-'));
  });

  afterEach(async () => {
    drain?.stop();
    drain = undefined;
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(watchDir, { recursive: true, force: true });
  });

  it('drains on the configured interval without an explicit call', async () => {
    drain = createTaildropDrain({ stagingDir, watchDir, intervalMs: 20 });
    await fs.writeFile(path.join(stagingDir, 'Scan.pdf'), 'contents');

    await waitFor(async () => (await fs.readdir(watchDir)).includes('Scan.pdf'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/taildrop-drain.test.ts`
Expected: FAIL — `Cannot find module '../src/ingest/taildropDrain.js'`.

- [ ] **Step 3: Create `src/ingest/taildropDrain.ts`**

```typescript
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { config } from '../config/index.js';

const logger = pino({ name: 'taildrop-drain' });

async function uniqueDestPath(watchDir: string, fileName: string): Promise<string> {
  const candidate = path.join(watchDir, fileName);
  const exists = await fs.stat(candidate).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return candidate;
  }
  const ext = path.extname(fileName);
  const stem = ext.length > 0 ? fileName.slice(0, -ext.length) : fileName;
  return path.join(watchDir, `${stem}_${Date.now().toString(36)}${ext}`);
}

/**
 * Moves every file currently sitting in `stagingDir` into `watchDir`. Files land unchanged
 * when no same-named file is already in `watchDir` (the common case - output filenames flow
 * straight into the final solved-PDF name via `originalFileName`, so this must not touch them
 * unconditionally); a same-named collision gets a short suffix instead of silently overwriting.
 */
export async function drainOnce(stagingDir: string, watchDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(stagingDir);
  } catch (err) {
    logger.error({ err, stagingDir }, 'Failed to read Taildrop staging directory');
    return;
  }

  for (const name of entries) {
    const src = path.join(stagingDir, name);
    try {
      const dest = await uniqueDestPath(watchDir, name);
      await fs.rename(src, dest);
      logger.info({ src, dest }, 'Drained Taildrop file into inbox');
    } catch (err) {
      logger.error({ err, src }, 'Failed to drain Taildrop file');
    }
  }
}

export interface TaildropDrain {
  stop(): void;
}

export interface CreateTaildropDrainOptions {
  stagingDir?: string;
  watchDir?: string;
  intervalMs?: number;
}

export function createTaildropDrain(options: CreateTaildropDrainOptions = {}): TaildropDrain {
  const stagingDir = path.resolve(options.stagingDir ?? config.taildrop.stagingDir);
  const watchDir = path.resolve(options.watchDir ?? config.ingest.watchDir);
  const intervalMs = options.intervalMs ?? config.taildrop.pollIntervalMs;

  const timer = setInterval(() => {
    void drainOnce(stagingDir, watchDir);
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/taildrop-drain.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Wire the drain loop into the ingest bootstrap**

In `src/ingest/watcher.ts`, add the import near the top (with the other relative imports):

```typescript
import { createTaildropDrain } from './taildropDrain.js';
```

And update the bottom bootstrap block from:

```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const watcher = createIngestWatcher();
  watcher.on('ready', () => {
    logger.info({ watchDir: path.resolve(config.ingest.watchDir) }, 'Ingest watcher ready');
  });
}
```

to:

```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const watcher = createIngestWatcher();
  watcher.on('ready', () => {
    logger.info({ watchDir: path.resolve(config.ingest.watchDir) }, 'Ingest watcher ready');
  });
  createTaildropDrain();
  logger.info({ stagingDir: path.resolve(config.taildrop.stagingDir) }, 'Taildrop drain loop started');
}
```

- [ ] **Step 6: Run the full ingest-related test suite**

Run: `npx vitest run test/ingest-watcher.test.ts test/taildrop-drain.test.ts`
Expected: PASS, all tests green (confirms the bootstrap edit didn't break `createIngestWatcher()`'s own tests, which don't exercise the `if (import.meta.url === ...)` block at all).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/ingest/taildropDrain.ts test/taildrop-drain.test.ts src/ingest/watcher.ts
git commit -m "feat: drain Taildrop-staged files into the watched inbox"
```

---

### Task 5: Tailscale sidecar image

**Files:**
- Create: `docker/tailscale/Dockerfile`
- Create: `docker/tailscale/entrypoint.sh`

**Interfaces:**
- Consumes: `TS_AUTHKEY`, `TS_HOSTNAME`, `TS_EXTRA_ARGS`, `TAILDROP_STAGING_DIR`, `TAILDROP_POLL_INTERVAL_MS` env vars (wired in Task 6's `docker-compose.yml`).
- Produces: a buildable image (`docker/tailscale/Dockerfile`) that Task 6's `tailscale` service builds from.

This component can't be unit tested (it's a container entrypoint that talks to a real tailnet) - verification is a syntax check plus a documented manual smoke test in Task 8.

- [ ] **Step 1: Create the entrypoint script**

Create `docker/tailscale/entrypoint.sh`:

```sh
#!/bin/sh
set -e

# containerboot is the official image's own entrypoint (handles TS_AUTHKEY/TS_STATE_DIR/
# TS_EXTRA_ARGS login and starts tailscaled) - run it in the background so this script can
# also drain Taildrop's file queue, which containerboot has no built-in support for.
/usr/local/bin/containerboot &
CONTAINERBOOT_PID=$!

until tailscale status >/dev/null 2>&1; do
  sleep 1
done

STAGING_DIR="${TAILDROP_STAGING_DIR:-/taildrop-staging}"
POLL_INTERVAL_MS="${TAILDROP_POLL_INTERVAL_MS:-5000}"
mkdir -p "$STAGING_DIR"

SLEEP_SECONDS=$(( POLL_INTERVAL_MS / 1000 ))
if [ "$SLEEP_SECONDS" -lt 1 ]; then
  SLEEP_SECONDS=1
fi

trap 'kill "$CONTAINERBOOT_PID" 2>/dev/null; exit 0' TERM INT

while kill -0 "$CONTAINERBOOT_PID" 2>/dev/null; do
  # `tailscale file get` moves queued Taildrop files onto disk - it queues internally rather
  # than writing straight to a folder, since this is a headless (no GUI) container.
  tailscale file get "$STAGING_DIR" || true
  sleep "$SLEEP_SECONDS"
done
```

- [ ] **Step 2: Verify the script's syntax**

Run: `sh -n docker/tailscale/entrypoint.sh`
Expected: no output, exit code 0 (POSIX `sh` syntax check).

- [ ] **Step 3: Create the Dockerfile**

Create `docker/tailscale/Dockerfile`:

```dockerfile
# Wraps the official tailscale/tailscale image with an entrypoint that also drains Taildrop's
# file queue on an interval - see
# docs/superpowers/specs/2026-07-23-tailscale-nextcloud-decoupling-design.md
FROM tailscale/tailscale:latest

COPY docker/tailscale/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 4: Build the image**

Run: `docker build -f docker/tailscale/Dockerfile -t teams-task-agent-tailscale-test .`
Expected: build succeeds (exit code 0), ending with `naming to docker.io/library/teams-task-agent-tailscale-test`.

- [ ] **Step 5: Commit**

```bash
git add docker/tailscale/Dockerfile docker/tailscale/entrypoint.sh
git commit -m "feat: add Tailscale sidecar image with Taildrop drain loop"
```

---

### Task 6: `docker-compose.yml` — sidecar networking, drop the Nextcloud bind mount

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `docker/tailscale/Dockerfile` from Task 5; `TAILDROP_STAGING_DIR` env var from Task 2 (must match the value the `ingest` container's `taildropDrain` module reads via `config.taildrop.stagingDir`).
- Produces: a Compose stack with no `NEXTCLOUD_DATA_DIR_HOST` bind mount and no host-Tailscale dependency.

- [ ] **Step 1: Replace `docker-compose.yml`**

Replace the full file contents:

```yaml
version: '3.9'

services:
  tailscale:
    build:
      context: .
      dockerfile: docker/tailscale/Dockerfile
    container_name: teams-task-agent-tailscale
    hostname: ${TS_HOSTNAME:-teams-task-agent}
    environment:
      - TS_AUTHKEY=${TS_AUTHKEY}
      - TS_EXTRA_ARGS=--advertise-tags=tag:teams-task-agent
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_USERSPACE=false
      - TAILDROP_STAGING_DIR=${TAILDROP_STAGING_DIR:-/taildrop-staging}
      - TAILDROP_POLL_INTERVAL_MS=${TAILDROP_POLL_INTERVAL_MS:-5000}
    volumes:
      - tailscale-state:/var/lib/tailscale
      - taildrop-staging:${TAILDROP_STAGING_DIR:-/taildrop-staging}
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    healthcheck:
      test: [ "CMD", "tailscale", "status", "--json" ]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 20s

  redis:
    image: redis:7-alpine
    container_name: teams-task-agent-redis
    command: redis-server --appendonly yes
    # Shares the tailscale sidecar's network namespace (see the `ingest`/`worker` comment
    # below) - reached at localhost:6379 from there, not via Compose's `redis` DNS name.
    network_mode: "service:tailscale"
    volumes:
      - redis-data:/data
    depends_on:
      tailscale:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: [ "CMD", "redis-cli", "ping" ]
      interval: 5s
      timeout: 3s
      retries: 5

  ingest:
    build:
      context: .
      dockerfile: docker/Dockerfile
    container_name: teams-task-agent-ingest
    command: npm run start:ingest
    env_file: .env
    environment:
      - NODE_ENV=production
    # Shares the tailscale sidecar's network namespace so MagicDNS/tailnet routing works
    # without installing or configuring Tailscale in this image directly. This also means
    # REDIS_URL must point at localhost (see .env.example), not a Compose service name -
    # Compose's embedded DNS isn't reachable once MagicDNS owns /etc/resolv.conf here.
    network_mode: "service:tailscale"
    volumes:
      # Watched drop folder for manually-downloaded files (zips, PDFs, etc.).
      # The host path (INGEST_WATCH_DIR_HOST) must contain the same files the worker sees, so it
      # must resolve to the same INGEST_WATCH_DIR path inside both this container and `worker`
      # below - job data passed through Redis is just a file path, not file contents.
      - "${INGEST_WATCH_DIR_HOST:-./inbox}:${INGEST_WATCH_DIR:-/app/inbox}"
      # Taildrop's landing directory (drained by the tailscale sidecar) - the taildropDrain
      # module in this container moves files from here into INGEST_WATCH_DIR above.
      - taildrop-staging:${TAILDROP_STAGING_DIR:-/taildrop-staging}
    depends_on:
      tailscale:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: docker/Dockerfile
    container_name: teams-task-agent-worker
    command: npm run start:worker
    env_file: .env
    environment:
      - NODE_ENV=production
    network_mode: "service:tailscale"
    volumes:
      - "${INGEST_WATCH_DIR_HOST:-./inbox}:${INGEST_WATCH_DIR:-/app/inbox}"
    depends_on:
      tailscale:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

volumes:
  redis-data:
    driver: local
  tailscale-state:
    driver: local
  taildrop-staging:
    driver: local
```

- [ ] **Step 2: Validate the Compose file**

Run: `docker compose -f docker-compose.yml config --quiet`
Expected: exit code 0, no output (validates YAML structure and variable interpolation without starting anything).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: run teams-task-agent via a Tailscale sidecar instead of a Nextcloud bind mount"
```

---

### Task 7: Documentation updates

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: final env var names and architecture from Tasks 2–6 (no new code interfaces produced).

- [ ] **Step 1: Update the architecture diagram**

In `README.md`, replace:

```
You, manually: download/export files from Teams (zip, PDF, ...)
        │
        ▼
Drop into __INBOX__ (e.g. a Nextcloud-synced directory)
        │
        ▼
Ingest watcher ── extracts zips (one job per contained file), enqueues each file
```

with:

```
You, manually: download/export files from Teams (zip, PDF, ...)
        │
        ▼
Send with Taildrop, to this app's tailnet device
        │
        ▼
Tailscale sidecar drains the Taildrop queue into __INBOX__
        │
        ▼
Ingest watcher ── extracts zips (one job per contained file), enqueues each file
```

And replace step 4 of the pipeline:

```
        ├─ 4. Write into Nextcloud: Fächer/<Fach>/[<Lernfeld>/]<name>_Loesung_<date>.pdf
        │      + `occ files:scan`
```

with:

```
        ├─ 4. Write into Nextcloud over WebDAV (via Tailscale):
        │      Fächer/<Fach>/[<Lernfeld>/]<name>_Loesung_<date>.pdf
```

- [ ] **Step 2: Update the Layout section**

Replace:

```
- `src/nextcloud/` — writes the result into Nextcloud's data directory under
  `Fächer/<Fach>/[<Lernfeld>/]`, and triggers `occ files:scan`.
```

with:

```
- `src/nextcloud/` — writes the result into Nextcloud under `Fächer/<Fach>/[<Lernfeld>/]` over
  WebDAV.
- `src/ingest/taildropDrain.ts` — moves files the Tailscale sidecar drains from Taildrop into
  the watched inbox directory.
```

Replace:

```
- `docker/`, `docker-compose.yml` — containerized ingest watcher + worker + Redis, with bind
  mounts for the watched folder and Nextcloud's data directory.
```

with:

```
- `docker/`, `docker-compose.yml` — containerized ingest watcher + worker + Redis + a Tailscale
  sidecar; no Nextcloud filesystem access needed, only a WebDAV connection over the tailnet.
```

- [ ] **Step 3: Update the Setup section**

Replace:

```
`INGEST_WATCH_DIR` defaults to `__INBOX__` in the root of the project directory, but can be
pointed at any folder you'll drop downloaded files into. A convenient option is a folder synced
by the Nextcloud desktop/mobile client (or uploaded via Nextcloud's web UI) — that way "upload
a file to Nextcloud" is the entire manual step, with no separate transfer to the machine running
this app.

To get files in: from Teams/SharePoint, use "Download" on individual files, or "Download as
zip" on a folder of files, then drop the result into the watched folder. Zip archives are
extracted automatically and every file inside is processed individually; everything else
(PDF, .txt, .md, ...) is processed as-is.
```

with:

```
`INGEST_WATCH_DIR` defaults to `__INBOX__` in the root of the project directory - files land
there via the Tailscale sidecar draining Taildrop sends into it (see below), so it doesn't need
to be synced with anything.

To get files in: from Teams/SharePoint, use "Download" on individual files, or "Download as
zip" on a folder of files; then, on a device with Tailscale installed, send the result with
Taildrop to this app's tailnet device (`TS_HOSTNAME`). Zip archives are extracted automatically
and every file inside is processed individually; everything else (PDF, .txt, .md, ...) is
processed as-is.

Nextcloud itself only needs to be reachable over HTTPS on the tailnet (its normal web server,
at its Tailscale MagicDNS hostname) - see `.env.example` for the `NEXTCLOUD_*` and `TS_*`
variables, and `docker/tailscale/` for the sidecar that provides tailnet connectivity to the
`ingest`/`worker`/`redis` containers.
```

- [ ] **Step 4: Read the whole updated file back and confirm no stale references remain**

Run: `grep -n "NEXTCLOUD_DATA_DIR\|NEXTCLOUD_TARGET_USER\|occ files:scan\|Nextcloud-synced" README.md`
Expected: no output (no leftover references to the removed data-dir/occ approach).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the Taildrop + WebDAV architecture in the README"
```

---

### Task 8: Full verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full automated suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three exit 0; test output shows every suite passing, including `config.test.ts`, `nextcloudWriter.test.ts`, `ingest-watcher.test.ts`, and `taildrop-drain.test.ts`.

- [ ] **Step 2: Validate the full Docker build**

Run: `docker compose -f docker-compose.yml build`
Expected: `tailscale`, `ingest`, and `worker` images all build successfully.

- [ ] **Step 3: Document the manual smoke test**

This step has no automated command - Taildrop and a real Nextcloud instance can't be exercised in this test suite. Record the following checklist in the PR description (do not skip writing it down, even though it can't run here):

1. Set real values for `TS_AUTHKEY`, `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_APP_PASSWORD` in `.env`.
2. `docker compose up -d` and wait for `docker compose ps` to show `tailscale` as `healthy`.
3. `docker compose exec tailscale tailscale status` - confirm the container shows as connected on the tailnet.
4. From a laptop with Tailscale installed, Taildrop-send a test PDF to the `TS_HOSTNAME` device.
5. `docker compose exec ingest ls /app/inbox` - confirm the file appears there within `TAILDROP_POLL_INTERVAL_MS`.
6. Watch `docker compose logs -f worker` through a full processing run, and confirm the solved PDF appears in Nextcloud's web UI under `Fächer/<Fach>/...`.
7. Send a second file with the same name as one already sitting in the inbox - confirm the second lands with a suffixed name rather than overwriting the first.

- [ ] **Step 4: Final commit (only if Steps 1-2 required fixes)**

If any fixes were needed to make verification pass:

```bash
git add -A
git commit -m "fix: address issues found during full verification"
```

If Steps 1-2 passed cleanly with no fixes needed, skip this step - there's nothing to commit.
