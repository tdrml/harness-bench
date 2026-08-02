You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature: every agent role prompt must end with a standardized "Definition of Done" section, sourced from ONE shared constant so the wording can never drift between roles.

Requirements:
1. Add a single exported constant `DEFINITION_OF_DONE` to the shared prompt module (packages/core/src/prompts/shared.ts) whose value is exactly this markdown block:

## Definition of Done

- The working tree is clean and all changes are committed
- The full test suite passes locally before you report completion
- You have not modified any test to make it pass
- You state explicitly what you verified and how

2. Every one of the SIX role prompt builders must append this exact block to the end of the prompt it returns: architect, planner, developer, reviewer, reviser, rebaser. Each builder must reference the shared constant - do not copy the text into individual files.
3. The block must appear exactly once per prompt, and must be the final content of the returned string (trailing whitespace is fine).
4. No other prompt content changes.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters what they assert; do not weaken unrelated assertions.
When done, summarize your change briefly.
