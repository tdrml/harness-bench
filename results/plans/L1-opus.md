# Implementation Plan: `documenter` worker mode

## 1. Spec-critical details

- New mode name (lowercase, everywhere it is a task type string): `documenter`
- Prompt module path: `packages/core/src/prompts/documenter.ts`
- Exported prompt function name: `getDocumenterPrompt`
- Exported params interface name: `DocumenterPromptParams`
- `DocumenterPromptParams` **must** include `repoFullName: string` and `correlationId: string` (both required, non-optional)
- Prompt must instruct the agent to produce/refresh the file path **`docs/OVERVIEW.md`** (exact string, must appear literally in the returned prompt text)
- Prompts index re-exports both the function (value export) and the params type (`export type`), matching `packages/core/src/prompts/index.ts` style, using the `.js` extension in the specifier
- Worker class name: `DocumenterWorker`, extending `BaseWorker`, file `packages/worker/src/workers/documenter-worker.ts`
- Worker module must also `export default new DocumenterWorker();` (every sibling worker does)
- `TASK_TYPES` in `packages/worker/src/entrypoint.ts` grows from 6 to **7** entries; add `'documenter'`
- `createWorker` gains `case 'documenter': return new DocumenterWorker();` before the `default:` branch
- Unknown task type still throws `PermanentError` with message `Unknown TASK_TYPE: ${taskType}` — do not change
- New work item discriminator literal: **`GENERATE_DOCS`** (exact, SCREAMING_SNAKE)
- `GenerateDocsWorkItem` type alias exported from `work-items.ts` **and** re-exported from `packages/core/src/queue/index.ts`
- `GENERATE_DOCS` schema has **base fields only**: `type`, `projectId`, `repoFullName`, `correlationId` — no `taskId`, no `prNumber`, no extras (mirror `GenerateArchitectureSchema`)
- ECS family name: **`telos-documenter`**
- ECS sizing: **cpu `1024`** (1 vCPU) / **memoryLimitMiB `4096`** — same tier as `reviewer`. In the synthesized template these appear as strings: `Cpu: '1024'`, `Memory: '4096'`
- Log group name: **`/telos/ecs/documenter`**
- Log driver: `awslogs`, `streamPrefix: 'documenter'`, retention `ONE_MONTH`, removal policy `DESTROY`
- Task role name: `telos-documenter-task-role`; container name: `telos-documenter`; construct ids derived via `toPascalCase` → `DocumenterTaskRole`, `DocumenterTaskDef`, `DocumenterLogGroup`, `DocumenterContainer`
- Runtime platform: `ARM64` / `LINUX` (inherited from the shared loop — no per-type override)
- CDK ECS task-definition count assertion changes **6 → 7**
- ECS task roles: execution role + 7 task roles; existing assertion `toBeGreaterThanOrEqual(7)` still holds (now 8) — bump to 8 and fix the "6 task roles" comment rather than leave it stale
- CDK snapshot test (`telos-stack.test.ts.snap`) **will change** and must be regenerated with `-u`
- Out of scope per the brief (do **not** add): a `documenter` entry in `EcsTaskType` in `packages/lambdas/src/shared/ecs-task-runner.ts`, a `GENERATE_DOCS` Step Functions route, a new Lambda handler. `GENERATE_DOCS` falls through `route.otherwise(unknownType)` by design.
- Formatting (biome): single quotes, trailing commas `all`, 2-space indent, line width 100

## 2. Ordered steps

### Step 1 — `packages/core/src/prompts/documenter.ts` (new)
Pattern file: `packages/core/src/prompts/architect.ts` (closest sibling — it is the other "write a doc, commit, push" prompt).

- Export `interface DocumenterPromptParams { repoFullName: string; correlationId: string; repoStructure?: string; }` — the two required fields are mandated by the brief; `repoStructure?` is optional and mirrors `ArchitectPromptParams`/`PlannerPromptParams` so the worker can pass what `getRepoStructure()` returns.
- Export `function getDocumenterPrompt(params: DocumenterPromptParams): string` returning a template literal with the same section headings the siblings use, in the same order:
  `## Role`, `## Allowed Operations`, `## Prohibited Operations`, `## Security Guardrails`, `## Input Context`, `## Task`, `## Expected Output Format`.
- Build the optional section with the same ternary idiom as `architect.ts`: `const repoSection = repoStructure ? \`\n## Repository Structure\n\`\`\`\n${repoStructure}\n\`\`\`\` : '';`
- Content requirements: interpolate `repoFullName` and `correlationId` into the Input Context; Allowed Operations must permit writing `docs/OVERVIEW.md` and committing it; Prohibited Operations must include "Do not modify source code files" / "Do not commit secrets…"; Security Guardrails must mention secrets/credentials (the sibling tests all assert on the lowercase words `secret` and `credential`).
- Task section: instruct the agent to **produce `docs/OVERVIEW.md` if absent, or refresh it if it already exists**, covering purpose, layout/packages, key components, how to build/test, and how the pieces fit together.
- Expected Output Format: JSON object with `"docsPath": "docs/OVERVIEW.md"` and `"summary"` — mirrors architect's `hldPath`/`summary` contract, which the worker's default-value handling depends on.

### Step 2 — `packages/core/src/prompts/index.ts`
Append a block at the end in the exact two-line shape of the existing six:
```
export { getDocumenterPrompt } from './documenter.js';
export type { DocumenterPromptParams } from './documenter.js';
```
No change needed in `packages/core/src/index.ts` (it already does `export * from './prompts/index.js'`).

### Step 3 — `packages/core/src/queue/work-items.ts`
Pattern: `GenerateArchitectureSchema` (lines 22–24) — the base-fields-only sibling.
- Add `const GenerateDocsSchema = WorkItemBaseSchema.extend({ type: z.literal('GENERATE_DOCS') });` — place it next to the other base-only schemas (immediately after `GenerateArchitectureSchema` reads best).
- Add `GenerateDocsSchema` to the `z.discriminatedUnion('type', [...])` array in the same relative position.
- Add `export type GenerateDocsWorkItem = z.infer<typeof GenerateDocsSchema>;` to the alias block, same relative position.

### Step 4 — `packages/core/src/queue/index.ts`
Add `GenerateDocsWorkItem` to the `export type { … } from './work-items.js';` list, keeping the same order used in `work-items.ts`.

### Step 5 — Build core before touching the worker (critical)
`@telos/core` resolves via `"main": "dist/index.js"` and there is **no vitest alias** — `packages/worker` tests import the *compiled* core. `getDocumenterPrompt` will be `undefined` at worker-test runtime until core is rebuilt. Run `pnpm -s build` after Steps 1–4 (and again after any later core edit).

### Step 6 — `packages/worker/src/workers/documenter-worker.ts` (new)
Pattern file: `packages/worker/src/workers/architect-worker.ts` — copy its structure, do not invent a new one.
- Same imports: `execFile` from `node:child_process`, `readFile` from `node:fs/promises`, `promisify`, `{ PermanentError, getDocumenterPrompt } from '@telos/core'`, `{ BaseWorker, type WorkerContext } from './base-worker.js'`; `const execFileAsync = promisify(execFile);`
- `run(input, context)` sequence, mirroring architect exactly:
  1. `const { repoOwner, repoName } = this.validateInput(input);` — private `validateInput` throwing `PermanentError('Missing or invalid input: repoOwner')` / `…repoName` for non-string/blank values.
  2. `const repoFullName = \`${repoOwner}/${repoName}\`;` and `const workDir = context.workDir;`
  3. `logger.info('Setting up git authentication')` → `await execFileAsync('gh', ['auth', 'setup-git'])`
  4. `await this.cloneRepo(repoFullName, { depth: 1 })`
  5. `const repoStructure = await this.getRepoStructure(workDir)`
  6. `const systemPrompt = getDocumenterPrompt({ repoFullName, correlationId: context.correlationId, repoStructure })` — **`correlationId` comes from `WorkerContext`, not from `input`**; `repoFullName` is the derived value used for the clone.
  7. `const claudeOutput = await this.runClaudeCode(systemPrompt, userPrompt, workDir)` with a one-line `userPrompt` in the architect style ("…Write it to docs/OVERVIEW.md and commit it. Return the JSON output as specified.")
  8. Reuse architect's `private parseJsonOutput` (copy it verbatim — it is already duplicated across workers; do not refactor it into the base class in this change), then `const docsPath = (parsed['docsPath'] as string | undefined) ?? 'docs/OVERVIEW.md';` and `summary` defaulting to `''`.
  9. Verify the file: `readFile(\`${workDir}/docs/OVERVIEW.md\`, 'utf8')` inside try/catch → `PermanentError(\`docs/OVERVIEW.md was not created: ${String(err)}\`)`; empty-after-trim → `PermanentError('docs/OVERVIEW.md is empty')`.
  10. Commit: `git add docs/OVERVIEW.md` then `git commit -m 'docs: update repository overview'`, swallowing errors whose message includes `nothing to commit` / `nothing added to commit`, else `PermanentError`.
  11. Push: `git push origin main` in try/catch → `PermanentError`.
  12. `logger.info('Documenter worker complete', { docsPath, summary })` and `return { docsPath, summary, docsContent };`
- End the file with `export default new DocumenterWorker();`

### Step 7 — `packages/worker/src/entrypoint.ts`
- Add `import { DocumenterWorker } from './workers/documenter-worker.js';` — keep imports alphabetical (biome `organizeImports`): it goes after `DeveloperWorker`, before `PlannerWorker`.
- Add `'documenter'` to the `TASK_TYPES` tuple. Recommended position: after `'developer'` if you want alphabetical-ish grouping; simplest and lowest-risk is appending after `'rebaser'`. Either is fine — no test asserts ordering.
- Add `case 'documenter': return new DocumenterWorker();` to `createWorker`, in the same relative position as in `TASK_TYPES`.
- Nothing else in `runEntrypoint` changes; the `TASK_TYPES.includes(...)` guard picks the new value up automatically.

### Step 8 — `packages/cdk/lib/constructs/ecs-task-definitions.ts`
- Extend the `TaskType` union with `| 'documenter'`.
- Add `{ taskType: 'documenter', cpu: 1024, memoryMiB: 4096 },` to `TASK_CONFIGS` — append after `rebaser` to minimize snapshot churn.
- **No other edits.** The existing `for` loop already creates the task role, SSM policy, ECR pull grant, task definition (family `telos-${taskType}`), log group (`/telos/ecs/${taskType}`), and container with the `TASK_TYPE` env var — all seven families get identical wiring for free. Resist adding special-casing.

### Step 9 — `packages/core/__tests__/prompts.test.ts`
- Add `getDocumenterPrompt` to the import list from `../src/prompts/index.js`.
- Add a `describe('getDocumenterPrompt')` block at the end, mirroring the depth of the `getArchitectPrompt` block:
  `const baseParams = { repoFullName: 'acme/app', correlationId: 'corr-123' };`
  - returns a non-empty string
  - interpolates `repoFullName` (`expect(result).toContain('acme/app')`)
  - interpolates `correlationId` (`expect(result).toContain('corr-123')`)
  - includes `docs/OVERVIEW.md` as the output path
  - includes role definition (`expect(result.toLowerCase()).toContain('document')`)
  - includes expected output format (`docsPath`, `summary`)
  - includes security guardrails (`toLowerCase()).toContain('secret')`)
  - includes prohibited operations (`toContain('do not commit')` lowercased)
  - interpolates optional `repoStructure` / omits the `Repository Structure` section when not provided (only if you kept the optional field)

### Step 10 — `packages/core/__tests__/queue.test.ts`
- Add `'GENERATE_DOCS'` to the `simpleTypes` array (line 56) — that gives the acceptance test for free, alongside its base-fields-only siblings.
- Add a dedicated `describe('WorkItemSchema — GENERATE_DOCS')` block for rejection depth, matching the shape of the other per-type blocks:
  - accepts `{ ...BASE, type: 'GENERATE_DOCS' }`
  - rejects when `projectId` is missing
  - rejects when `repoFullName` is missing
  - rejects when `correlationId` is missing

### Step 11 — `packages/worker/__tests__/entrypoint.test.ts`
- The two loops over `TASK_TYPES` (lines 95 and 300) now cover `documenter` automatically — but they only prove *something* is returned. Add explicit coverage in the `describe('createWorker')` block:
  - `expect(TASK_TYPES).toContain('documenter')`
  - import `DocumenterWorker` (`const { DocumenterWorker } = await import('../src/workers/documenter-worker.js');` alongside the existing `BaseWorker` import) and assert `expect(createWorker('documenter')).toBeInstanceOf(DocumenterWorker)`.
- Do not weaken or reshape the existing loops.

### Step 12 — `packages/worker/__tests__/documenter-worker.test.ts` (new)
Pattern file: `packages/worker/__tests__/architect-worker.test.ts` — copy its harness verbatim (hoisted `vi.mock('node:child_process')` / `vi.mock('node:fs/promises')`, `execFileSuccess` / `execFileError` helpers, `makeContext()` returning `{ repoFullName: 'owner/repo', correlationId: 'corr-123', logger: createLogger('test'), workDir: '/tmp/repo' }`, `makeInput()` returning `{ repoOwner: 'owner', repoName: 'repo' }`). Cover, at architect's depth:
- happy path returns `docsPath` / `summary` / non-empty `docsContent`
- `gh auth setup-git` runs before clone; `cloneRepo` called with `('owner/repo', { depth: 1 })`
- commits with message `docs: update repository overview` and pushes to `origin main`
- tolerates a `git commit` failure containing "nothing to commit"
- defaults `docsPath` to `docs/OVERVIEW.md` when the field is missing from Claude's output
- parses JSON embedded in surrounding text
- input validation: missing/blank `repoOwner` and `repoName` each throw `PermanentError`
- `readFile` rejecting → `PermanentError` mentioning `docs/OVERVIEW.md was not created`; empty content → `PermanentError`

### Step 13 — `packages/cdk/__tests__/telos-stack.test.ts` (count/enumeration updates only)
- Line 286–289: retitle to `creates 7 ECS task definitions` and change `resourceCountIs('AWS::ECS::TaskDefinition', 7)`.
- Line 293–300: add `'telos-documenter'` to the `families` array.
- Line 330–339: extend the 1 vCPU / 4 GB test to `['telos-reviewer', 'telos-rebaser', 'telos-documenter']` and update its title accordingly (or add a sibling `it` asserting `Family: 'telos-documenter', Cpu: '1024', Memory: '4096'` — either is acceptable; extending the array is the smaller diff).
- Line 354: add `'documenter'` to the `taskTypes` array in the log-group test, which asserts `/telos/ecs/documenter`.
- Lines 376–392: update the `// Verify 6 task roles` comment to 7 and bump `toBeGreaterThanOrEqual(7)` → `toBeGreaterThanOrEqual(8)` (execution role + 7 task roles). This strengthens, not weakens.
- Leave every other assertion in this file untouched — the Lambda count (18), DynamoDB count (5), alarm count (3), Step Functions state lists, and Pipe assertions are all unaffected by this change. If any of them fail, you changed something you should not have.

### Step 14 — Regenerate the CDK snapshot
`telos-stack.test.ts.snap` embeds the whole synthesized template, so seven new resources (task def, task role, log group, role policy) will fail `matches the snapshot`. Regenerate it with `-u` (command in §4) and eyeball the diff: it should contain **only** `Documenter*` logical ids, `telos-documenter`, and `/telos/ecs/documenter`. Any other delta means an unintended change.

## 3. Consistency sweep

- [ ] `packages/core/src/prompts/documenter.ts` created; exports both `getDocumenterPrompt` and `DocumenterPromptParams`
- [ ] `packages/core/src/prompts/index.ts` — both re-exports added, `.js` specifier, `export type` for the interface
- [ ] `packages/core/src/index.ts` — no change needed (verify `export * from './prompts/index.js'` is still present)
- [ ] `packages/core/src/queue/work-items.ts` — schema const, union member, **and** type alias (all three; missing the union member is the classic slip)
- [ ] `packages/core/src/queue/index.ts` — `GenerateDocsWorkItem` added to the re-export list
- [ ] `pnpm -s build` run after core edits so `packages/core/dist` carries `getDocumenterPrompt` (worker + lambdas tests import the compiled core, not the source)
- [ ] `packages/worker/src/workers/documenter-worker.ts` created, with `export default new DocumenterWorker();`
- [ ] `packages/worker/src/entrypoint.ts` — import added, `TASK_TYPES` has 7 entries, `createWorker` has the new `case`
- [ ] `packages/cdk/lib/constructs/ecs-task-definitions.ts` — `TaskType` union **and** `TASK_CONFIGS` both updated (the union alone silently changes nothing; the config alone fails to typecheck)
- [ ] `packages/core/__tests__/prompts.test.ts` — import + new describe block
- [ ] `packages/core/__tests__/queue.test.ts` — `simpleTypes` array + new GENERATE_DOCS describe
- [ ] `packages/worker/__tests__/entrypoint.test.ts` — explicit `documenter` routing assertions (the two `TASK_TYPES` loops pick it up automatically; confirm they still pass)
- [ ] `packages/worker/__tests__/documenter-worker.test.ts` — new file
- [ ] `packages/cdk/__tests__/telos-stack.test.ts` — count 6→7, families array, 1vCPU/4GB list, log-group taskTypes array, role-count comment + threshold
- [ ] `packages/cdk/__tests__/__snapshots__/telos-stack.test.ts.snap` — regenerated; diff contains only documenter resources
- [ ] Deliberately **unchanged**: `packages/lambdas/src/shared/ecs-task-runner.ts` (`EcsTaskType`), `packages/cdk/lib/constructs/step-functions.ts`, `packages/cdk/lib/constructs/lambda-functions.ts`, `packages/cdk/lib/constructs/monitoring.ts`, all `packages/lambdas/__tests__/**` — no Lambda handler or SFN route is in scope
- [ ] No existing assertion loosened; the only test edits are the enumerations/counts listed above plus net-new cases

## 4. Acceptance checklist

Run from the repo root.

1. **Typecheck + build (also refreshes `packages/core/dist`, which worker tests import):**
   ```
   pnpm -s build
   ```
   Expect: clean, no TS errors. If `getDocumenterPrompt` is reported missing from `@telos/core` in worker code, this step was skipped or failed.

2. **Regenerate the CDK snapshot, then inspect the diff:**
   ```
   pnpm exec vitest --workspace vitest.workspace.ts run -u packages/cdk
   git diff --stat packages/cdk/__tests__/__snapshots__/telos-stack.test.ts.snap
   git diff packages/cdk/__tests__/__snapshots__/telos-stack.test.ts.snap | grep -E '^\+' | grep -iv documenter
   ```
   Expect: the last command prints nothing but the `+++` header line — i.e. every added snapshot line relates to documenter.

3. **Full suite green:**
   ```
   pnpm -s test
   ```
   Expect: all four workspace projects pass, zero obsolete snapshots.

4. **Lint/format:**
   ```
   pnpm -s lint
   ```
   Expect: clean (single quotes, trailing commas, ≤100-col lines, organized imports).

5. **Per-requirement spot checks:**
   ```
   # 1. prompt module + index re-export + OVERVIEW.md instruction
   grep -n "getDocumenterPrompt\|DocumenterPromptParams" packages/core/src/prompts/index.ts
   grep -n "docs/OVERVIEW.md" packages/core/src/prompts/documenter.ts
   grep -n "repoFullName\|correlationId" packages/core/src/prompts/documenter.ts

   # 2. worker extends BaseWorker
   grep -n "class DocumenterWorker extends BaseWorker" packages/worker/src/workers/documenter-worker.ts

   # 3. entrypoint: 7 task types + route
   grep -n "documenter" packages/worker/src/entrypoint.ts

   # 4. work item type in all three places
   grep -n "GENERATE_DOCS\|GenerateDocs" packages/core/src/queue/work-items.ts packages/core/src/queue/index.ts

   # 5. CDK family + sizing + log group
   grep -n "documenter" packages/cdk/lib/constructs/ecs-task-definitions.ts
   grep -n "telos-documenter\|/telos/ecs/documenter" packages/cdk/__tests__/__snapshots__/telos-stack.test.ts.snap

   # 6. no out-of-scope files touched
   git status --short
   ```
   Expect from `git status --short`: exactly two new files (`documenter.ts`, `documenter-worker.ts`, plus the new worker test), and modifications limited to `prompts/index.ts`, `queue/work-items.ts`, `queue/index.ts`, `entrypoint.ts`, `ecs-task-definitions.ts`, the four test files, and the snapshot. Nothing under `packages/lambdas/`, and no other CDK construct.

6. **Sizing assertion, explicitly:** confirm the synthesized documenter task definition reports `Cpu: '1024'` / `Memory: '4096'` — covered by the extended 1 vCPU / 4 GB test in `telos-stack.test.ts`; check it names `telos-documenter` and that the test actually ran (`pnpm exec vitest --workspace vitest.workspace.ts run packages/cdk -t "1 vCPU"`).

Declare done only when steps 1, 3, and 4 all exit zero and step 2's grep shows a documenter-only snapshot diff.