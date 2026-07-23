import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export async function convertToMarkdown(filePath: string, execFile: ExecFileFn = defaultExecFile): Promise<string> {
  const { stdout } = await execFile(config.markitdown.binary, [filePath]);
  return stdout;
}
