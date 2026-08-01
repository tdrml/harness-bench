I have everything needed. Here's the plan.

---

# Plan: Support `review_requested` on `pull_request` webhook events

## 1. Spec-critical details

- Event type gated on: `x-github-event: pull_request` header (existing routing pattern — compare to `'issues'`, `'issue_comment'`).
- Action gate: only `action === 'review_requested'` proceeds; every other `pull_request` action → **200**, body `{ status: 'ignored' }` (note: **not** `{ ignored: true }` — that shape is only used by the generic unhandled-event fallback and the `issues`/`issue_comment` ignored branches; this new branch uses a different shape by spec).
- Unknown PR (no task with matching `prNumber`) → **200**, body `{ status: 'ignored', reason: 'unknown pr' }`.
- Match found → enqueue exactly **one** `REVIEW_PR` work item, then respond **202**, body `{ status: 'queued' }`.
- `REVIEW_PR` work item shape (already defined in `packages/core/src/queue/work-items.ts:39-43`, do not modify): `{ type: 'REVIEW_PR', projectId, repoFullName, correlationId, taskId, prNumber }`.
  - `projectId` and `taskId` come from the **matched task**, not freshly generated.
  - `repoFullName` comes from the already-validated top-level `repository.full_name` (same variable already in scope in the handler).
  - `prNumber` comes from the webhook payload (`pull_request.number`), must be a `number`.
  - `correlationId` is a **fresh** `uuidv4()` — do not reuse any other id.
- New task-graphs lookup helper: name it `findTaskByPrNumber(prNumber: number): Promise<Task | undefined>` on `TaskGraphsService` (packages/core/src/dynamodb/task-graphs.ts). No such method exists today — `getGraph`/`getTask` both require `projectId`, which the webhook does not have.
- No DynamoDB GSI exists for `prNumber`, and none should be added for this feature — the table is keyed by `projectId`+`taskId` only (see `packages/cdk/lib/constructs/dynamodb-tables.ts:26-31`). The helper must do a paginated `ScanCommand` with `FilterExpression: 'prNumber = :prNumber'`, following the pagination style already used in `getGraph`/`listProjectsByStatus` (loop on `LastEvaluatedKey`).
- No CDK/IAM changes needed: `webhook-handler` already has `DYNAMODB_TABLE_TASK_GRAPHS` in its environment and already receives `grantReadWriteData` on `taskGraphsTable` (`packages/cdk/lib/constructs/lambda-functions.ts:74`, `:90-96`, `:120-122`) — that grant covers `Scan`. Confirm this, don't add anything.
- Signature validation, JSON parsing, and `repository` field validation at the top of the handler must run unchanged and **before** any `pull_request` branching (they already do — don't move them).
- All other event branches (`issues`, `issue_comment`, and the generic fallback) must keep returning exactly what they return today, including the literal `{ ignored: true }` shape.

## 2. Ordered steps

1. **`packages/core/src/dynamodb/task-graphs.ts`**
   - Import `ScanCommand` alongside the existing `BatchWriteCommand, GetCommand, QueryCommand, UpdateCommand` import from `@aws-sdk/lib-dynamodb`.
   - Add `findTaskByPrNumber(prNumber: number): Promise<Task | undefined>` to `TaskGraphsService`, modeled on the pagination loop in `getGraph` (lines 51-69): loop `ScanCommand({ TableName: this.tableName, FilterExpression: 'prNumber = :prNumber', ExpressionAttributeValues: { ':prNumber': prNumber }, ExclusiveStartKey: lastEvaluatedKey })`, return the first item found (`result.Items?.[0] as Task`) if present, otherwise continue paging via `LastEvaluatedKey`; return `undefined` if the scan completes with no match.

2. **`packages/core/__tests__/dynamodb.test.ts`** (recommended — every other `TaskGraphsService` method in this file has dedicated unit tests, e.g. `getGraph queries by projectId` at line 217 and `getGraph paginates using LastEvaluatedKey` at line 227; add matching coverage for `findTaskByPrNumber` so the method isn't the one uncovered exception):
   - One test: scan resolves with a matching item → returns that task.
   - One test: scan resolves with no items → returns `undefined`.
   - One test: pagination — first page empty, `LastEvaluatedKey` set, second page has the match — mirrors the `getGraph paginates using LastEvaluatedKey` test structure exactly (same `sendFn.mockResolvedValueOnce(...).mockResolvedValueOnce(...)` pattern).

3. **`packages/lambdas/src/handlers/webhook-handler.ts`**
   - Add module-level `dynamoClient` and `taskGraphsService`, and import `createDynamoDBClient`, `TaskGraphsService` from `@telos/core` (add to the existing `import { enqueueWorkItems, getConfig } from '@telos/core'` line). Follow the exact module-level-client pattern used in `packages/lambdas/src/handlers/reconcile.ts:16-24` and `review-pr.ts:15-20` (clients/services created once, outside the handler, for warm-invocation reuse) — do **not** construct these inside the handler body.
   - Add a new `if (githubEvent === 'pull_request') { ... }` block. Place it after the `issue_comment` block (currently ending at line 226) and before the final fallback `return respond(200, { ignored: true });` (line 228) — that fallback must remain for genuinely unhandled event types (e.g. `ping`, `push`).
   - Inside the block:
     - Read `action = p['action']`. If `action !== 'review_requested'`, `return respond(200, { status: 'ignored' });`.
     - Extract `pull_request` sub-object the same defensive way `issue`/`comment` are extracted elsewhere in this file (null/object/array guard → `respond(400, { error: '...' })` on failure, matching the existing style at lines 120-124 and 164-173).
     - Extract `prNumber = pullRequest['number']`; if not `typeof === 'number'`, `return respond(400, { error: 'Missing pull_request.number' })` (same style as the `issueNumber` check at lines 128-130).
     - `repoFullName` is already validated and in scope from the top of the handler — reuse it, don't re-derive it from the `pull_request` payload.
     - Call `await taskGraphsService.findTaskByPrNumber(prNumber)`. If no task, `return respond(200, { status: 'ignored', reason: 'unknown pr' });`.
     - Otherwise generate `const correlationId = uuidv4();` and call `enqueueWorkItems([{ type: 'REVIEW_PR', projectId: task.projectId, repoFullName, correlationId, taskId: task.taskId, prNumber }], sqsClient);`, then `return respond(202, { status: 'queued' });`.

4. **`packages/lambdas/__tests__/webhook-handler.test.ts`**
   - Add a `@telos/core` mock block using the `importOriginal` spread pattern from `packages/lambdas/__tests__/reconcile.test.ts:58-81` (or `review-pr.test.ts:48`), so `enqueueWorkItems`/`getConfig` stay real (this file currently relies on the real `enqueueWorkItems` hitting the mocked `SQSClient`) and only `createDynamoDBClient` and `TaskGraphsService` are overridden:
     ```
     const mockFindTaskByPrNumber = vi.fn();
     vi.mock('@telos/core', async (importOriginal) => {
       const actual = await importOriginal<typeof import('@telos/core')>();
       return {
         ...actual,
         createDynamoDBClient: vi.fn(() => ({})),
         TaskGraphsService: vi.fn(() => ({ findTaskByPrNumber: mockFindTaskByPrNumber })),
       };
     });
     ```
     Place this mock block near the other `vi.mock` calls (before the `const { handler } = await import(...)` line), and reset/default `mockFindTaskByPrNumber` in `beforeEach` alongside the existing `vi.clearAllMocks()`.
   - **Update** the existing test `'returns 200 { ignored: true } for pull_request events'` (lines 225-238, in the `unsupported events` describe block): the action used there is `'opened'`, which now goes through the new branch and returns `{ status: 'ignored' }`, not `{ ignored: true }`. Update the expected body accordingly. This is a required correction to match the new spec'd shape, not a "weakening" — the old assertion is simply wrong for the new behavior. Do not delete the test; fix its expectation.
   - Add a new `describe('pull_request review_requested → REVIEW_PR', ...)` block (mirroring the style of `issues labeled kickoff → BOOTSTRAP_PROJECT` / `issue_comment /retry → TRIGGER_TASK` blocks) with three tests:
     1. **Wrong action ignored**: `action: 'synchronize'` (or similar, not `review_requested`) with a valid `pull_request` object → expect `statusCode: 200`, body `{ status: 'ignored' }`; assert `mockFindTaskByPrNumber` and `mockSqsSend` were **not** called.
     2. **Unknown PR ignored**: `action: 'review_requested'`, valid `pull_request: { number: N }`; `mockFindTaskByPrNumber.mockResolvedValueOnce(undefined)` → expect `statusCode: 200`, body `{ status: 'ignored', reason: 'unknown pr' }`; assert `mockSqsSend` not called.
     3. **Matching PR enqueues REVIEW_PR**: `action: 'review_requested'`, `pull_request: { number: N }`, `repository.full_name: 'acme/myapp'`; `mockFindTaskByPrNumber.mockResolvedValueOnce({ projectId: 'proj-1', taskId: 'task-9', prNumber: N, title: 't', description: 'd', status: 'REVIEW', dependsOn: [], riskLevel: 'Low', order: 0 })` → expect `statusCode: 202`, body `{ status: 'queued' }`; assert `mockSqsSend` called **exactly once** (`toHaveBeenCalledOnce()`, matching the assertion style at line 336); parse the single SQS entry's `MessageBody` and assert `type === 'REVIEW_PR'`, `projectId === 'proj-1'`, `taskId === 'task-9'`, `prNumber === N`, `repoFullName === 'acme/myapp'`, and `correlationId === 'test-uuid'` (the `uuid` module is already mocked file-wide to return `'test-uuid'`, line 46-48 — do not add a second uuid mock).
     - Use `makeWebhookEvent({ githubEvent: 'pull_request', body })` for all three, consistent with how other event types are tested in this file.

## 3. Consistency sweep

- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts` line ~237: existing `'returns 200 { ignored: true } for pull_request events'` test's expected body updated to `{ status: 'ignored' }` (not deleted, not left as `{ ignored: true }`).
- [ ] No other test in the repo asserts on `pull_request` webhook behavior — confirm with `grep -rn "pull_request" packages/lambdas/__tests__` that only `webhook-handler.test.ts` (and the new/updated tests there) reference it.
- [ ] `packages/core/src/queue/work-items.ts` / `ReviewPrSchema` — **unchanged**, already has the exact fields needed (`taskId`, `prNumber` + base `type/projectId/repoFullName/correlationId`); do not add fields.
- [ ] `packages/core/__tests__/queue.test.ts` — check it doesn't have an exhaustive "all producers of REVIEW_PR" style test that would need a new entry; if it only validates the schema/`enqueueWorkItems` batching mechanics, no change needed.
- [ ] `packages/cdk/lib/constructs/lambda-functions.ts` — confirm `webhook-handler` is unaffected (it already has `DYNAMODB_TABLE_TASK_GRAPHS` env var and table grants); no diff expected here. If a diff seems necessary, stop — that would mean an assumption above was wrong.
- [ ] `packages/core/src/dynamodb/index.ts` — `task-graphs.js` is already re-exported; no export list changes needed since `TaskGraphsService` is already exported.
- [ ] Any other handler that scans/queries `TaskGraphsService` by something other than `projectId` (none currently) — not applicable, just confirm no duplicate helper gets introduced (`grep -rn "findTaskByPrNumber" packages` should show exactly one definition after the change).
- [ ] `packages/lambdas/__tests__/integration/*.test.ts` — grep for `pull_request` / `review_requested` / `webhook-handler` to make sure no integration test constructs a `pull_request` payload that would now behave differently (e.g. asserting the old `{ ignored: true }` shape).

## 4. Acceptance checklist

- [ ] `pnpm --filter @telos/core exec tsc --noEmit` (or `pnpm --filter @telos/core run build`) — new `findTaskByPrNumber` compiles, `Task` import unaffected.
- [ ] `pnpm --filter @telos/lambdas exec tsc --noEmit` (or `pnpm --filter @telos/lambdas run build`) — webhook-handler compiles with new imports/branch.
- [ ] `pnpm run lint` — Biome passes on both changed files.
- [ ] `pnpm -s test` — full workspace suite green, specifically:
  - `packages/core/__tests__/dynamodb.test.ts` — new `findTaskByPrNumber` tests pass (if added).
  - `packages/lambdas/__tests__/webhook-handler.test.ts` — all existing tests still pass **including** the corrected `pull_request` ignored-body test, plus the 3 new `review_requested` tests.
- [ ] Manually re-read the 3 new tests against the brief's exact wording: wrong action → ignored (no enqueue call); unknown PR → ignored with `reason: 'unknown pr'` (no enqueue call); matching PR → exactly one `REVIEW_PR` item shaped with `projectId`, `repoFullName`, `taskId`, `prNumber`, `correlationId`, and a 202 response.
- [ ] Confirm no other `pull_request`-action test regressed by diffing `git diff -- packages/lambdas/__tests__/webhook-handler.test.ts` and checking only the one expected line changed plus new tests were added (no other existing assertions touched).
- [ ] Confirm the module-level `dynamoClient`/`taskGraphsService` in `webhook-handler.ts` are constructed once at module scope, not per-invocation (matches Lambda warm-start conventions used by every other handler in this package).