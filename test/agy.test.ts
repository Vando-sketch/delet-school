import { describe, expect, it } from 'vitest';
import { defaultSubprocessRunner, parseDurationToMs, stripJsonFence } from '../src/agy/index.js';

describe('stripJsonFence', () => {
  it('strips ```json ... ``` code fence', () => {
    const input = '```json\n{"hello": "world"}\n```';
    expect(stripJsonFence(input)).toBe('{"hello": "world"}');
  });

  it('strips ``` ... ``` code fence without json tag', () => {
    const input = '```\n{"hello": "world"}\n```';
    expect(stripJsonFence(input)).toBe('{"hello": "world"}');
  });

  it('passes unfenced JSON through as-is', () => {
    const input = '{"hello": "world"}';
    expect(stripJsonFence(input)).toBe('{"hello": "world"}');
  });

  it('handles whitespace around fenced JSON', () => {
    const input = '   \n```json\n{"hello": "world"}\n```\n  ';
    expect(stripJsonFence(input)).toBe('{"hello": "world"}');
  });
});

describe('parseDurationToMs', () => {
  it('parses minutes correctly', () => {
    expect(parseDurationToMs('5m')).toBe(300000);
    expect(parseDurationToMs('10min')).toBe(600000);
  });

  it('parses seconds correctly', () => {
    expect(parseDurationToMs('30s')).toBe(30000);
    expect(parseDurationToMs('45sec')).toBe(45000);
  });

  it('parses hours correctly', () => {
    expect(parseDurationToMs('1h')).toBe(3600000);
  });

  it('parses raw numbers as milliseconds', () => {
    expect(parseDurationToMs('5000')).toBe(5000);
  });

  it('defaults to 5 minutes on unparseable input', () => {
    expect(parseDurationToMs('invalid')).toBe(300000);
  });
});

describe('defaultSubprocessRunner', () => {
  it('executes a command and returns stdout and exitCode 0 on success', async () => {
    const result = await defaultSubprocessRunner('node', ['-e', 'console.log("hello agy")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello agy');
  });

  it('returns non-zero exitCode when command fails', async () => {
    const result = await defaultSubprocessRunner('node', ['-e', 'process.exit(2)']);
    expect(result.exitCode).toBe(2);
  });

  it('handles process lifecycle and kills process on timeout', async () => {
    const start = Date.now();
    const result = await defaultSubprocessRunner('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    const duration = Date.now() - start;
    expect(result.exitCode).not.toBe(0);
    expect(duration).toBeLessThan(2000);
  });
});
