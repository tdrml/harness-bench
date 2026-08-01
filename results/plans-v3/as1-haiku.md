---

# Implementation Plan: Add Strict Counting Mode to `validateWordCount`

## Spec-critical Details

- Function signature: `validateWordCount(text: string, target: { min: number; max: number }, opts?: { mode?: 'legacy' | 'strict' })`
- Default mode (omitted opts or `mode` undefined): `'legacy'`
- Legacy mode: unchanged byte-for-byte behavior
- Strict mode applies **after** `stripMarkdown()` returns
- Em-dash separator character: U+2014 (literal `—`)
- Pure-number token regex: `/^\d+([.,]\d+)*$/` (examples: `3`, `3.14`, `1,000`)
- Pure-number tokens in strict mode: count as 0 words (not included in wordCount)
- Hyphenated compounds: ONE word in both modes (e.g., `state-of-the-art` stays 1)
- Return shape unchanged: `{ valid, wordCount, deviation }` where `valid` and `deviation` operate on the mode's `wordCount`
- Split behavior in strict mode: whitespace (`/\s+/`) + em-dashes (`—`) are separators; then filter pure-number tokens
- Existing tests allowed to update only where signature/fixture changes legitimately alter expected counts

## Ordered Steps

### 1. **packages/core/src/writing/word-count.ts** — Core implementation

**Pattern to follow:** See the existing `stripMarkdown()` helper (nested, focused function) and the current two-step word processing (split, then filter).

**Changes:**
- Add interface/type for options: `type WordCountMode = 'legacy' | 'strict';` and `interface ValidateWordCountOpts { mode?: WordCountMode; }`
- Update function signature: add `opts?: ValidateWordCountOpts` parameter
- After `stripMarkdown(text)`, create a branching step:
  - **Legacy path:** existing logic (split on `/\s+/`, filter empty)
  - **Strict path:** 
    1. Replace em-dashes with spaces: `stripped.replace(/—/g, ' ')`
    2. Split on `/\s+/`, filter empty (same as legacy)
    3. Filter out pure-number tokens: `.filter(w => !/^\d+([.,]\d+)*$/.test(w))`
- Ensure `wordCount = words.length` operates on the filtered array in both modes
- Keep `deviation` and `valid` calculation unchanged (they use `wordCount` from either mode)

### 2. **packages/core/src/writing/__tests__/writing.test.ts** — Unit tests

**Pattern to follow:** Existing `validateWordCount` describe block (lines 236–278); test structure mirrors other describe blocks in this file.

**Changes:**
- Add new `describe('validateWordCount — strict mode', () => { ... })` block after the existing legacy tests
- **Test: em-dash separator**
  - Input: `'fire—and—forget'`
  - Expected (strict): `wordCount === 3`
  - Expected (legacy): `wordCount === 1` (confirm via explicit legacy call or default)
- **Test: pure numbers excluded**
  - Input: `'I have 3 apples and 2.5 oranges'`
  - Expected (strict): `wordCount === 4` (I, have, apples, and, oranges = 5 - but 3 and 2.5 are excluded = 3)
  - Actually: 'I', 'have', 'apples', 'and', 'oranges' minus '3' minus '2.5' = 3 words
- **Test: mixed alphanumeric tokens counted**
  - Input: `'Version 3.0 and v2 patches'`
  - Expected (strict): `wordCount === 5` (Version, 3.0 excluded, and, v2, patches = 5? No wait: 'Version' 'and' 'v2' 'patches' = 4. But 3.0 is pure number so it's excluded. So: 'Version', 'and', 'v2', 'patches' = 4)
  - Actually: 'Version', '3.0' (pure number, excluded), 'and', 'v2', 'patches' = 4 words
- **Test: hyphenated compounds stay one word**
  - Input: `'state-of-the-art solution'` in strict mode
  - Expected: `wordCount === 2` (hyphenated compound is 1, solution is 1)
- **Test: whitespace + em-dashes both separate**
  - Input: `'word1 — word2—word3'`
  - Expected (strict): `wordCount === 3` (word1, word2, word3)
- **Test: markdown still stripped in strict mode**
  - Input: `'**3** words here'`
  - Expected (strict): `wordCount === 2` (after markdown removal: '3 words here', then '3' is pure number excluded = 2)
- **Test: backwards compatibility - legacy mode on default**
  - Input: `'fire—and—forget'`
  - Call: `validateWordCount(text, { min: 0, max: 10 })` (no opts)
  - Expected: `wordCount === 1` (legacy behavior, em-dashes not separators)
- Do **not** weaken the existing tests (lines 237–278); they still assert legacy behavior

### 3. **packages/core/src/writing/index.ts** — Re-export type

**Pattern to follow:** Export type `StyleIssueType` on line 8.

**Changes:**
- Export the options type: `export type { ValidateWordCountOpts as ValidateWordCountOptions };` (or keep internal if simpler; check import sites)
- If callers need to import the type for their own signatures, export it; otherwise keep it private to the module

### 4. **All caller files** — No changes required (default backward-compatible)

**Files that call `validateWordCount`:**
- `packages/core/src/writing/markdown.ts:47` — calls without opts → uses legacy
- `packages/core/src/merge-policy/evaluate.ts:15` — calls without opts → uses legacy
- `packages/lambdas/src/handlers/reconcile.ts` — calls without opts → uses legacy
- `packages/lambdas/src/handlers/merge-chapter.ts` — calls without opts → uses legacy
- `packages/lambdas/src/handlers/final-review.ts` — calls without opts → uses legacy

**Action:** No changes needed. Legacy mode is the default, so all existing calls preserve their current behavior.

## Consistency Sweep

- [ ] **Unit tests (writing.test.ts):**
  - [ ] Existing legacy tests still pass and are not weakened
  - [ ] New strict-mode tests added (em-dash, pure-number, hyphenation, markdown interaction, backwards compat)
  
- [ ] **Integration tests (word-count-gate.test.ts):**
  - [ ] Tests still pass; they call `validateWordCount` without opts, so legacy mode used
  - [ ] Confirm MOCK_SHORT_CHAPTER_CONTENT (100 words) still counted as 100 in legacy
  - [ ] Confirm MOCK_CHAPTER_CONTENT (300 words) still counted as 300 in legacy

- [ ] **Handler tests (reconcile.test.ts, merge-chapter.test.ts):**
  - [ ] All mocked `validateWordCount` calls still work (they return { valid, wordCount, deviation })
  - [ ] No signature changes to callers, so no test fixture updates needed

- [ ] **Type consistency:**
  - [ ] Function signature in word-count.ts matches export in index.ts
  - [ ] No new types required in other packages (options are internal)

- [ ] **Backward compatibility:**
  - [ ] All existing calls work unchanged (no opts passed = legacy mode)
  - [ ] Legacy mode output is byte-for-byte identical to current behavior
  - [ ] No changes to return shape or semantics

## Acceptance Checklist

**Before declaring done, verify:**

1. **Build succeeds:**
   ```bash
   pnpm -s build
   ```
   
2. **Full test suite passes:**
   ```bash
   pnpm -s test
   ```
   - All existing unit tests pass (validateWordCount legacy tests)
   - All new strict-mode tests pass
   - Integration tests (word-count-gate.test.ts) pass
   - Handler tests pass (reconcile.test.ts, etc.)

3. **Strict mode em-dash behavior verified:**
   ```typescript
   const result = validateWordCount('fire—and—forget', { min: 0, max: 10 }, { mode: 'strict' });
   // result.wordCount === 3
   // result.valid === true
   ```

4. **Strict mode pure-number filtering verified:**
   ```typescript
   const result = validateWordCount('I have 3 apples and 2.5 oranges', { min: 0, max: 10 }, { mode: 'strict' });
   // result.wordCount === 3 (I, have, apples, and, oranges minus 3 and 2.5)
   // Actual: I have apples and oranges = 5 - 2 (numbers) = 3
   ```

5. **Legacy mode default verified:**
   ```typescript
   const legacyResult = validateWordCount('fire—and—forget', { min: 0, max: 10 });
   // result.wordCount === 1 (em-dashes NOT separators in legacy)
   ```

6. **Hyphenated compounds ONE word in both modes:**
   ```typescript
   const legacyHyphen = validateWordCount('state-of-the-art', { min: 0, max: 10 });
   const strictHyphen = validateWordCount('state-of-the-art', { min: 0, max: 10 }, { mode: 'strict' });
   // Both === 1
   ```

7. **Markdown stripping still works in strict mode:**
   ```typescript
   const result = validateWordCount('**bold** text', { min: 0, max: 10 }, { mode: 'strict' });
   // result.wordCount === 2 (bold, text)
   ```

8. **Deviation and valid semantics unchanged:**
   - `valid` correctly reflects wordCount against min/max bounds
   - `deviation` correctly calculated as (wordCount - min) or (wordCount - max) depending on bounds crossed

9. **No test regressions:**
   - Run full suite: `pnpm -s test` — expect GREEN
   - Specifically check:
     - `packages/core/src/writing/__tests__/writing.test.ts` all pass
     - `packages/lambdas/src/__tests__/integration/word-count-gate.test.ts` all pass
     - All handler tests pass