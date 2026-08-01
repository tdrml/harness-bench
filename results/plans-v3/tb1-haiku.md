# Implementation Plan: DynamoDB Service Constructor Refactor

## Spec-critical details

- `ProjectsService` uses config key: `DYNAMODB_TABLE_PROJECTS` (default: `'telos-projects'`)
- `TaskGraphsService` uses config key: `DYNAMODB_TABLE_TASK_GRAPHS` (default: `'telos-task-graphs'`)
- `RunsService` uses config key: `DYNAMODB_TABLE_RUNS` (default: `'telos-runs'`)
- `TaskOutputsService` uses config key: `DYNAMODB_TABLE_TASK_OUTPUTS` (default: `'telos-task-outputs'`)
- `RepoLocksService` uses config key: `DYNAMODB_TABLE_REPO_LOCKS` (default: `'telos-repo-locks'`)
- Each constructor becomes: `constructor(client: DynamoDBDocumentClient, tableName: string)`
- Each constructor must NOT call `getConfig()` at any point
- Callers must pass `getConfig().DYNAMODB_TABLE_*` as the second argument
- Runtime behavior (commands, table names, errors) must remain identical
- All 48+ test instantiations must be updated to pass table names

## Ordered steps

### 1. Update service class signatures (packages/core/src/dynamodb)

**File: `packages/core/src/dynamodb/projects.ts`**
- Change line 15 constructor parameter: remove `this.client` in parameter list, add `tableName: string` parameter
- Remove lines 13–16 (private tableName and the constructor body getConfig call)
- Add line after constructor parameters: assign `this.tableName = tableName;`
- Pattern: same as neighboring conditional-expression updates in this repo (parameter pass-through)

**File: `packages/core/src/dynamodb/task-graphs.ts`**
- Same pattern as projects.ts — update constructor to accept tableName parameter, remove getConfig() call

**File: `packages/core/src/dynamodb/runs.ts`**
- Same pattern as projects.ts — update constructor to accept tableName parameter, remove getConfig() call

**File: `packages/core/src/dynamodb/task-outputs.ts`**
- Same pattern as projects.ts — update constructor to accept tableName parameter, remove getConfig() call

**File: `packages/core/src/dynamodb/repo-locks.ts`**
- Same pattern as projects.ts — update constructor to accept tableName parameter, remove getConfig() call
- Note: This file calls `getConfig()` again in `acquireLock()` method (line 20) — leave this unchanged; only remove the constructor-time call

### 2. Update Lambda handler instantiations (packages/lambdas/src/handlers)

Each handler follows the pattern: import `getConfig`, call it once per module, then instantiate services with config values.

**File: `packages/lambdas/src/handlers/bootstrap-project.ts`**
- Add to imports: `getConfig` (if not already imported)
- At line 16 where dynamoClient is created: add `const config = getConfig();` right after
- Line 16 → change to: `const projectsService = new ProjectsService(dynamoClient, config.DYNAMODB_TABLE_PROJECTS);`
- Pattern: same import/config style as in `ecs-task-runner.ts` (line 44–50)

**File: `packages/lambdas/src/handlers/bootstrap-repo.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const projectsService = new ProjectsService(dynamoClient, config.DYNAMODB_TABLE_PROJECTS);`

**File: `packages/lambdas/src/handlers/create-issues.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const taskGraphsService = new TaskGraphsService(dynamoClient, config.DYNAMODB_TABLE_TASK_GRAPHS);`

**File: `packages/lambdas/src/handlers/generate-architecture.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const projectsService = new ProjectsService(dynamoClient, config.DYNAMODB_TABLE_PROJECTS);`

**File: `packages/lambdas/src/handlers/merge-pr.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const taskGraphsService = new TaskGraphsService(dynamoClient, config.DYNAMODB_TABLE_TASK_GRAPHS);`

**File: `packages/lambdas/src/handlers/plan-tasks.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update 4 instantiations:
  - `projectsService` → pass `config.DYNAMODB_TABLE_PROJECTS`
  - `taskGraphsService` → pass `config.DYNAMODB_TABLE_TASK_GRAPHS`
  - `runsService` → pass `config.DYNAMODB_TABLE_RUNS`
  - `taskOutputsService` → pass `config.DYNAMODB_TABLE_TASK_OUTPUTS`

**File: `packages/lambdas/src/handlers/quick-task.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update 2 instantiations:
  - `projectsService` → pass `config.DYNAMODB_TABLE_PROJECTS`
  - `taskGraphsService` → pass `config.DYNAMODB_TABLE_TASK_GRAPHS`

**File: `packages/lambdas/src/handlers/rebase-pr.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const taskGraphsService = new TaskGraphsService(dynamoClient, config.DYNAMODB_TABLE_TASK_GRAPHS);`

**File: `packages/lambdas/src/handlers/reconcile-enqueuer.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const projectsService = new ProjectsService(dynamoClient, config.DYNAMODB_TABLE_PROJECTS);`

**File: `packages/lambdas/src/handlers/reconcile.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update 3 instantiations:
  - `projectsService` → pass `config.DYNAMODB_TABLE_PROJECTS`
  - `taskGraphsService` → pass `config.DYNAMODB_TABLE_TASK_GRAPHS`
  - `runsService` → pass `config.DYNAMODB_TABLE_RUNS`

**File: `packages/lambdas/src/handlers/review-pr.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const taskGraphsService = new TaskGraphsService(dynamoClient, config.DYNAMODB_TABLE_TASK_GRAPHS);`

**File: `packages/lambdas/src/handlers/revise-pr.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const taskGraphsService = new TaskGraphsService(dynamoClient, config.DYNAMODB_TABLE_TASK_GRAPHS);`

**File: `packages/lambdas/src/handlers/trigger-task.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update instantiation: `const taskGraphsService = new TaskGraphsService(dynamoClient, config.DYNAMODB_TABLE_TASK_GRAPHS);`

**File: `packages/lambdas/src/handlers/update-status.ts`**
- Add `getConfig` to imports
- After dynamoClient creation, add `const config = getConfig();`
- Update 2 instantiations:
  - `projectsService` → pass `config.DYNAMODB_TABLE_PROJECTS`
  - `taskGraphsService` → pass `config.DYNAMODB_TABLE_TASK_GRAPHS`

### 3. Update shared utility instantiations

**File: `packages/lambdas/src/shared/ecs-task-runner.ts`**
- Line 53 in `startEcsTask()`: change `const taskOutputsSvc = new TaskOutputsService(dbClient);` to `const taskOutputsSvc = new TaskOutputsService(dbClient, config.DYNAMODB_TABLE_TASK_OUTPUTS);`
- Line 54: change `const runsSvc = new RunsService(dbClient);` to `const runsSvc = new RunsService(dbClient, config.DYNAMODB_TABLE_RUNS);`
- Line 150 in `pollEcsTask()`: change `const runsSvc = new RunsService(dbClient);` to `const runsSvc = new RunsService(dbClient, config.DYNAMODB_TABLE_RUNS);`
- Line 151: change `const taskOutputsSvc = new TaskOutputsService(dbClient);` to `const taskOutputsSvc = new TaskOutputsService(dbClient, config.DYNAMODB_TABLE_TASK_OUTPUTS);`
- Note: `getConfig()` is already imported and `config` is already used in this file

### 4. Update worker instantiation

**File: `packages/worker/src/entrypoint.ts`**
- Add `getConfig` to imports
- At line 124 where `taskOutputsSvc` is created, change:
  - Before: `const taskOutputsSvc = new TaskOutputsService(dbClient);`
  - After: `const taskOutputsSvc = new TaskOutputsService(dbClient, getConfig().DYNAMODB_TABLE_TASK_OUTPUTS);`

### 5. Update test file

**File: `packages/core/__tests__/dynamodb.test.ts`**
- The file already defines `REQUIRED_ENV` with all table names (lines 14–31)
- For every service instantiation in tests (48+ total):
  - `new ProjectsService(client)` → `new ProjectsService(client, 'telos-projects')`
  - `new TaskGraphsService(client)` → `new TaskGraphsService(client, 'telos-task-graphs')`
  - `new RunsService(client)` → `new RunsService(client, 'telos-runs')`
  - `new TaskOutputsService(client)` → `new TaskOutputsService(client, 'telos-task-outputs')`
  - `new RepoLocksService(client)` → `new RepoLocksService(client, 'telos-repo-locks')`
- Rationale: Tests no longer rely on `getConfig()` to provide table names; pass literals directly (matching the REQUIRED_ENV values)
- No new tests required; test assertions remain valid because table name behavior is unchanged

## Consistency sweep

- [ ] All 5 service class constructors updated to accept tableName parameter and removed getConfig() calls
- [ ] All 14 Lambda handlers updated with getConfig() calls and table name arguments passed to service constructors
- [ ] ecs-task-runner.ts: both startEcsTask() and pollEcsTask() functions updated (4 instantiations total)
- [ ] worker entrypoint updated with getConfig() call and table name argument
- [ ] All 48+ test instantiations updated with hardcoded table names matching REQUIRED_ENV
- [ ] No getConfig() calls remain in any service constructor body
- [ ] No service constructor calls getConfig() directly or indirectly at instantiation time
- [ ] Handler files that don't use services (enrich-issue.ts, webhook-handler.ts) remain unchanged
- [ ] Imports of getConfig are added only where needed (handlers that instantiate services, worker entrypoint)
- [ ] No changes to service method implementations (only constructor signature changes)
- [ ] No changes to RepoLocksService.acquireLock() method's getConfig() call (line 20) — only constructor is affected

## Acceptance checklist

- [ ] Run `pnpm -s build` — completes with no errors, no TypeScript compilation errors in any package
- [ ] Run `pnpm -s test` — full test suite passes; dynamodb.test.ts all tests green
- [ ] Verify no TypeScript errors: `pnpm -s type-check` (if available) or inspect build output
- [ ] Spot-check one Lambda handler file: confirm getConfig() is called once at module level, services receive table name argument
- [ ] Spot-check test file: confirm all service instantiations pass table name as second argument
- [ ] Spot-check worker entrypoint: confirm TaskOutputsService instantiation passes table name
- [ ] Spot-check ecs-task-runner.ts: confirm both startEcsTask and pollEcsTask instantiations pass table names
- [ ] Verify runtime behavior unchanged: configs still define same table names, no runtime errors introduced
- [ ] Confirm constructor signatures of all 5 services now require tableName parameter (attempt to instantiate without it would fail type-check)