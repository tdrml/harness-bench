You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature: add location tracking to the continuity system in packages/core/src/writing.

1. `ContinuityState` (types.ts) gains a required field `locations: Record<string, string>` (location name → most recent chapter-N description). Every place that CONSTRUCTS a ContinuityState - production code, fixtures, tests - must be updated so the suite compiles and passes.
2. `mergeContinuityState`: locations merge like worldState - object spread, update wins on key conflicts, existing preserved when update omits the field.
3. `pruneContinuityState`: locations are kept in full (like characters and worldState), never truncated.
4. Any schema/serialization surface that round-trips ContinuityState must include the new field with a default of `{}` for backward compatibility with previously persisted states.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters their setup (signatures, fixtures, counts); do not weaken what they assert. Add tests for new behavior at the depth of neighboring tests.
When done, summarize your change briefly.
