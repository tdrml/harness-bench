Perfect! All tests pass. I now have all the information to write a comprehensive implementation plan.

---

# Implementation Plan: GitHub Webhook Handler — Review Request Support

## Spec-critical Details

- Event type: `pull_request`
- Action to handle: `review_requested`
- Response for wrong action: `200 { status: 'ignored' }`
- Response for unknown PR: `200 { status: 'ignored', reason: 'unknown pr' }`
- Response for matched PR: `202 { status: 'queued' }`
- Work item type: `REVIEW_PR`
- Work item fields required: `type`, `projectId`, `repoFullName`, `correlationId`, `taskId`, `prNumber`
- Work item count on match: exactly one per enqueue
- Field to match in task lookup: `task.prNumber`
- Must preserve: signature validation, method/path handling, all existing event behaviors
- New helper: method to find task by repository + PR number (if none exists)

## Ordered Steps

### 1. Add task-lookup helper to `packages/core/src/dynamodb/task-graphs.ts`

**Pattern:** Follow the existing service class methods in `task-graphs.ts`

- Add method `async findTaskByRepoAndPrNumber(repoFullName: string, prNumber: number): Promise<{ projectId: string; task: Task } | undefined>`
- Uses ScanCommand on Projects table to find all projects where `repoOwner` + `repoName` match the parsed repoFullName
- For each matching project, calls `getGraph(projectId)` to fetch task graph
- Returns first task where `task.prNumber === prNumber`, along with its projectId
- Returns `undefined` if no match found

### 2. Update `packages/lambdas/src/handlers/webhook-handler.ts`

**Pattern:** Follow the existing `issue_comment` and `issues` event routing; mirror the structure of ENRICH_ISSUE and TRIGGER_TASK branches

- Import `TaskGraphsService` and `createDynamoDBClient` from `@telos/core` (add to existing imports)
- Add module-level `TaskGraphsService` instance (following pattern of existing module-level services)
- Add routing block for `githubEvent === 'pull_request'`
- Extract `action` from payload
- If action is not `review_requested`, respond `200 { status: 'ignored' }`
- If action is `review_requested`:
  - Extract `number` field from `pull_request` object in payload (this is the PR number)
  - Call the new helper: `await taskGraphsService.findTaskByRepoAndPrNumber(repoFullName, prNumber)`
  - If result is null, respond `200 { status: 'ignored', reason: 'unknown pr' }`
  - If result exists, extract `projectId` and `task` from result
  - Generate fresh `correlationId = uuidv4()`
  - Enqueue one `REVIEW_PR` work item with: `type`, `projectId`, `repoFullName`, `correlationId`, `taskId` (from task), `prNumber`
  - Respond `202 { status: 'queued' }`

### 3. Add tests to `packages/lambdas/__tests__/webhook-handler.test.ts`

**Pattern:** Follow existing describe blocks and test structure; use same makeWebhookEvent, mockSqsSend patterns

- Add new describe block: `pull_request review_requested → REVIEW_PR`
  - Test: wrong action (e.g., `opened`) returns `200 { status: 'ignored' }`
  - Test: unknown PR (no matching task found) returns `200 { status: 'ignored', reason: 'unknown pr' }`
  - Test: matching PR enqueues exactly one REVIEW_PR work item with correct fields, returns `202 { status: 'queued' }`
    - Verify SQS was called once
    - Verify work item has: type=REVIEW_PR, taskId, prNumber, projectId, repoFullName, correlationId
- Mock the TaskGraphsService's new helper method to return results as needed
  - Use `vi.mock()` for the core package (already done for other imports)
  - Mock `findTaskByRepoAndPrNumber` to return null or `{ projectId: 'test-project-id', task: { taskId: '...', prNumber: ... } }` as test cases require

## Consistency Sweep

- [ ] Signature validation still triggers before any event routing ✓ (no changes to validation block)
- [ ] 400 errors for malformed payloads preserved ✓ (no changes to payload parsing)
- [ ] Existing issues/issue_comment routes return unchanged response structures ✓ (routing is separate)
- [ ] All existing webhook-handler tests still pass after PR event branch is added
- [ ] New tests assert count of enqueued items (exactly 1) to catch multiple-enqueue bugs
- [ ] New tests assert all required REVIEW_PR fields are present and correctly typed
- [ ] No changes to `enqueueWorkItems` signature or invocation pattern
- [ ] Pull request object extraction mirrors PR field names from GitHub webhook schema (use `number`, not `id`)
- [ ] Helper method handles repoFullName parsing safely (colon-split validation already in pattern via parseSourceRepo)

## Acceptance Checklist

Run each command from repo root (`/home/thomas/workspace/harness-bench/runs/plan-L3-haiku`):

- [ ] **Full suite passes:** `pnpm -s test` — all 732+ tests pass (no regressions)
- [ ] **Webhook handler tests only:** `pnpm -s test webhook-handler.test.ts` — all existing + new tests pass
- [ ] **New test: wrong action ignored:** grep in test output for "wrong action" or "pull_request.*opened" test passing
- [ ] **New test: unknown PR ignored:** grep in test output for "unknown PR" or "unknown pr" test passing
- [ ] **New test: matching PR enqueues:** grep in test output for "matching PR" or "review_requested" test passing
- [ ] **Work item shape:** Inspect the matching-PR test; SQS payload contains exactly: `{ type: "REVIEW_PR", projectId, repoFullName, correlationId, taskId, prNumber }` (5 fields + base fields)
- [ ] **Status codes correct:** 200 for wrong action, 200 for unknown PR, 202 for queued
- [ ] **Response bodies correct:** ignored, ignored+reason, queued per spec
- [ ] **Exactly one item enqueued:** Test assertion on `mockSqsSend.mock.calls[0][0].input.Entries.length === 1` for matching case
- [ ] **No signature/auth bypass:** Signing tests still reject invalid signatures (existing tests confirm)