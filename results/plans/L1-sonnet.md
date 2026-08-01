# Implementation Plan: `documenter` Worker Mode

## 1. Spec-critical details

- New mode name (kebab/lowercase everywhere): `documenter`. Matches the string used for `TASK_TYPE` env var, ECS `taskType`, and the CDK `TaskType` union member.
- Prompt module: `packages/core/src/prompts/documenter.ts`, function `getDocumenterPrompt`, params interface `DocumenterPromptParams`.
- `DocumenterPromptParams` **must** include `repoFullName: string` and `correlationId: string` — this is a deliberate deviation from every sibling prompt (none of the other six take these). Both fields must actually be interpolated into the returned prompt string (e.g. in an "Input Context" section), not just declared and left unused — Biome's `noUnusedVariables` (recommended rules, enabled in `biome.json`) will fail the lint step otherwise if they're destructured but unused.
- The prompt must instruct the agent to produce/refresh `docs/OVERVIEW.md` (exact path, exact filename — matches this repo's own root `docs/OVERVIEW.md` convention).
- Re-export from `packages/core/src/prompts/index.ts`: `export { getDocumenterPrompt } from './documenter.js';` and `export type { DocumenterPromptParams } from './documenter.js';`. No further action needed for `@telos/core` top-level export — `packages/core/src/index.ts` already does `export * from './prompts/index.js'`.
- Worker class: `DocumenterWorker extends BaseWorker`, file `packages/worker/src/workers/documenter-worker.ts`, default-exports `new DocumenterWorker()` like all six siblings.
- `TASK_TYPES` in `packages/worker/src/entrypoint.ts`: add `'documenter'` (array order doesn't matter functionally, but append at the end after `'rebaser'` to match brief's ordering: architect, planner, developer, reviewer, reviser, rebaser, **documenter**).
- `createWorker` switch: add `case 'documenter': return new DocumenterWorker();`.
- Work item type: literal string `'GENERATE_DOCS'` (matches the `GENERATE_ARCHITECTURE` / `SCREAMING_SNAKE_CASE` naming convention), base fields only (`type`, `projectId`, `repoFullName`, `correlationId` — no extra fields, same shape as `GenerateArchitectureSchema`/`PlanTasksSchema`/`ReconcileSchema`).
- Type alias: `GenerateDocsWorkItem = z.infer<typeof GenerateDocsSchema>`, exported from both `work-items.ts` and re-exported from `packages/core/src/queue/index.ts`.
- CDK ECS task definition: family name **exactly** `telos-documenter` (from the `family: \`telos-${taskType}\`` template — this falls out automatically once `'documenter'` is added to `TaskType`/`TASK_CONFIGS`).
- CDK sizing: `cpu: 1024`, `memoryMiB: 4096` — same tier as `reviewer` (and `architect`, `planner`, `rebaser`).
- CDK log group: `/telos/ecs/documenter` (falls out automatically from `logGroupName: \`/telos/ecs/${taskType}\`` once added to the loop-driven config).
- **Explicit non-goals** (in the six-file/six-test scope only — do not touch these, they are out of scope per the brief and touching them is unrequested extra work):
  - `packages/cdk/lib/constructs/step-functions.ts` (`WORK_ITEM_TYPES`, `ECS_BACKED_TYPES`) — `GENERATE_DOCS` is not wired into the Step Functions router. No Lambda handler is being added for it.
  - `packages/cdk/lib/constructs/lambda-functions.ts` (`HandlerName` list) — same reason, no new Lambda handler.
  - `packages/lambdas/src/shared/ecs-task-runner.ts` (`EcsTaskType` union) — this is a separate, independently-declared six-member union used only by Lambda handlers that `startEcsTask(...)` for the six routed types; nothing currently calls `startEcsTask({ taskType: 'documenter' })`, so it must NOT be touched.
  - Do not add a `documenter`/`generate-docs` entry to any Lambda-handler-name list, dashboard, or alarm.

## 2. Ordered steps

1. **`packages/core/src/prompts/documenter.ts`** (new file). Pattern file: `packages/core/src/prompts/architect.ts` — closest analog because it also writes a single docs file and pushes straight to `main` (no PR, no branch), unlike developer/reviser which open PRs.
   - `export interface DocumenterPromptParams { repoFullName: string; correlationId: string; repoStructure?: string; existingOverview?: string; }` (optional `repoStructure`/`existingOverview` mirrors `ArchitectPromptParams`' optional `repoStructure`/`existingDocs` — same "include a section only if provided" idiom).
   - `getDocumenterPrompt(params)`: Role = "expert technical writer / documentarian responsible for keeping `docs/OVERVIEW.md` accurate as the codebase evolves." Allowed Operations: read any file, write `docs/OVERVIEW.md`, run `git add docs/OVERVIEW.md && git commit`, read-only shell exploration. Prohibited Operations: don't modify source code, don't commit secrets, don't push to any branch other than main is NOT applicable here — mirror architect's wording ("Do not push to any branch" is wrong for architect too... check: architect's Prohibited list actually says "Do not push to any branch" yet ArchitectWorker itself pushes to main after Claude commits. Re-read: the prompt tells Claude not to push — the *worker* code does the push after verifying the file, exactly like ArchitectWorker. Follow that same split of responsibility: prompt commits only, worker pushes).
   - Security Guardrails: same boilerplate as architect (no secrets/credentials/internal addresses/least-privilege phrasing) — tests check for `secret` substring like every other prompt test, so keep it.
   - Input Context section: interpolate `repoFullName` (e.g. `### Repository\n\`${repoFullName}\``) and `correlationId` (e.g. as a traceability note, not meant to appear inside the generated doc) plus the optional `repoStructure`/`existingOverview` sections using the same ternary-to-empty-string idiom as `architect.ts` lines 10–16.
   - Task section: what `docs/OVERVIEW.md` should cover (purpose, architecture, key modules/packages, how to run/test, entry points) — reuse the numbered-list style from `architect.ts`'s HLD section, adapted for a repo overview rather than a design doc.
   - Expected Output Format: JSON `{ "overviewPath": "docs/OVERVIEW.md", "summary": "<one-sentence summary>" }` — mirrors architect's `{ hldPath, summary }` exactly, renamed.
   - Write the doc to `docs/OVERVIEW.md`, commit with message `docs: update repository overview` (state this literal message in the prompt, since the worker will match/reuse it — see step 2).

2. **`packages/core/src/prompts/index.ts`**: add the `getDocumenterPrompt` / `DocumenterPromptParams` export pair, following the exact two-line-per-mode pattern already there (see lines 1–17). Alphabetical/enumeration order doesn't matter to tests; append after the `rebaser` pair for readability, matching the six-mode ordering used elsewhere.

3. **`packages/worker/src/workers/documenter-worker.ts`** (new file). Pattern file: `packages/worker/src/workers/architect-worker.ts` — copy its structure closely:
   - `validateInput`: **do not** require `repoOwner`/`repoName` from `input` — `GENERATE_DOCS` work items carry base fields only, and `WorkerContext` already supplies `repoFullName`/`correlationId` (confirmed no other worker currently reads `context.repoFullName`/`context.correlationId`, but `DocumenterWorker` should be the first to, since it has nothing else to derive them from). If `input` needs no fields at all, `validateInput` can be a no-op/trivial pass-through — don't invent required fields that don't exist. Do not throw `PermanentError` for fields that are never provided.
   - `run(input, context)`: use `context.repoFullName` and `context.correlationId` directly (no `repoOwner`/`repoName` concatenation like architect does).
   - `gh auth setup-git` → `this.cloneRepo(context.repoFullName, { depth: 1 })` (shallow, same as architect/reviewer).
   - `this.getRepoStructure(workDir)` to build the optional `repoStructure` prompt param (same as architect).
   - Optionally read an existing `docs/OVERVIEW.md` (if present) via `readFile` (catch/ignore ENOENT) to populate `existingOverview`, mirroring architect's `existingDocs` param usage pattern (architect's own worker doesn't actually pass `existingDocs` today — check before copying blindly; if architect-worker.ts doesn't wire it, it's fine to skip `existingOverview` wiring in the worker too and just leave it as an unused-by-worker optional param, OR wire it up since it's genuinely useful for a "refresh" mode — prefer wiring it since the brief says "produce/refresh").
   - Call `getDocumenterPrompt({ repoFullName: context.repoFullName, correlationId: context.correlationId, repoStructure, existingOverview })`.
   - `userPrompt`: instruct Claude to analyze the repo and write/refresh `docs/OVERVIEW.md` per the system prompt, matching architect's userPrompt phrasing style.
   - `this.runClaudeCode(systemPrompt, userPrompt, workDir)`, then `parseJsonOutput` (copy architect's tolerant JSON-parse-with-regex-fallback helper verbatim — it's private per-class, not shared, so duplicate it exactly as architect/reviewer do).
   - Verify `docs/OVERVIEW.md` exists and is non-empty via `readFile`, throwing `PermanentError` if missing/empty — same as architect's HLD verification (lines 39–48).
   - Commit with `git add docs/OVERVIEW.md && git commit -m 'docs: update repository overview'`, tolerating "nothing to commit" — copy architect's try/catch block (lines 50–63) verbatim, adjusting the file path and commit message.
   - Push to `origin main` — copy architect's push block (lines 65–71) verbatim.
   - Return `{ overviewPath, summary, overviewContent }` (renamed from architect's `hldPath`/`hldContent`).
   - `export default new DocumenterWorker();` at the end.

4. **`packages/worker/src/entrypoint.ts`**:
   - Add `import { DocumenterWorker } from './workers/documenter-worker.js';` (alphabetical with the existing import block, between `DeveloperWorker` and `PlannerWorker` — matches the existing alphabetical-by-class-name import ordering).
   - Add `'documenter'` to the `TASK_TYPES` tuple.
   - Add `case 'documenter': return new DocumenterWorker();` to `createWorker`'s switch, in the same relative position as the import.

5. **`packages/core/src/queue/work-items.ts`**:
   - Add `const GenerateDocsSchema = WorkItemBaseSchema.extend({ type: z.literal('GENERATE_DOCS') });` — placed near `GenerateArchitectureSchema`/`ReconcileSchema` (base-fields-only siblings), for readability.
   - Add `GenerateDocsSchema` to the `WorkItemSchema` discriminated union array.
   - Add `export type GenerateDocsWorkItem = z.infer<typeof GenerateDocsSchema>;` alongside the other type-alias exports at the bottom of the file.

6. **`packages/core/src/queue/index.ts`**: add `GenerateDocsWorkItem` to the `export type { ... } from './work-items.js';` block (alphabetize consistently with the existing list, or append after `GenerateArchitectureWorkItem` — matches existing near-alphabetical grouping).

7. **`packages/cdk/lib/constructs/ecs-task-definitions.ts`**:
   - Add `'documenter'` to the `TaskType` union (`export type TaskType = 'architect' | 'planner' | 'developer' | 'reviewer' | 'reviser' | 'rebaser' | 'documenter';`).
   - Add `{ taskType: 'documenter', cpu: 1024, memoryMiB: 4096 }` to `TASK_CONFIGS`, placed after `'rebaser'` (or wherever reads cleanest — order doesn't affect CloudFormation output, tests check by family name not array position).
   - Nothing else in this file needs to change — the constructor loop is fully generic over `TASK_CONFIGS`, so IAM role, execution-role grant, log group, container env vars, and `taskDefinitions` map entry are all produced automatically for the new entry.

## 3. Consistency sweep

- [ ] `packages/core/src/prompts/index.ts` — `getDocumenterPrompt` + `DocumenterPromptParams` exported.
- [ ] `packages/core/src/index.ts` — no change needed (already `export *`s the prompts barrel); verify by importing `getDocumenterPrompt` from `@telos/core` in the new test file.
- [ ] `packages/worker/src/entrypoint.ts` — `TASK_TYPES` tuple, `createWorker` switch, and the `DocumenterWorker` import all updated together.
- [ ] `packages/core/src/queue/work-items.ts` — schema added to discriminated union array (not just declared — easy to forget the array push).
- [ ] `packages/core/src/queue/index.ts` — `GenerateDocsWorkItem` type re-exported (grep the file for every other `*WorkItem` name to confirm none were missed).
- [ ] `packages/cdk/lib/constructs/ecs-task-definitions.ts` — `TaskType` union AND `TASK_CONFIGS` array both updated (one without the other silently type-errors or silently omits the family).
- [ ] `packages/cdk/__tests__/telos-stack.test.ts`:
  - [ ] `'creates 6 ECS task definitions'` → update count to **7** and the test title/comment.
  - [ ] `'creates ECS task definition for each worker type'` → add `'telos-documenter'` to the `families` array.
  - [ ] `'reviewer and rebaser task definitions have 1 vCPU and 4 GB memory'` → either extend this test's family list to include `'telos-documenter'`, or add a new assertion — brief requires documenter to be verified at "1 vCPU / 4096 MB, same tier as reviewer," so it must appear in a Cpu/Memory assertion somewhere.
  - [ ] `'creates CloudWatch log groups for all ECS task types'` → add `'documenter'` to the `taskTypes` array.
  - [ ] `'creates ECS task roles with DynamoDB access to task-outputs and task-graphs'` → the `toBeGreaterThanOrEqual(7)` becomes `toBeGreaterThanOrEqual(8)` (execution role + 7 task roles), update the comment too.
  - [ ] Snapshot test `'matches the snapshot'` — regenerate via `pnpm --filter @telos/cdk test -- -u` (or `cd packages/cdk && npx vitest run -u`) **after** all CDK construct/test-count changes are in place, then re-review the diff to confirm only the expected new `telos-documenter` resources appear (task definition, log group, IAM role, container definition) and nothing else shifted unexpectedly.
  - [ ] Grep this file for any other hardcoded `6` or the literal list `['telos-architect', 'telos-planner', ...]`/`['architect', 'planner', ...]` you may have missed — the counts above are the ones found during planning but a final grep is required since this is the "one exception to the no-test-edits rule."
- [ ] `packages/worker/__tests__/entrypoint.test.ts` — `createWorker`/`runEntrypoint` tests iterate `TASK_TYPES` generically (`for (const taskType of TASK_TYPES)`), so `'documenter'` is covered automatically once added to the tuple — no per-mode edits needed here, just confirm after the change that these loop-based tests still pass (they will, by construction).
- [ ] `packages/core/__tests__/queue.test.ts` — add a `describe('WorkItemSchema — GENERATE_DOCS', ...)` block analogous to the `GENERATE_ARCHITECTURE`/`RECONCILE` entries (add `'GENERATE_DOCS'` to the `simpleTypes` array in the `'simple types (no extra fields)'` describe block at line 56, rather than writing a whole new describe block — that's exactly how `GENERATE_ARCHITECTURE`/`PLAN_TASKS`/`CREATE_ISSUES`/`RECONCILE` are covered).
- [ ] `packages/core/__tests__/prompts.test.ts` — add a `describe('getDocumenterPrompt', ...)` block following the `describe('getArchitectPrompt', ...)` shape: non-empty string, interpolates `repoFullName`, interpolates `correlationId`, includes role definition, includes `docs/OVERVIEW.md` as output path, includes expected output format keys (`overviewPath`, `summary`), includes security guardrails (`secret`), includes prohibited operations, interpolates optional `repoStructure`/`existingOverview`, omits optional sections when not provided. Also add `getDocumenterPrompt` to the top import list.
- [ ] New file `packages/worker/__tests__/documenter-worker.test.ts` — follow `architect-worker.test.ts` structure exactly (mock `node:child_process` and `node:fs/promises`, `makeContext()`/`makeInput()` helpers, happy path, commit/push verification, "nothing to commit" tolerance, missing/empty `docs/OVERVIEW.md` → `PermanentError`, JSON-embedded-in-text parsing). Since `DocumenterWorker` sources `repoFullName`/`correlationId` from `context` (not `input`), `makeInput()` here will have fewer/no required fields than architect's — assert accordingly rather than copying architect's `validateInput` rejection tests verbatim.
- [ ] Confirm nothing in `packages/lambdas/__tests__/` references a hardcoded count of worker/task types that would need updating (spot-checked: the six-list grep earlier only matched `ecs-task-runner.ts`, `bootstrap-repo.test.ts`, `review-pr.test.ts`, `rebase-pr.test.ts`, `merge-pr.test.ts`, integration tests — none reference the CDK/prompts/worker six-count; these are exercising the existing routed lambda handlers and are correctly out of scope per section 1's non-goals).

## 4. Acceptance checklist

- [ ] `pnpm -s test` passes in full — baseline today is **37 test files / 732 tests**; expect the file count to grow by 2 (`documenter-worker.test.ts` is new) and the test count to grow by the sum of new cases added in section 3, with zero regressions in the other 35+ files.
- [ ] `pnpm --filter @telos/core test` green, specifically `prompts.test.ts` (new `getDocumenterPrompt` suite) and `queue.test.ts` (`GENERATE_DOCS` added to `simpleTypes`).
- [ ] `pnpm --filter @telos/worker test` green, specifically `entrypoint.test.ts` (passes automatically via the `TASK_TYPES` loop) and the new `documenter-worker.test.ts`.
- [ ] `pnpm --filter @telos/cdk test` green, including the regenerated snapshot — manually diff the snapshot update to confirm it only adds `telos-documenter`-related resources (1 new `AWS::ECS::TaskDefinition`, 1 new `AWS::Logs::LogGroup` at `/telos/ecs/documenter`, 1 new `AWS::IAM::Role` named `telos-documenter-task-role`) and changes no unrelated resource.
- [ ] `pnpm -r run build` (or `pnpm build` at root) succeeds — confirms no TypeScript errors across `@telos/core`, `@telos/worker`, `@telos/cdk` from the new exports/imports.
- [ ] `pnpm lint` (Biome) passes — specifically checks that `repoFullName`/`correlationId` are actually used inside `getDocumenterPrompt`, not just destructured and dropped.
- [ ] Manually verify end-to-end wiring by tracing one call path: `entrypoint.ts` `TASK_TYPES` includes `'documenter'` → `createWorker('documenter')` returns a `DocumenterWorker` → `DocumenterWorker.run` imports `getDocumenterPrompt` from `@telos/core` → CDK `telos-documenter` task definition sets `TASK_TYPE: 'documenter'` as a container env var, so a real ECS task launched from that family would route correctly through `entrypoint.ts`.
- [ ] Confirm `GENERATE_DOCS`/`GenerateDocsWorkItem` compiles and round-trips through `WorkItemSchema.parse`/`enqueueWorkItems` the same way `RECONCILE` does in `queue.test.ts`'s `enqueueWorkItems` describe block (not required to add new tests there, just confirm no type error).
- [ ] Confirm the three explicitly out-of-scope files (`step-functions.ts`, `lambda-functions.ts`, `ecs-task-runner.ts`) are **unchanged** in the final diff — `git diff --stat` should not touch these three files.