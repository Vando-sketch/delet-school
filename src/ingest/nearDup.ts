import * as crypto from 'crypto';
import pino from 'pino';
import { getRedisConnection } from '../queue/index.js';
import { config } from '../config/index.js';

const logger = pino({ name: 'near-dup' });

const REDIS_HASH_KEY = 'delet_school:content_signatures';
const FINGERPRINT_BITS = 64;

export type NearDupVerdict = {
  tier: 'duplicate' | 'flagged' | 'unique';
  distance: number | null;
  matchedFile: string | null;
};

type SignatureRecord = {
  simhash: string;
  originalFileName: string;
  recordedAt: string;
};

/**
 * Lowercases, strips punctuation, and collapses whitespace. Blunts OCR noise (differing
 * whitespace/punctuation between two OCR passes of the same worksheet) without needing a
 * dictionary or language-aware normalization.
 */
export function normalizeText(markdown: string): string {
  return markdown
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits already-normalized text into word-trigram shingles. Falls back to a single shingle
 * of the whole text when there are fewer than 3 words, so short inputs still produce a
 * (less discriminating) fingerprint instead of an empty one.
 */
function shingle(text: string): string[] {
  const words = text.split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  if (words.length < 3) {
    return [words.join(' ')];
  }
  const shingles: string[] = [];
  for (let i = 0; i <= words.length - 3; i++) {
    shingles.push(words.slice(i, i + 3).join(' '));
  }
  return shingles;
}

/**
 * Hashes a shingle with SHA-256 and truncates the digest to a 64-bit unsigned integer
 * (the first 8 bytes), the same direct use of node's `crypto` module `computeFileHash`
 * (see `dedup.ts`) already relies on.
 */
function hashShingle(text: string): bigint {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  return digest.readBigUInt64BE(0);
}

/**
 * Computes a 64-bit SimHash fingerprint over word-trigram shingles of `text`. Bit-votes
 * across every shingle hash: for each of the 64 bit positions, sums +1/-1 depending on
 * whether that bit is 1/0 in the shingle's hash, then sets the fingerprint bit to 1 if the
 * sum is positive. Near-identical text produces a fingerprint a few bits away from another
 * near-identical text's fingerprint; unrelated text produces one close to random.
 *
 * Expects `text` to already be normalized (see `normalizeText`).
 */
export function simhash(text: string): bigint {
  const shingles = shingle(text);
  if (shingles.length === 0) {
    return 0n;
  }

  const bitVotes = new Array<number>(FINGERPRINT_BITS).fill(0);
  for (const s of shingles) {
    const hash = hashShingle(s);
    for (let bit = 0; bit < FINGERPRINT_BITS; bit++) {
      const isSet = (hash & (1n << BigInt(bit))) !== 0n;
      bitVotes[bit] += isSet ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < FINGERPRINT_BITS; bit++) {
    if (bitVotes[bit] > 0) {
      fingerprint |= 1n << BigInt(bit);
    }
  }
  return fingerprint;
}

/**
 * Popcount of `a XOR b` - the number of differing bits between two fingerprints.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/**
 * Compares `markdown`'s SimHash fingerprint against every previously recorded signature in
 * the Redis hash `delet_school:content_signatures`, classifies the closest match into a
 * tier by distance against `config.nearDup.skipDistance`/`flagDistance`, and unconditionally
 * records the new document's own signature regardless of tier (so a later duplicate still
 * has something to match against).
 *
 * Fails open on any Redis problem (not ready, or an error thrown mid-call): logs a warning
 * and returns `{ tier: 'unique', distance: null, matchedFile: null }`, treating this as a
 * secondary, best-effort signal that must never block a real submission from being processed.
 */
export async function checkNearDuplicate(markdown: string): Promise<NearDupVerdict> {
  const fingerprint = simhash(normalizeText(markdown));

  try {
    const redis = getRedisConnection();
    if (redis.status !== 'ready') {
      logger.warn('Redis not ready; failing open near-duplicate check to unique');
      return { tier: 'unique', distance: null, matchedFile: null };
    }

    const entries = await redis.hgetall(REDIS_HASH_KEY);

    let minDistance: number | null = null;
    let matchedFile: string | null = null;
    for (const raw of Object.values(entries)) {
      let record: SignatureRecord;
      try {
        record = JSON.parse(raw) as SignatureRecord;
      } catch (_parseErr) {
        continue;
      }
      const storedFingerprint = BigInt(record.simhash);
      const distance = hammingDistance(fingerprint, storedFingerprint);
      if (minDistance === null || distance < minDistance) {
        minDistance = distance;
        matchedFile = record.originalFileName;
      }
    }

    const newRecord: SignatureRecord = {
      simhash: fingerprint.toString(),
      originalFileName: '',
      recordedAt: new Date().toISOString(),
    };
    await redis.hset(REDIS_HASH_KEY, crypto.randomUUID(), JSON.stringify(newRecord));

    if (minDistance === null) {
      return { tier: 'unique', distance: null, matchedFile: null };
    }

    const tier: NearDupVerdict['tier'] =
      minDistance <= config.nearDup.skipDistance
        ? 'duplicate'
        : minDistance <= config.nearDup.flagDistance
          ? 'flagged'
          : 'unique';

    return { tier, distance: minDistance, matchedFile };
  } catch (err) {
    logger.warn({ err }, 'Redis error during near-duplicate check; failing open to unique');
    return { tier: 'unique', distance: null, matchedFile: null };
  }
}
