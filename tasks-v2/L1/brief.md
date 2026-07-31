You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature: add a complete new worker mode, "documenter", to the platform. It generates repository documentation as its task. Wire it end-to-end, following the existing conventions for the six current modes (architect, planner, developer, reviewer, reviser, rebaser) at every layer:

1. packages/core/src/prompts: a `documenter.ts` module exporting `getDocumenterPrompt(params: DocumenterPromptParams)`; params must include `repoFullName: string` and `correlationId: string`. The prompt must instruct the agent to produce/refresh `docs/OVERVIEW.md` in the target repo. Re-export both from the prompts index like the other modes.
2. packages/worker/src/workers: a `DocumenterWorker` class extending `BaseWorker`, following the closest existing worker's structure.
3. packages/worker/src/entrypoint.ts: add 'documenter' to TASK_TYPES and route it in createWorker.
4. packages/core/src/queue/work-items.ts: a new work item type `GENERATE_DOCS` (base fields only), added to the discriminated union and exported like its siblings, with the type alias `GenerateDocsWorkItem`.
5. packages/cdk: the ECS task-definition construct must produce a `telos-documenter` family with 1 vCPU / 4096 MB (same tier as reviewer), an awslogs log group `/telos/ecs/documenter`, and whatever wiring the other six families get.
6. Tests: extend existing test files to cover the new mode at the same depth its siblings enjoy (entrypoint routing, schema acceptance/rejection, CDK counts and properties). Update any test whose assertion is now stale because a count changed (e.g. "creates 6 ECS task definitions"). This is the ONE exception to the no-test-edits rule: counts/enumerations that the feature legitimately changes. Do not weaken unrelated assertions.

Verify with: pnpm -s test (full suite green, including your new coverage).
Keep the implementation idiomatic and consistent with neighboring code.
When done, summarize your change briefly.
