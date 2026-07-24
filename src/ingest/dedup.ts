import * as fs from 'fs';
import * as crypto from 'crypto';
import { getRedisConnection } from '../queue/index.js';

const REDIS_HASH_SET_KEY = 'delet_school:processed_hashes';
const localHashMemorySet = new Set<string>();

/**
 * Resets the in-memory hash set cache.
 * Intended primarily for unit testing.
 */
export async function resetLocalHashCache(): Promise<void> {
  localHashMemorySet.clear();
  try {
    const redis = getRedisConnection();
    if (redis.status === 'ready') {
      await redis.del(REDIS_HASH_SET_KEY);
    }
  } catch (_err) {
    // Fallback if Redis is unavailable or errors
  }
}

/**
 * Computes a SHA-256 binary hash hex string for the file at the given path.
 */
export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Atomically checks whether a file SHA-256 hash has already been processed and, if not,
 * claims it. Returns true if this call is the first to see the hash (not a duplicate);
 * false if it was already claimed - by this process or, via Redis, by another worker.
 *
 * The local check-and-add happens synchronously (no `await` between them), so two
 * overlapping calls for the same hash within one process can't both observe "unseen"
 * before either claims it - unlike a separate isHashSeen()-then-recordHash() pair, which
 * lets exactly that interleaving happen whenever two identical files land in the same
 * tick (e.g. a batch drop). Redis SADD's return value (0 = already a member) extends the
 * same atomicity across worker processes.
 */
export async function claimHash(hash: string): Promise<boolean> {
  if (localHashMemorySet.has(hash)) {
    return false;
  }
  localHashMemorySet.add(hash);

  try {
    const redis = getRedisConnection();
    if (redis.status === 'ready') {
      const added = await redis.sadd(REDIS_HASH_SET_KEY, hash);
      if (added === 0) {
        return false;
      }
    }
  } catch (_err) {
    // Redis unavailable - the local claim above is the fallback source of truth.
  }
  return true;
}
