import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export async function ocrPdf(
  inputPath: string,
  outputPath: string,
  execFile: ExecFileFn = defaultExecFile,
): Promise<void> {
  await execFile(config.ocr.binary, [
    '-l',
    config.ocr.languages,
    '--deskew',
    '--rotate-pages',
    '--skip-text',
    inputPath,
    outputPath,
  ]);
}
