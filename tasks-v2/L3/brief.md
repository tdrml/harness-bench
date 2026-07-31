You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature: extend the GitHub webhook handler (packages/lambdas/src/handlers/webhook-handler.ts) to support re-review requests on pull requests.

1. Handle the `pull_request` event with action `review_requested`. Requirements:
   - Respond 200 with `{ status: 'ignored' }` for any pull_request action other than `review_requested`.
   - For `review_requested`: extract the PR number and the repository full name; look up the task associated with that PR via the task-graphs service (find the task whose prNumber matches - add a small helper if none exists); if no task matches, respond 200 with `{ status: 'ignored', reason: 'unknown pr' }`.
   - When a task matches, enqueue a `REVIEW_PR` work item (existing type) carrying projectId, repoFullName, taskId, prNumber, and a fresh correlationId, then respond 202 with `{ status: 'queued' }`.
2. Signature validation, method/path handling, and all existing event behaviors must be preserved.
3. Add handler tests for: wrong action ignored; unknown PR ignored; matching PR enqueues exactly one correctly-shaped REVIEW_PR item and returns 202. Follow the existing webhook-handler test file's mocking conventions. Extending tests is required here; do not weaken existing assertions.

Verify with: pnpm -s test.
When done, summarize your change briefly.
