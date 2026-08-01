You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Refactor: convert `enqueue` in packages/core/src/queue/enqueue.ts from positional parameters to a single params object, and migrate every call site.

1. New signature: `enqueue(params: { queueUrl: string; workItem: WorkItem; options?: EnqueueOptions; sqsClient?: SQSClient })`. The old positional signature is removed entirely.
2. All behavior is preserved exactly: default client construction, message group id derivation (including the RECONCILE-per-runId rule), deduplication id handling, delaySeconds semantics.
3. Migrate EVERY call site across the monorepo (lambda handlers and any helpers/tests) mechanically; behavior at each site unchanged.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters their setup (signatures, fixtures, counts); do not weaken what they assert. Add tests for new behavior at the depth of neighboring tests.
When done, summarize your change briefly.
