You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Refactor + feature: make the work-item queue backend pluggable in packages/core/src/queue.

1. Define a `QueueBackend` interface with a single method `sendBatch(entries: Array<{ id: string; body: string; groupId: string }>): Promise<{ failedIds: string[] }>`.
2. Provide two implementations, exported from the queue index:
   - `SqsQueueBackend` (constructor takes an SQSClient) - preserves today's behavior exactly: batches of <= 10, MessageGroupId = the entry's groupId, reads the queue URL from SQS_QUEUE_URL at send time.
   - `InMemoryQueueBackend` - accumulates entries; exposes `sent: Array<{ id: string; body: string; groupId: string }>` for inspection; never fails.
3. Rework `enqueueWorkItems(items, backend)` to accept a `QueueBackend` as its second argument instead of an SQSClient, delegating batching/grouping decisions to the shared code path so both backends see identical entry streams (id = per-batch index as today, body = JSON of the item, groupId = item.repoFullName).
4. If a sendBatch result reports failedIds, throw a RetryableError (packages/core/src/errors) naming them.
5. Update ALL existing callers and their tests to the new signature mechanically - do not change what the tests assert beyond the signature/mock shape. This is the ONE exception to the no-test-edits rule.
6. Add tests for the InMemoryQueueBackend and the failedIds path at a depth consistent with the existing queue tests.

Verify with: pnpm -s test.
When done, summarize your change briefly.
