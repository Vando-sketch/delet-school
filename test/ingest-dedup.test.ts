import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockRedisSet = new Set<string>();
let redisShouldFail = false;

const mockRedis = {
  status: 'ready',
  sadd: vi.fn().mockImplementation(async (key: string, member: string) => {
    if (redisShouldFail) {
      throw new Error('Redis connection failed');
    }
    if (mockRedisSet.has(member)) {
      return 0;
    }
    mockRedisSet.add(member);
    return 1;
  }),
  del: vi.fn().mockImplementation(async (key: string) => {
    if (redisShouldFail) {
      throw new Error('Redis connection failed');
    }
    mockRedisSet.clear();
    return 1;
  }),
};

vi.mock('../src/queue/index.js', () => ({
  getRedisConnection: () => mockRedis,
}));

import { computeFileHash, claimHash, resetLocalHashCache } from '../src/ingest/dedup.js';

describe('Content Deduplication Module (dedup)', () => {
  let tmpDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    await resetLocalHashCache();
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

  it('claims an unseen hash (returns true) and rejects it on a later call (returns false)', async () => {
    const hash = await computeFileHash(testFilePath);
    expect(await claimHash(hash)).toBe(true);
    expect(await claimHash(hash)).toBe(false);
    expect(mockRedis.sadd).toHaveBeenCalledWith('delet_school:processed_hashes', hash);
  });

  it('resets local hash cache when resetLocalHashCache is called', async () => {
    redisShouldFail = true; // Isolate local memory cache testing
    const hash = 'a'.repeat(64);
    expect(await claimHash(hash)).toBe(true);
    expect(await claimHash(hash)).toBe(false);

    await resetLocalHashCache();
    expect(await claimHash(hash)).toBe(true);
  });

  it('falls back to local claim when Redis throws an error', async () => {
    const hash = await computeFileHash(testFilePath);
    redisShouldFail = true;

    expect(await claimHash(hash)).toBe(true);
    expect(await claimHash(hash)).toBe(false);
  });

  it('rejects a hash already present in Redis, even if not seen locally yet', async () => {
    const hash = 'b'.repeat(64);
    mockRedisSet.add(hash); // Pre-populate Redis set, simulating another worker's claim

    expect(await claimHash(hash)).toBe(false);
    expect(mockRedis.sadd).toHaveBeenCalledWith('delet_school:processed_hashes', hash);
  });

  it('only lets one caller claim a hash when two calls race concurrently in the same process', async () => {
    const hash = await computeFileHash(testFilePath);

    // Simulates two near-simultaneous 'add' events for identical file content (e.g. a batch
    // drop) racing through claimHash before either has finished - the bug this replaces:
    // isHashSeen()-then-recordHash() as two separate calls let both callers observe "unseen".
    const [first, second] = await Promise.all([claimHash(hash), claimHash(hash)]);

    const claims = [first, second].filter(Boolean);
    expect(claims).toHaveLength(1);
  });
});
