You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature: add a strict counting mode to `validateWordCount` (packages/core/src/writing/word-count.ts).

Exact requirements:
1. Signature: `validateWordCount(text, target, opts?: { mode?: 'legacy' | 'strict' })`. Omitted opts or mode → 'legacy', which must behave byte-for-byte as today.
2. 'strict' mode differs from legacy in EXACTLY two rules, applied after the existing markdown stripping:
   a. Em-dashes (the — character, U+2014) are treated as word separators in addition to whitespace: `fire—and—forget` counts as 3 words (legacy counts 1).
   b. Pure-number tokens are excluded from the count: a token matching `/^\d+([.,]\d+)*$/` (e.g. `3`, `3.14`, `1,000`) counts as 0 words (legacy counts 1 each). Tokens that mix digits and letters (e.g. `3rd`, `v2`) still count.
3. Hyphenated compounds remain ONE word in both modes (`state-of-the-art` = 1).
4. The returned shape and the valid/deviation semantics are unchanged - they operate on the mode's wordCount.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters their setup (signatures, fixtures, counts); do not weaken what they assert. Add tests for new behavior at the depth of neighboring tests.
When done, summarize your change briefly.
