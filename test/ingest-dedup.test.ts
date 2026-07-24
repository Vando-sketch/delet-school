import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockRedisSet = new Set<string>();
let redisShouldFail = false;

const mockRedis = {
  sismember: vi.fn().mockImplementation(async (key: string, member: string) => {
    if (redisShouldFail) {
      throw new Error('Redis connection failed');
    }
    return mockRedisSet.has(member) ? 1 : 0;
  }),
  sadd: vi.fn().mockImplementation(async (key: string, member: string) => {
    if (redisShouldFail) {
      throw new Error('Redis connection failed');
    }
    mockRedisSet.add(member);
    return 1;
  }),
};

vi.mock('../src/queue/index.js', () => ({
  getRedisConnection: () => mockRedis,
}));

import { computeFileHash, isHashSeen, recordHash, resetLocalHashCache } from '../src/ingest/dedup.js';

describe('Content Deduplication Module (dedup)', () => {
  let tmpDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    resetLocalHashCache();
    mockRedisSet.clear();
    redisShouldFail = false;
    vi.clearAllMocks();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-test-'));
    testFilePath = path.join(tmpDir, 'test-doc.pdf');
    await fs.writeFile(testFilePath, Buffer.from('PDF_CONTENT_TEST_HASH_12345'));
  });

  it('computes consistent SHA-256 binary hash for a file', async () => {
    const hash1 = await computeFileHash(testFilePath);
    const hash2 = await computeFileHash(testFilePath);
    expect(hash1).toHaveLength(64); // SHA-256 hex string length
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('identifies unseen hash and records seen hash', async () => {
    const hash = await computeFileHash(testFilePath);
    expect(await isHashSeen(hash)).toBe(false);

    await recordHash(hash);
    expect(await isHashSeen(hash)).toBe(true);
    expect(mockRedis.sadd).toHaveBeenCalledWith('delet_school:processed_hashes', hash);
  });

  it('resets local hash cache when resetLocalHashCache is called', async () => {
    redisShouldFail = true; // Isolate local memory cache testing
    const hash = 'a'.repeat(64);
    await recordHash(hash);
    expect(await isHashSeen(hash)).toBe(true);

    resetLocalHashCache();
    expect(await isHashSeen(hash)).toBe(false);
  });

  it('falls back to local Set when Redis throws an error', async () => {
    const hash = await computeFileHash(testFilePath);
    redisShouldFail = true;

    // Should record in local cache despite Redis error
    await recordHash(hash);
    expect(await isHashSeen(hash)).toBe(true);
  });

  it('checks Redis set when hash is not in local cache', async () => {
    const hash = 'b'.repeat(64);
    mockRedisSet.add(hash); // Pre-populate Redis set

    expect(await isHashSeen(hash)).toBe(true);
    expect(mockRedis.sismember).toHaveBeenCalledWith('delet_school:processed_hashes', hash);
  });
});

