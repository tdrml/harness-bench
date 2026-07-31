You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Hardening request - SQS partial batch failures (packages/core/src/queue):

`enqueueWorkItems` sends items with `SendMessageBatchCommand`, which can PARTIALLY FAIL: the call resolves normally but reports per-entry failures in a `Failed` array on the result. Today those failures are silently ignored and the items are lost.

Change `enqueueWorkItems` so that after each batch send, if the result contains a non-empty `Failed` array, it throws a `RetryableError` (from packages/core/src/errors) whose message names the failed entry Ids. Batches already sent successfully before the failing batch do not need to be rolled back. A result with no `Failed` entries (or an absent `Failed` field) must not throw.

Rules:
- Do not add or modify any test files - tests are the specification.
- Verify with: pnpm -s test
- Keep changes minimal and idiomatic.

When done, summarize your change briefly.
