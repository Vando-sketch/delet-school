# Task 2 Brief: Hunspell Header Skipping, Regex Parsing & Multi-Path Cache (`src/extract/dictionary.ts`)

**Files to modify:**
- Modify: `src/extract/dictionary.ts`
- Modify: `test/extract/dictionary.test.ts`

**Interfaces:**
- Consumes: `LoadWordSetDeps` from `src/extract/dictionary.ts`
- Produces: `loadWordSet(deps?: LoadWordSetDeps): Set<string>` and `clearWordSetCache(): void`

**Requirements:**
1. Update `src/extract/dictionary.ts`:
   - Export `clearWordSetCache()` to allow tests to clear module-level cache deterministically.
   - Maintain `cachedWordSets = new Map<string, Set<string>>()`.
   - Compute cache key as `dicPaths.slice().sort().join(':')`. When `loadWordSet` is called with identical dictionary paths, return cached `Set<string>`.
   - Strip Hunspell header line (first line containing entry count, e.g. `318520`):
     ```ts
     const firstNewlineIndex = contents.indexOf('\n');
     const body = firstNewlineIndex !== -1 ? contents.slice(firstNewlineIndex + 1) : contents;
     ```
   - Parse words via regex scanning `const WORD_PATTERN = /^([^\/\s\r\n]+)/gm;` without `.split('\n')` or `.split('/')`.
   - Exclude purely numeric strings (e.g. `/^\d+$/`).
2. Add Vitest unit tests in `test/extract/dictionary.test.ts`:
   - Verify header line count string (e.g. `318520`) is excluded from the word set.
   - Verify caching behavior across multiple calls with same `dicPaths`.
   - Verify cache isolation when using different `dicPaths`.

**Verification:**
Run `npx vitest run test/extract/dictionary.test.ts` to ensure all tests pass.
