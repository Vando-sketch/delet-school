import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export interface RenderPageDeps {
  execFile?: ExecFileFn;
  mkdir?: (dir: string) => Promise<unknown>;
  readdir?: (dir: string) => Promise<string[]>;
}

export async function renderPageToPng(
  pdfPath: string,
  pageNumber: number,
  outputDir: string,
  deps: RenderPageDeps = {},
): Promise<string> {
  const execFile = deps.execFile ?? defaultExecFile;
  const mkdir = deps.mkdir ?? ((dir: string) => fs.mkdir(dir, { recursive: true }));
  const readdir = deps.readdir ?? ((dir: string) => fs.readdir(dir));

  await mkdir(outputDir);
  const prefix = path.join(outputDir, `page-${pageNumber}`);
  await execFile(config.poppler.pdftoppmBin, [
    '-png',
    '-r',
    '150',
    '-f',
    String(pageNumber),
    '-l',
    String(pageNumber),
    pdfPath,
    prefix,
  ]);

  // pdftoppm appends its own page-number suffix even for a single-page range (e.g.
  // page-2-1.png), and the exact suffix format varies by poppler version - list the dir
  // instead of guessing the filename.
  const entries = await readdir(outputDir);
  const filenamePrefix = `page-${pageNumber}`;
  const match = entries.find((name) => {
    if (!name.startsWith(filenamePrefix) || !name.endsWith('.png')) return false;
    const boundaryChar = name[filenamePrefix.length];
    return boundaryChar === undefined || !/[0-9]/.test(boundaryChar);
  });
  if (!match) {
    throw new Error(`extract/renderPage: pdftoppm did not produce an image for page ${pageNumber}`);
  }
  return path.join(outputDir, match);
}
