import { spawn } from 'node:child_process';

export type AgySubprocessRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<{ stdout: string; exitCode: number }>;

export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (match && match[1] !== undefined) {
    return match[1].trim();
  }
  return trimmed;
}

export function parseDurationToMs(durationStr: string): number {
  const trimmed = durationStr.trim();
  const unitMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  if (!unitMatch) return 300000;
  const num = parseFloat(unitMatch[1]);
  const unit = (unitMatch[2] || 'ms').toLowerCase();
  switch (unit) {
    case 's':
    case 'sec':
    case 'seconds':
      return Math.round(num * 1000);
    case 'm':
    case 'min':
    case 'minutes':
      return Math.round(num * 60 * 1000);
    case 'h':
    case 'hour':
    case 'hours':
      return Math.round(num * 3600 * 1000);
    case 'ms':
    default:
      return Math.round(num);
  }
}

export const defaultSubprocessRunner: AgySubprocessRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let killedByTimeout = false;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const timeoutMs = options?.timeoutMs;
    if (timeoutMs && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000);
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.on('error', (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (killedByTimeout) {
        resolve({ stdout: '', exitCode: 124 });
      } else {
        resolve({ stdout, exitCode: code ?? 1 });
      }
    });
  });
};
