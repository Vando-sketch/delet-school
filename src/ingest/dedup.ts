import * as fs from 'fs';
import * as crypto from 'crypto';
import { getRedisConnection } from '../queue/index.js';

const REDIS_HASH_SET_KEY = 'delet_school:processed_hashes';
const localHashMemorySet = new Set<string>();

/**
 * Resets the in-memory hash set cache.
 * Intended primarily for unit testing.
 */
export function resetLocalHashCache(): void {
  localHashMemorySet.clear();
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
 * Checks if a file SHA-256 hash has already been processed.
 * Checks the local memory set first, then queries the Redis set.
 * On Redis error, falls back to the local memory set result.
 */
export async function isHashSeen(hash: string): Promise<boolean> {
  if (localHashMemorySet.has(hash)) {
    return true;
  }
  try {
    const redis = getRedisConnection();
    const isMember = await redis.sismember(REDIS_HASH_SET_KEY, hash);
    if (isMember === 1) {
      localHashMemorySet.add(hash);
      return true;
    }
  } catch (_err) {
    // Fallback to local memory set if Redis is unavailable or errors
  }
  return localHashMemorySet.has(hash);
}

/**
 * Records a file SHA-256 hash as processed in both local memory set and Redis set.
 * On Redis error, logs or catches the error and retains local memory set entry.
 */
export async function recordHash(hash: string): Promise<void> {
  localHashMemorySet.add(hash);
  try {
    const redis = getRedisConnection();
    await redis.sadd(REDIS_HASH_SET_KEY, hash);
  } catch (_err) {
    // Fallback if Redis is unavailable or errors
  }
}
