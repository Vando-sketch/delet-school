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
