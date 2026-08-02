**Issue 7 — word-count policy consolidation**

Unrelated to the release phase, and overdue. The per-chapter word-count target is
recomputed inline in six handlers, and the tolerance around it is inconsistent in
three different ways: the writer gate in reconcile uses 0.1 with `floor`/`ceil`
rounding, the merge gate uses 0.2 with `floor`/`floor`, and the agent prompts state
different percentages again in prose. Consolidate all of it.

1. Add `packages/core/src/word-count-policy/` exporting:

```ts
export type WordCountStage = 'writer' | 'review' | 'merge';

export function resolveChapterTarget(params: {
  targetWordCount: number;
  chapterCount: number;
}): number

export function resolveWordCountRange(params: {
  targetWordCount: number;
  chapterCount: number;
  stage: WordCountStage;
}): { min: number; max: number }

export function resolveTolerance(stage: WordCountStage): number
export function formatToleranceForPrompt(stage: WordCountStage): string
```

   Pinned semantics — these replace every current variant:
   - `resolveChapterTarget` = `Math.floor(targetWordCount / chapterCount)`. If
     `chapterCount` is 0 or negative, throw an `Error`.
   - `resolveTolerance`: `writer` → `0.05`, `review` → `0.10`, `merge` → `0.20`.
   - `resolveWordCountRange` = `{ min: Math.floor(target * (1 - tolerance)),
     max: Math.ceil(target * (1 + tolerance)) }` for **every** stage. Note this
     changes the merge gate's upper bound from `floor` to `ceil`.
   - `formatToleranceForPrompt` returns `'±5%'`, `'±10%'`, `'±20%'` respectively.

   Surface the module from `@auto-graph/core` the way core's other modules are.

2. **Migrate every handler** that computes `targetWordCount / chapterCount` to
   `resolveChapterTarget`, and every handler that builds a min/max band around it
   to `resolveWordCountRange`. The writer gate in reconcile uses stage `writer`;
   the merge gate uses stage `merge`; review and revision use stage `review`.
   After this issue, no file under `packages/lambdas/src/handlers/` may contain
   the expression `targetWordCount / ` or a literal word-count tolerance.

3. **The prompts state the tolerance in English prose inside their template
   strings, and they must stop hardcoding it.** Every prompt that quotes a
   word-count tolerance must interpolate `formatToleranceForPrompt` for the stage
   that prompt belongs to: the writer prompt uses `writer`, the editor and reviser
   prompts use `review`. After this issue no prompt source file may contain a
   hardcoded tolerance percentage for word count.

4. `WORD_COUNT_DEFAULTS` in `packages/core/src/config/defaults.ts` carries
   per-project-type `chapterMin`/`chapterMax` and is currently referenced by no
   production code. Add:

```ts
export function clampToProjectType(params: {
  range: { min: number; max: number };
  projectType: ProjectType;
}): { min: number; max: number }
```

   to the new module: it clamps a resolved range into the project type's
   `[chapterMin, chapterMax]` band — `min` is raised to `chapterMin` when below it,
   `max` is lowered to `chapterMax` when above it. Wire it into the **merge** gate
   only; the other stages keep the unclamped range.

Existing tests that assert word-count boundaries will need updating where these
pinned semantics legitimately change the numbers. Do not weaken them.
