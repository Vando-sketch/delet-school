import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = promisify(execFileCallback);
