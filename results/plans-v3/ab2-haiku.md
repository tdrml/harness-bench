Based on my analysis of the codebase, here's the implementation plan:

---

# Implementation Plan: Add Location Tracking to ContinuityState

## Spec-critical details

- Field name: `locations`
- Field type: `Record<string, string>` (location name → most recent chapter-N description)
- Merge strategy: object spread, update wins on key conflicts, existing preserved when update omits the field
- Prune behavior: kept in full (not truncated), same as `characters` and `worldState`
- Deserialization default: `{}` for backward compatibility with previously persisted states
- Test compilation requirement: all construction sites must be updated or suite will fail
- No tests should be weakened; only existing setup changes allowed

## Ordered steps

### 1. `packages/core/src/writing/types.ts`
**What:** Add `locations` field to `ContinuityState` interface.
**Pattern:** Follow `worldState` field on line 34 (peer to existing fields, Record type).

### 2. `packages/core/src/writing/continuity.ts` — `mergeContinuityState` function
**What:** Add locations merging logic.
**Pattern:** Follow `worldState` merging at lines 89–92 (ternary on undefined, spread merge). Locations should update same way: when `update.locations` is provided, merge with spread; otherwise preserve existing.

### 3. `packages/core/src/writing/continuity.ts` — `pruneContinuityState` function
**What:** Include `locations` in return object, keep in full.
**Pattern:** Follow line 71 (direct assignment like `characters` and `worldState`).

### 4. `packages/core/src/writing/__tests__/writing.test.ts`
**What:** Update all ContinuityState fixtures (`baseContinuity` at line 17, `largeContinuity` at line 165, all `Partial<ContinuityState>` updates).
**Pattern:** Add `locations: {}` to each object literal. No behavior changes to assertions.

### 5. `packages/core/src/prompts/__tests__/prompts.test.ts`
**What:** Update `baseContinuityState` fixture at line 25.
**Pattern:** Add `locations: {}` to object literal.

### 6. `packages/lambdas/src/handlers/continuity-check.ts`
**What:** Update `EMPTY_CONTINUITY_STATE` constant at line 16 and add backward-compatibility default at line 68.
**Pattern for const:** Add `locations: {}` to object literal.
**Pattern for JSON.parse:** Change `JSON.parse(stateContent) as ContinuityState` to `{ locations: {}, ...JSON.parse(stateContent) }` to ensure persisted states without locations get the default.

### 7. `packages/lambdas/src/handlers/review-chapter.ts`
**What:** Update `EMPTY_CONTINUITY_STATE` at line 16 and add backward-compatibility default at line 69.
**Pattern:** Same as step 6 (const and JSON.parse).

### 8. `packages/lambdas/src/handlers/trigger-chapter.ts`
**What:** Update `EMPTY_CONTINUITY_STATE` at line 17 and add backward-compatibility default at line 79.
**Pattern:** Same as step 6 (const and JSON.parse).

### 9. `packages/worker/src/workers/continuity-checker.ts`
**What:** Update `EMPTY_STATE` at line 8 and add backward-compatibility default at line 35.
**Pattern for const:** Add `locations: {}` to object literal.
**Pattern for JSON.parse:** Change line 35 to `{ locations: {}, ...JSON.parse(...) }`.
**Note:** Line 30 (delta parse) is `Partial<ContinuityState>`, so no default needed there.

## Consistency sweep

- [ ] All five `EMPTY_*_STATE` constants updated with `locations: {}`
- [ ] All three test file fixtures updated (`baseContinuity`, `largeContinuity`, `baseContinuityState`)
- [ ] All `Partial<ContinuityState>` update objects in tests include `locations: {}` (or properly omit it to test preservation)
- [ ] All five JSON.parse sites for full state (not delta) use spread merge default: `{ locations: {}, ...JSON.parse(...) }`
- [ ] `mergeContinuityState` function updated to handle locations
- [ ] `pruneContinuityState` function updated to include locations in return
- [ ] Type definition includes `locations` field
- [ ] No test assertions weakened (all `.toHaveLength()`, `.toEqual()`, `.toContain()` remain intact)

## Acceptance checklist

1. **Compilation succeeds:** Run `pnpm -s build` — no TypeScript errors.
2. **Full test suite passes:** Run `pnpm -s test` — all tests green, including writing, prompts, lambdas, and worker packages.
3. **Merge behavior verified:** Inspect writing.test.ts results — `mergeContinuityState` preserves existing locations when update omits the field, updates on key conflict.
4. **Prune behavior verified:** Inspect writing.test.ts results — `pruneContinuityState` keeps all locations (no truncation).
5. **Backward compatibility verified:** Confirm JSON.parse sites use spread default `{ locations: {}, ... }` so old persisted states load without error.
6. **No test weakening:** Verify no test assertions were modified beyond what schema changes require; all counts, error types, and conditions unchanged.