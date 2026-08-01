You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Migration: chapter files are named with two-digit zero padding (`manuscript/chapter-07.md`). Books can exceed 99 chapters, so switch to THREE-digit zero padding (`manuscript/chapter-007.md`) everywhere.

Requirements:
1. The path helper that builds chapter paths must pad to 3 digits (chapter 7 -> `manuscript/chapter-007.md`, chapter 42 -> `manuscript/chapter-042.md`, chapter 128 -> `manuscript/chapter-128.md`).
2. Every place in the codebase that constructs, matches, or documents a chapter file path must use the new convention - including literal path strings anywhere they appear outside the helper (handlers, scaffolding, agent prompt text that tells an agent which file to write, and any parsing/regex that reads a chapter number back out of a filename).
3. Any code that PARSES a chapter number from a filename must accept the new 3-digit form.
4. Every test, fixture, and mock that references a chapter path must be updated to the new convention.
5. No other behavior changes.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters what they set up or assert about the renamed thing; do not weaken unrelated assertions.
When done, summarize your change briefly.
