### Task 11: PDF renderer (pandoc + weasyprint)

**Files:**
- Create: `src/pdf/renderPdf.ts`
- Test: `test/pdf/renderPdf.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` (Task 1); `config.pandoc.*` (Task 2).
- Produces: `renderSolutionPdf(markdown: string, deps?: { execFile?: ExecFileFn; writeFile?: (path: string, data: string) => Promise<void>; rm?: (path: string) => Promise<void>; readFile?: (path: string) => Promise<Buffer> }): Promise<Buffer>` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdf/renderPdf.test.ts
import { describe, expect, it } from 'vitest';
import { renderSolutionPdf } from '../../src/pdf/renderPdf.js';

describe('renderSolutionPdf', () => {
  it('writes the markdown to a temp file, invokes pandoc with the configured template/css/engine, reads back the PDF bytes, and cleans up the temp file', async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const rmCalls: string[] = [];
    const pdfBytes = Buffer.from('%PDF-1.4 fake bytes');

    const deps = {
      writeFile: async (path: string, data: string) => {
        writeCalls.push({ path, data });
      },
      execFile: async (file: string, args: readonly string[]) => {
        execCalls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
      readFile: async () => pdfBytes,
      rm: async (path: string) => {
        rmCalls.push(path);
      },
    };

    const result = await renderSolutionPdf('# hello', deps);

    expect(result).toBe(pdfBytes);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.data).toBe('# hello');

    expect(execCalls).toHaveLength(1);
    const [call] = execCalls;
    expect(call?.file).toBe('pandoc');
    expect(call?.args).toEqual([
      writeCalls[0]?.path,
      '--template',
      '/app/vorlage/template.html',
      '--css',
      '/app/vorlage/style.css',
      '--pdf-engine',
      '/app/.venv/bin/weasyprint',
      '-o',
      expect.stringMatching(/\.pdf$/),
    ]);

    // Cleans up both the temp markdown source and the intermediate PDF it read back from.
    expect(rmCalls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/pdf/renderPdf.test.ts`
Expected: FAIL with "Cannot find module '../../src/pdf/renderPdf.js'".

- [ ] **Step 3: Implement**

```ts
// src/pdf/renderPdf.ts
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export interface RenderPdfDeps {
  execFile?: ExecFileFn;
  writeFile?: (path: string, data: string) => Promise<void>;
  readFile?: (path: string) => Promise<Buffer>;
  rm?: (path: string) => Promise<void>;
}

export async function renderSolutionPdf(markdown: string, deps: RenderPdfDeps = {}): Promise<Buffer> {
  const execFile = deps.execFile ?? defaultExecFile;
  const writeFile = deps.writeFile ?? ((p: string, data: string) => fs.writeFile(p, data, 'utf8'));
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p));
  const rm = deps.rm ?? ((p: string) => fs.rm(p, { force: true }));

  const jobId = randomUUID();
  const mdPath = path.join(os.tmpdir(), `${jobId}.md`);
  const pdfPath = path.join(os.tmpdir(), `${jobId}.pdf`);

  await writeFile(mdPath, markdown);
  try {
    await execFile(config.pandoc.binary, [
      mdPath,
      '--template',
      config.pandoc.templatePath,
      '--css',
      config.pandoc.cssPath,
      '--pdf-engine',
      config.pandoc.weasyprintBinary,
      '-o',
      pdfPath,
    ]);
    return await readFile(pdfPath);
  } finally {
    await rm(mdPath);
    await rm(pdfPath);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/pdf/renderPdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/renderPdf.ts test/pdf/renderPdf.test.ts
git commit -m "feat: render solution markdown to PDF bytes via pandoc+weasyprint"
```

---

