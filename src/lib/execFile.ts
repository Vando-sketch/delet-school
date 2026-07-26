import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFileCallback);

// Node's default child-process stdout/stderr cap is 1 MiB; MarkItDown / pandoc / pdftotext
// output for a long worksheet can exceed that, and an overflow throws
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER and fails the whole job (convertToMarkdown and renderPdf
// have no fallback path). Raise the ceiling so large-but-legitimate tool output is captured
// instead of turning into a hard failure.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export const defaultExecFile: ExecFileFn = (file, args) =>
  execFileAsync(file, args as string[], { maxBuffer: MAX_BUFFER_BYTES });
