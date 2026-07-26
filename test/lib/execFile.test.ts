import { describe, it, expect } from 'vitest';
import { defaultExecFile } from '../../src/lib/execFile.js';

describe('defaultExecFile', () => {
  it('captures stdout larger than the default 1 MiB maxBuffer without throwing', async () => {
    const bytes = 2 * 1024 * 1024; // 2 MiB, exceeds Node's 1 MiB default maxBuffer
    const { stdout } = await defaultExecFile(process.execPath, [
      '-e',
      `process.stdout.write('x'.repeat(${bytes}))`,
    ]);
    expect(stdout.length).toBe(bytes);
  });
});
