import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for the Redis hash `delet_school:content_signatures`.
// Keyed by field (crypto.randomUUID()), value = JSON-encoded signature record.
const mockRedisStore = new Map<string, string>();
let redisShouldFail = false;
let redisReady = true;

const mockRedis = {
  get status() {
    return redisReady ? 'ready' : 'not_ready';
  },
  hgetall: vi.fn().mockImplementation(async (_key: string) => {
    if (redisShouldFail) {
      throw new Error('Redis connection failed');
    }
    return Object.fromEntries(mockRedisStore);
  }),
  hset: vi.fn().mockImplementation(async (_key: string, field: string, value: string) => {
    if (redisShouldFail) {
      throw new Error('Redis connection failed');
    }
    mockRedisStore.set(field, value);
    return 1;
  }),
};

vi.mock('../src/queue/index.js', () => ({
  getRedisConnection: () => mockRedis,
}));

import { normalizeText, simhash, hammingDistance, checkNearDuplicate } from '../src/ingest/nearDup.js';

describe('Near-duplicate detection module (nearDup)', () => {
  beforeEach(() => {
    mockRedisStore.clear();
    redisShouldFail = false;
    redisReady = true;
    vi.clearAllMocks();
  });

  describe('normalizeText', () => {
    it('lowercases, strips punctuation, and collapses whitespace', () => {
      const result = normalizeText('  Hello,   World!!\n\nThis   is\ta Test.  ');
      expect(result).toBe('hello world this is a test');
    });
  });

  describe('simhash / hammingDistance', () => {
    it('produces a low Hamming distance for near-identical text (OCR-noise style differences)', () => {
      const original =
        'Berechne die Ableitung der Funktion f(x) = 3x^2 + 2x - 5 und bestimme die Nullstellen.';
      const ocrNoisy =
        'berechne die ableitung  der funktion f x  3x 2 2x 5  und bestimme  die nullstellen';

      const distance = hammingDistance(
        simhash(normalizeText(original)),
        simhash(normalizeText(ocrNoisy)),
      );

      expect(distance).toBeLessThanOrEqual(10);
    });

    it('produces a low Hamming distance for a worksheet-length text with a couple of typos', () => {
      // A trigram-shingled SimHash is only stable when isolated word-level typos are a small
      // proportion of the total shingles - realistic for a full worksheet's worth of text,
      // unlike a single short sentence where every word carries a large share of the signal.
      const a =
        'Die Photosynthese ist ein biologischer Prozess, bei dem Pflanzen, Algen und einige ' +
        'Bakterien Lichtenergie in chemische Energie umwandeln. Dabei wird Kohlenstoffdioxid ' +
        'aus der Luft zusammen mit Wasser aus dem Boden zu Traubenzucker und Sauerstoff ' +
        'umgewandelt. Der Sauerstoff wird als Nebenprodukt an die Atmosphaere abgegeben und ' +
        'ist fuer viele Lebewesen lebensnotwendig. Die Photosynthese findet hauptsaechlich in ' +
        'den Chloroplasten der Pflanzenzellen statt und wird durch das gruene Pigment ' +
        'Chlorophyll ermoeglicht.';
      const b =
        'Die Photosyntese ist ein biologischer Prozess, bei dem Pflanzen, Algen und einige ' +
        'Bakterien Lichtenergie in chemische Energie umwandeln. Dabei wird Kohlenstoffdioxid ' +
        'aus der Luft zusammen mit Wasser aus dem Boden zu Traubenzucker und Sauerstoff ' +
        'umgewandelt. Der Sauerstoff wird als Nebenprodukt an die Atmosphaere abgegeben und ' +
        'ist fuer viele Lebewesen lebensnotwendig. Die Photosynthese findet hauptsaechlich in ' +
        'den Chloroplasten der Pflanzenzellen statt und wird durch das gruene Pigment ' +
        'Chlorophyl ermoeglicht.';

      const distance = hammingDistance(simhash(normalizeText(a)), simhash(normalizeText(b)));

      expect(distance).toBeLessThanOrEqual(10);
    });

    it('produces a high Hamming distance for unrelated text', () => {
      const a =
        'Berechne die Ableitung der Funktion f(x) = 3x^2 + 2x - 5 und bestimme die Nullstellen.';
      const b =
        'Beschreibe die Ursachen des Ersten Weltkriegs und seine Auswirkungen auf Europa im 20. Jahrhundert.';

      const distance = hammingDistance(simhash(normalizeText(a)), simhash(normalizeText(b)));

      expect(distance).toBeGreaterThan(10);
    });

    it('is deterministic for the same input', () => {
      const text = normalizeText('Some sample worksheet text about fractions and percentages.');
      expect(simhash(text)).toBe(simhash(text));
    });

    it('hammingDistance is zero for identical fingerprints', () => {
      const fp = simhash(normalizeText('identical text here'));
      expect(hammingDistance(fp, fp)).toBe(0);
    });
  });

  describe('checkNearDuplicate', () => {
    const baseText =
      'Berechne die Ableitung der Funktion f(x) = 3x^2 + 2x - 5 und bestimme die Nullstellen.';

    it('returns unique when the signature store is empty', async () => {
      const verdict = await checkNearDuplicate(baseText, 'new-doc.pdf');

      expect(verdict.tier).toBe('unique');
      expect(verdict.distance).toBeNull();
      expect(verdict.matchedFile).toBeNull();
    });

    it('unconditionally records the new signature even on an empty store', async () => {
      await checkNearDuplicate(baseText, 'new-doc.pdf');

      expect(mockRedis.hset).toHaveBeenCalledTimes(1);
      expect(mockRedisStore.size).toBe(1);
      const [, value] = [...mockRedisStore.entries()][0];
      const record = JSON.parse(value);
      expect(record).toHaveProperty('simhash');
      expect(record).toHaveProperty('originalFileName');
      expect(record).toHaveProperty('recordedAt');
    });

    it("records the new document's own originalFileName so a later near-duplicate names it", async () => {
      await checkNearDuplicate(baseText, 'worksheet-a.pdf');

      const noisyDuplicate =
        'berechne die ableitung der funktion f x  3x^2 2x 5 und bestimme die nullstellen';
      const verdict = await checkNearDuplicate(noisyDuplicate, 'worksheet-b.pdf');

      expect(verdict.tier).toBe('duplicate');
      expect(verdict.matchedFile).toBe('worksheet-a.pdf');
    });

    it('classifies as duplicate when a stored signature is within skipDistance', async () => {
      const storedFingerprint = simhash(normalizeText(baseText));
      mockRedisStore.set('existing-id', JSON.stringify({
        simhash: storedFingerprint.toString(),
        originalFileName: 'worksheet-original.pdf',
        recordedAt: new Date().toISOString(),
      }));

      // Near-identical text (whitespace/punctuation noise) should land within skipDistance (3).
      const noisyDuplicate =
        'berechne die ableitung der funktion f x  3x^2 2x 5 und bestimme die nullstellen';

      const verdict = await checkNearDuplicate(noisyDuplicate, 'new-doc.pdf');

      expect(verdict.tier).toBe('duplicate');
      expect(verdict.distance).not.toBeNull();
      expect(verdict.distance).toBeLessThanOrEqual(3);
      expect(verdict.matchedFile).toBe('worksheet-original.pdf');
    });

    it('classifies as flagged when within flagDistance but beyond skipDistance', async () => {
      // Craft a stored fingerprint that is a controlled number of bits away from the new
      // document's fingerprint by flipping bits directly, so the test doesn't depend on
      // simhash's exact behavior on crafted near-duplicate text.
      const newFingerprint = simhash(normalizeText(baseText));
      const flagged = newFingerprint ^ 0b1111110n; // flips 6 low bits: distance 6 (within 3<d<=10)

      mockRedisStore.set('existing-id', JSON.stringify({
        simhash: flagged.toString(),
        originalFileName: 'worksheet-similar.pdf',
        recordedAt: new Date().toISOString(),
      }));

      const verdict = await checkNearDuplicate(baseText, 'new-doc.pdf');

      expect(verdict.tier).toBe('flagged');
      expect(verdict.distance).toBe(6);
      expect(verdict.matchedFile).toBe('worksheet-similar.pdf');
    });

    it('classifies as unique when beyond flagDistance', async () => {
      const newFingerprint = simhash(normalizeText(baseText));
      // Flip 20 bits to guarantee a distance well beyond flagDistance (10).
      const farFingerprint = newFingerprint ^ 0xfffffn;

      mockRedisStore.set('existing-id', JSON.stringify({
        simhash: farFingerprint.toString(),
        originalFileName: 'unrelated.pdf',
        recordedAt: new Date().toISOString(),
      }));

      const verdict = await checkNearDuplicate(baseText, 'new-doc.pdf');

      expect(verdict.tier).toBe('unique');
    });

    it('always records the new signature regardless of tier', async () => {
      const storedFingerprint = simhash(normalizeText(baseText));
      mockRedisStore.set('existing-id', JSON.stringify({
        simhash: storedFingerprint.toString(),
        originalFileName: 'worksheet-original.pdf',
        recordedAt: new Date().toISOString(),
      }));

      await checkNearDuplicate(baseText, 'new-doc.pdf');

      // The original entry plus the newly recorded one.
      expect(mockRedisStore.size).toBe(2);
      expect(mockRedis.hset).toHaveBeenCalledTimes(1);
    });

    it('fails open to unique with a null distance when Redis throws', async () => {
      redisShouldFail = true;

      const verdict = await checkNearDuplicate(baseText, 'new-doc.pdf');

      expect(verdict).toEqual({ tier: 'unique', distance: null, matchedFile: null });
    });

    it('fails open to unique with a null distance when Redis is not ready', async () => {
      redisReady = false;

      const verdict = await checkNearDuplicate(baseText, 'new-doc.pdf');

      expect(verdict).toEqual({ tier: 'unique', distance: null, matchedFile: null });
      expect(mockRedis.hgetall).not.toHaveBeenCalled();
      expect(mockRedis.hset).not.toHaveBeenCalled();
    });
  });
});
