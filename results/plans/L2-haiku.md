Now I have enough context. Let me write the implementation plan.

---

# Implementation Plan: Pluggable Queue Backend

## Spec-critical details

- `BATCH_SIZE` constant = 10 (maximum entries per SendMessageBatchCommand)
- `QueueBackend` interface with single method: `sendBatch(entries: Array<{ id: string; body: string; groupId: string }>): Promise<{ failedIds: string[] }>`
- `SqsQueueBackend` constructor parameter: `SQSClient`
- `SqsQueueBackend` batches internally in groups of ≤10
- `SqsQueueBackend` sets `MessageGroupId` to entry's `groupId`
- `SqsQueueBackend` reads `SQS_QUEUE_URL` from environment variable at `sendBatch` call time
- `SqsQueueBackend` preserves exact current behavior: same batching, same error handling (AWS SDK's failure semantics)
- `InMemoryQueueBackend` has public field `sent: Array<{ id: string; body: string; groupId: string }>`
- `InMemoryQueueBackend.sendBatch()` always returns `{ failedIds: [] }` (never fails)
- `enqueueWorkItems` signature: `(items: WorkItem[], backend: QueueBackend): Promise<void>`
- Entry `id` = string representation of per-batch index: `"0"` through `"9"`
- Entry `body` = `JSON.stringify(item)`
- Entry `groupId` = `item.repoFullName`
- Entry is `{ id: string; body: string; groupId: string }` (exact names)
- If `sendBatch` returns `failedIds.length > 0`, throw `RetryableError` with message naming the failed IDs
- All callers pass `backend` not `sqsClient` to `enqueueWorkItems`

## Ordered steps

### 1. **packages/core/src/queue/index.ts**
   - Add `QueueBackend` interface definition (single method `sendBatch`)
   - Add `SqsQueueBackend` class:
     - Constructor accepts `SQSClient`
     - Implements `sendBatch`: loops entries in groups of ≤10, constructs `SendMessageBatchCommand` with `QueueUrl` from `process.env['SQS_QUEUE_URL']`, calls `sqsClient.send()`
     - Preserve current entry-building logic: `Id: entry.id, MessageBody: entry.body, MessageGroupId: entry.groupId`
   - Add `InMemoryQueueBackend` class:
     - Constructor sets `this.sent = []`
     - Implements `sendBatch`: appends all entries to `sent`, returns `{ failedIds: [] }`
   - Refactor `enqueueWorkItems(items, backend)`:
     - Loop items in groups of 10
     - For each group, build entries: `{ id: String(index), body: JSON.stringify(item), groupId: item.repoFullName }`
     - Call `backend.sendBatch(entries)`
     - If result has `failedIds.length > 0`, throw `new RetryableError('Work items failed to enqueue: ${failedIds.join(', ')}')`
   - Export `QueueBackend`, `SqsQueueBackend`, `InMemoryQueueBackend` from index
   - Keep all existing exports (WorkItem types, WorkItemSchema)
   - Import `RetryableError` from `../errors/index.js`
   - Remove `SendMessageBatchCommand` and `SQSClient` type imports (no longer needed at module level, only inside SqsQueueBackend)

### 2. **packages/core/__tests__/queue.test.ts**
   - Update test helper `makeSqsClient()` → `makeBackend()`: return an object with `sendBatch: vi.fn().mockImplementation(...)` instead of mocking SQSClient
   - Update `describe('enqueueWorkItems')` test suite:
     - Change all `enqueueWorkItems(items, client)` calls to `enqueueWorkItems(items, backend)` where `backend = makeBackend()`
     - Assertion `client.send` → `backend.sendBatch`
     - Assertion `cmd.input.QueueUrl` → verify batching and entry structure instead (since batching moves into enqueueWorkItems)
     - Assertion `cmd.input.Entries[0]` → access the `entries` array passed to `sendBatch` mock
   - Keep all existing assertions about batch size (10 max), message grouping, JSON serialization, empty array, SQS_QUEUE_URL requirement
   - **Add new test group `describe('enqueueWorkItems — InMemoryQueueBackend')`:**
     - Test that `InMemoryQueueBackend` accumulates entries in `.sent`
     - Test that entries match expected structure (id, body, groupId)
     - Test that `.sent` is initially empty and grows on each call
   - **Add new test group `describe('enqueueWorkItems — failedIds handling')`:**
     - Test that if `backend.sendBatch()` returns `{ failedIds: ['5'] }`, `enqueueWorkItems` throws `RetryableError`
     - Test that error message includes the failed ID
     - Test that error is a RetryableError (check `.code === 'RETRYABLE_ERROR'`)

### 3. **packages/lambdas/src/handlers/*.ts** (all ~20 handlers)
   - Mechanical signature update only (no logic changes):
     - Line that creates `sqsClient` stays the same: `const sqsClient = new SQSClient({})`
     - Line that calls `enqueueWorkItems(followOn, sqsClient)` becomes `enqueueWorkItems(followOn, new SqsQueueBackend(sqsClient))`
     - Import `SqsQueueBackend` from `@telos/core` alongside existing imports
   - Files to update: `trigger-task.ts`, `plan-tasks.ts`, `create-issues.ts`, `generate-architecture.ts`, `quick-task.ts`, `rebase-pr.ts`, `merge-pr.ts`, `enrich-issue.ts`, `webhook-handler.ts` (3 calls), `bootstrap-project.ts`, `bootstrap-repo.ts`, `review-pr.ts` (3 calls), `revise-pr.ts`, `reconcile.ts`, `reconcile-enqueuer.ts`

### 4. **packages/lambdas/__tests__/*.test.ts** (all ~15 test files)
   - No changes to mock definitions or setup — `mockEnqueueWorkItems = vi.fn()` stays the same
   - The mock function signature already accepts `(items, backend)` because it's a generic function mock
   - No changes to assertions about what the mock was called with — it's already agnostic to argument types
   - Files that need no changes: `bootstrap-project.test.ts`, `bootstrap-repo.test.ts`, `trigger-task.test.ts`, `plan-tasks.test.ts`, `create-issues.test.ts`, `generate-architecture.test.ts`, `review-pr.test.ts`, `revise-pr.test.ts`, `rebase-pr.test.ts`, `merge-pr.test.ts`, `quick-task.test.ts`, `reconcile-enqueuer.test.ts`, `reconcile.test.ts`, `trigger-task.test.ts`, `enrich-issue.test.ts`

### 5. **packages/lambdas/__tests__/integration/helpers.ts**
   - No changes needed:
     - `enqueueWorkItems: vi.fn(async (items: Array<...>) => { enqueuedItems.push(...items); })` remains unchanged
     - The mock's signature is generic; it already receives `(items, backend)` and discards the backend, appending items to `enqueuedItems`
     - This is the correct behavior for integration tests (accumulating enqueued items for inspection)

## Consistency sweep

- [ ] All `enqueueWorkItems` callers in `packages/lambdas/src/handlers/` updated to `new SqsQueueBackend(sqsClient)`
- [ ] Import `SqsQueueBackend` added to each handler file that calls `enqueueWorkItems`
- [ ] `packages/core/__tests__/queue.test.ts` updated: mock builder changed, all test calls use `backend`, batching assertions updated
- [ ] New InMemoryQueueBackend tests added to `packages/core/__tests__/queue.test.ts`
- [ ] New failedIds → RetryableError tests added to `packages/core/__tests__/queue.test.ts`
- [ ] `SqsQueueBackend` and `InMemoryQueueBackend` exported from `packages/core/src/queue/index.ts`
- [ ] `QueueBackend` interface exported from `packages/core/src/queue/index.ts`
- [ ] `RetryableError` import added to `packages/core/src/queue/index.ts`
- [ ] No changes to test mocks in `packages/lambdas/__tests__/*.test.ts` (already generic)
- [ ] No changes to `packages/lambdas/__tests__/integration/helpers.ts` (mock already generic)
- [ ] `enqueueWorkItems` signature changed but return type (void) and behavior (batching, error handling) preserved
- [ ] Entry field names exact: `id`, `body`, `groupId` (not `Id`, `MessageBody`, `MessageGroupId`)

## Acceptance checklist

- [ ] Run `pnpm -s test` and verify all tests pass (existing + new)
- [ ] Verify `InMemoryQueueBackend` test: instantiate, call `sendBatch()`, check `.sent` array contains entries with exact shape
- [ ] Verify failedIds test: mock backend returns `{ failedIds: ['0'] }`, call `enqueueWorkItems()`, catch and assert `RetryableError` with correct message
- [ ] Verify SqsQueueBackend batching: call with 25 items, assert `sendBatch()` called 3 times with 10, 10, 5 entries
- [ ] Spot-check 2 handler files: confirm `new SqsQueueBackend(sqsClient)` in call site, import present
- [ ] Spot-check 2 test files: confirm mocks unchanged, still resolve without arguments
- [ ] Verify all queue-related types still exported from `@telos/core`: `WorkItem`, `WorkItemSchema`, `QueueBackend`, `SqsQueueBackend`, `InMemoryQueueBackend`
- [ ] Confirm `entry.id` is string `"0"` through `"9"`, not number