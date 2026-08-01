You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature: add a `/cancel` comment command to the GitHub webhook handler (packages/lambdas/src/handlers/webhook-handler.ts), following the existing `/work` and `/retry` patterns.

Exact requirements:
1. New work-item type `CANCEL_RUN` in packages/core/src/queue/work-items.ts: base fields plus `issueNumber: number` (int). Add to the discriminated union, export the `CancelRunWorkItem` type alias like its siblings.
2. In the webhook handler, an issue_comment whose body starts with `/cancel`:
   - If the comment is on a pull request (the payload's issue object has a `pull_request` field): respond 200 with `{ status: 'ignored', reason: 'pr comment' }` and enqueue nothing.
   - Otherwise: enqueue exactly one CANCEL_RUN item (projectId `'unknown'` like /work does before resolution if that is the existing pattern - follow how /work builds its item; repoFullName from the payload; fresh correlationId; the issue number) and respond 202 with `{ status: 'cancel-requested', issueNumber: <n> }`.
3. All existing commands and behaviors unchanged. Comment bodies that start with neither /work, /retry, nor /cancel keep their current handling.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters their setup (signatures, fixtures, counts); do not weaken what they assert. Add tests for new behavior at the depth of neighboring tests.
When done, summarize your change briefly.
