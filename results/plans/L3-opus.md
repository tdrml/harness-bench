# Implementation Plan: `review_requested` → `REVIEW_PR` in the GitHub webhook handler

## 1. Spec-critical details

**Response contracts (new `pull_request` branch)**
- Event routed on header `x-github-event` === `'pull_request'`.
- Any `pull_request` action other than `review_requested` → **HTTP 200**, body exactly `{ status: 'ignored' }`.
- Action `review_requested`, no task matches the PR → **HTTP 200**, body exactly `{ status: 'ignored', reason: 'unknown pr' }` (lowercase, single space, exactly that string).
- Action `review_requested`, task matches → **HTTP 202**, body exactly `{ status: 'queued' }`. **202, not 200** — this is the only 202 in the file.
- These new bodies use the key `status`, **not** the `{ ignored: true }` shape used by every other branch. Both shapes coexist; do not unify them.

**Enqueued work item — exactly one, type `REVIEW_PR`** (already exists in `packages/core/src/queue/work-items.ts:39-43`, no schema change):
- `type: 'REVIEW_PR'`
- `projectId` — from the **matched task's** `projectId` (there is no projectId in a GitHub webhook payload; it comes out of DynamoDB). Do **not** mint a fresh `uuidv4()` projectId here, unlike the `issues`/`issue_comment` branches.
- `repoFullName` — `repository.full_name` from the payload (already extracted at `webhook-handler.ts:91`).
- `taskId` — matched task's `taskId` (string).
- `prNumber` — number (int). `ReviewPrSchema` requires `z.number().int()`; never stringify it.
- `correlationId` — fresh `uuidv4()` per request (mocked to `'test-uuid'` in tests).
- Exactly **one** item in the array → exactly **one** `mockSqsSend` call, `Entries` length **1**.

**Preserved behaviors (do not touch)**
- Signature validation precedence is unchanged: SSM secret fetch (500 on failure) → missing/invalid signature → **401** → JSON parse → **400** → non-object/array payload → **400** → missing/invalid `repository` → **400**. All of this runs **before** any event routing, including for `pull_request`.
- `push` and every other unknown event still return **200 `{ ignored: true }`** (the final fallthrough at `webhook-handler.ts:228`).
- `issues` + `labeled` + label `kickoff` → 200 `{ enqueued: true, type: 'BOOTSTRAP_PROJECT', correlationId }`; `issue_comment` + `created` + `/work` → `ENRICH_ISSUE`; `/retry` → `TRIGGER_TASK` with `taskId: String(issueNumber)`. Unchanged.
- Webhook secret is cached at module level and fetched from SSM only once across all invocations — the existing test file depends on this ordering (`webhook-handler.test.ts:112-152`).

**Ordering inside the new branch (precedence matters)**
1. action check first (so `opened` with no `pull_request` object still returns `{ status: 'ignored' }`, never 400),
2. then PR-number extraction,
3. then task lookup,
4. then enqueue.

**PR number extraction**
- Read `payload.pull_request.number`; if absent/not a number, fall back to top-level `payload.number` (GitHub sends both on `pull_request` events).
- If neither is a `number` → **400** `{ error: 'Missing pull_request.number' }` (mirrors `'Missing issue.number'` at `webhook-handler.ts:129`). This case is not in the brief; it is the consistent-with-file choice and is unreachable from the three required tests.

**New service helper**
- `TaskGraphsService.findTaskByPrNumber(prNumber: number): Promise<Task | undefined>` — returns `undefined` (not `null`, not a throw) when nothing matches.
- Backed by `ScanCommand` from `@aws-sdk/lib-dynamodb` with `FilterExpression: 'prNumber = :prNumber'`. The `telos-task-graphs` table is `projectId` (PK) / `taskId` (SK) with **no GSI** (`packages/cdk/lib/constructs/dynamodb-tables.ts:25-32`), so a scan is the only option without a schema change. `prNumber` is not a DynamoDB reserved word — no `ExpressionAttributeNames` needed.
- Must paginate on `LastEvaluatedKey` exactly like `getGraph` (`task-graphs.ts:51-69`); return the first match and stop.
- Known limitation to accept, not fix: the scan matches on `prNumber` alone across all projects (a `Task` has no repo field). Note it in a code comment; do not invent a repo filter.

**Build/resolution fact that will bite you**
- `packages/lambdas` resolves `@telos/core` through the workspace symlink to `packages/core/**dist**/index.js`, not `src`. Adding a method to core `src` is invisible to lambdas until you run a build.

**Baseline**: `pnpm -s test` currently reports **37 files / 732 tests, all passing**.

---

## 2. Ordered steps

### Step 1 — `packages/core/src/dynamodb/task-graphs.ts` (add the helper)
- Add `ScanCommand` to the existing import block from `@aws-sdk/lib-dynamodb` (line 1-7).
- Add `findTaskByPrNumber(prNumber: number): Promise<Task | undefined>` as a public method on `TaskGraphsService`.
- **Pattern to copy: `getGraph` (`task-graphs.ts:51-69`)** — same `do { ... } while (lastEvaluatedKey)` loop, same `result.Items ?? []` cast, same `ExclusiveStartKey` threading. Difference: `ScanCommand` instead of `QueryCommand`, a `FilterExpression`, and an early `return` on the first match.
- No changes to `packages/core/src/dynamodb/index.ts` or `packages/core/src/index.ts` — `TaskGraphsService` is already re-exported through `export * from './task-graphs.js'`.

### Step 2 — `packages/lambdas/src/handlers/webhook-handler.ts` (lazy service accessor)
- Add `TaskGraphsService` and `createDynamoDBClient` to the existing `@telos/core` import (line 6).
- **Do not** construct the service at module scope the way `reconcile.ts:19-21` does. `createDynamoDBClient()` and the `TaskGraphsService` constructor both call `getConfig()`, which `zod`-parses `process.env` eagerly and caches it (`packages/core/src/config/index.ts:8-13`). `webhook-handler.test.ts` does `await import(...)` at line 53, **before** `beforeEach` populates `process.env` — an eager `getConfig()` throws at import time and takes the whole file down.
- Instead use a lazy memoized accessor. **Pattern to copy: `cachedWebhookSecret` / `getWebhookSecret()` in this same file (`webhook-handler.ts:11-28`)** — a module-level `let cachedTaskGraphsService: TaskGraphsService | undefined` plus a `getTaskGraphsService()` that constructs on first use. This is the file's own established convention for deferring `getConfig()`.

### Step 3 — `packages/lambdas/src/handlers/webhook-handler.ts` (the branch)
- Insert a new `if (githubEvent === 'pull_request') { ... }` block **after** the `issue_comment` block (ends line 226) and **before** the final `return respond(200, { ignored: true })` (line 228). Placing it earlier would not break anything, but placing it after the fallthrough would silently dead-code it.
- Body, in order:
  1. `if (p['action'] !== 'review_requested') return respond(200, { status: 'ignored' });`
  2. Extract `prNumber` — narrow `p['pull_request']` with the same `x !== null && typeof x === 'object' && !Array.isArray(x)` guard used at lines 86/111/121; read `.number`, fall back to `p['number']`; on failure `return respond(400, { error: 'Missing pull_request.number' })`.
  3. `const task = await getTaskGraphsService().findTaskByPrNumber(prNumber);`
  4. `if (!task) return respond(200, { status: 'ignored', reason: 'unknown pr' });`
  5. `const correlationId = uuidv4();` then `await enqueueWorkItems([{ type: 'REVIEW_PR', projectId: task.projectId, repoFullName, correlationId, taskId: task.taskId, prNumber }], sqsClient);`
  6. `return respond(202, { status: 'queued' });`
- **Pattern to copy for the enqueue + narrowing style: the `/retry` → `TRIGGER_TASK` block (`webhook-handler.ts:205-223`).** Same single-element array, same `sqsClient` second argument, same bracket-notation property reads.
- `repoFullName` is already a validated `string` at this point (line 99-105); do not re-validate.

### Step 4 — `packages/lambdas/__tests__/webhook-handler.test.ts` (mocks)
- Add a module-level `const mockFindTaskByPrNumber = vi.fn();` next to `mockSsmSend` / `mockSqsSend` (around line 33).
- Add a `vi.mock('@telos/core', ...)` factory **before** the `await import('../src/handlers/webhook-handler.js')` at line 53. **Pattern to copy verbatim: `trigger-task.test.ts:40-52`:**
  ```
  vi.mock('@telos/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@telos/core')>();
    return {
      ...actual,
      createDynamoDBClient: vi.fn(() => ({})),
      TaskGraphsService: vi.fn(() => ({ findTaskByPrNumber: mockFindTaskByPrNumber })),
    };
  });
  ```
- **Critical:** spread `...actual` and override **only** `createDynamoDBClient` and `TaskGraphsService`. `enqueueWorkItems` must stay the real implementation — every existing assertion in this file inspects `mockSqsSend.mock.calls[0][0].input.Entries[0].MessageBody`, which only exists because the real `enqueueWorkItems` runs against the mocked `SQSClient`. Mocking `enqueueWorkItems` here would silently break ~6 existing tests.
- In `beforeEach`, after `vi.clearAllMocks()`, add a default: `mockFindTaskByPrNumber.mockResolvedValue(undefined);`. (`clearAllMocks` clears calls but not implementations; setting the default each time keeps tests order-independent.)
- Add a local `makePullRequestEvent`-style helper or just reuse `makeWebhookEvent({ githubEvent: 'pull_request', body })` — the existing helper already covers it. Payloads must include the full `repository: { full_name, name, owner: { login } }` block or you'll get a 400 from the shared validation.

### Step 5 — `packages/lambdas/__tests__/webhook-handler.test.ts` (fix the one existing test that the spec changes)
- `webhook-handler.test.ts:225-238`, `'returns 200 { ignored: true } for pull_request events'` (action `opened`), asserts `toEqual({ ignored: true })`. The brief mandates `{ status: 'ignored' }` for non-`review_requested` actions, so this assertion **must** change to `toEqual({ status: 'ignored' })`.
- This is the single unavoidable existing-test edit. Keep `toEqual` (not `toMatchObject`), keep the 200 assertion, keep the test in place — that is a spec change, not a weakened assertion. Rename the test title to `'returns 200 { status: ignored } for pull_request with non-review_requested action'`. Either move it into the new describe block or leave it in `unsupported events`; do not delete it.
- **Change nothing else** in this file's existing assertions.

### Step 6 — `packages/lambdas/__tests__/webhook-handler.test.ts` (the three required tests)
Add a new describe block, `'pull_request review_requested → REVIEW_PR'`, placed after the `/retry` block (line 512) and before `'malformed payloads'`. **Pattern to copy: `'issue_comment /retry → TRIGGER_TASK'` (lines 467-512)** for structure, payload construction, and the `mockSqsSend.mock.calls[0][0]` → `JSON.parse(Entries[0].MessageBody)` idiom.

1. **wrong action ignored** — `action: 'opened'` (or `'synchronize'`), full repository block, `pull_request: { number: 7 }`. Assert `statusCode: 200`, body `toEqual({ status: 'ignored' })`, `expect(mockSqsSend).not.toHaveBeenCalled()`, and `expect(mockFindTaskByPrNumber).not.toHaveBeenCalled()` (proves the action check short-circuits before the DB hit).
2. **unknown PR ignored** — `action: 'review_requested'`, `pull_request: { number: 999 }`; `mockFindTaskByPrNumber.mockResolvedValue(undefined)`. Assert `statusCode: 200`, body `toEqual({ status: 'ignored', reason: 'unknown pr' })`, `expect(mockSqsSend).not.toHaveBeenCalled()`, and `expect(mockFindTaskByPrNumber).toHaveBeenCalledWith(999)`.
3. **matching PR enqueues one REVIEW_PR and returns 202** — `action: 'review_requested'`, `pull_request: { number: 77 }`, repository `acme/myapp`; `mockFindTaskByPrNumber.mockResolvedValue({ projectId: 'proj-1', taskId: 'task-9', prNumber: 77, status: 'REVIEW', ... })` (build it off a local task literal shaped like `trigger-task.test.ts:73-82`). Assert:
   - `statusCode: 202`, body `toEqual({ status: 'queued' })`
   - `expect(mockSqsSend).toHaveBeenCalledOnce()`
   - `Entries` has length **1**
   - the parsed work item `toEqual({ type: 'REVIEW_PR', projectId: 'proj-1', repoFullName: 'acme/myapp', taskId: 'task-9', prNumber: 77, correlationId: 'test-uuid' })` — use `toEqual` so an extra stray field fails the test.

### Step 7 — `packages/core/__tests__/dynamodb.test.ts` (service-level tests; do this, it's cheap)
- Add three `it(...)` cases inside the existing `describe('TaskGraphsService')` (starts line 136), after the `getTask` cases. **Pattern to copy: `'getGraph paginates using LastEvaluatedKey'` (lines ~223-238)** and the `makeClient` helper at line 33.
  - scan sends a `FilterExpression` on `prNumber` with `ExpressionAttributeValues[':prNumber']` equal to the input, and returns the matching task;
  - returns `undefined` when `Items` is empty;
  - paginates via `LastEvaluatedKey` and finds a match on the second page.

### Step 8 — rebuild core, then run the suite
- `pnpm --filter @telos/core build` (or `pnpm -s build`) **before** `pnpm -s test`. Skipping this is the most likely cause of a confusing failure: `packages/lambdas/node_modules/@telos/core` symlinks to `packages/core` whose `main` is `dist/index.js`, so lambdas code type-checks and resolves against the **built** core, not `src`.

---

## 3. Consistency sweep

- [ ] `packages/core/src/dynamodb/task-graphs.ts` — `ScanCommand` added to the existing import; no other method touched.
- [ ] `packages/core/src/dynamodb/index.ts` / `packages/core/src/index.ts` — **no edit needed** (verify you didn't add a redundant export).
- [ ] `packages/core/src/queue/work-items.ts` — **no edit needed**; `ReviewPrSchema` already accepts the exact payload. Confirm your item satisfies it (`taskId` string, `prNumber` int).
- [ ] `packages/core/dist/**` rebuilt (`pnpm --filter @telos/core build`) so `findTaskByPrNumber` exists on the resolved module for `@telos/lambdas`.
- [ ] `packages/lambdas/src/handlers/webhook-handler.ts` — new branch sits **before** the line-228 fallthrough; the `issues`, `issue_comment`, and 401/400/500 paths are byte-for-byte unchanged.
- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts` — `vi.mock('@telos/core')` spreads `...actual` and does **not** stub `enqueueWorkItems`; the 6 existing `mockSqsSend`-inspecting tests (BOOTSTRAP_PROJECT ×3, ENRICH_ISSUE ×2, TRIGGER_TASK ×2) still pass untouched.
- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts:117-136` — the "first invocation fetches from SSM" test still runs first and still sees `mockSsmSend` called exactly once. Adding a `@telos/core` mock does not fetch SSM, but re-verify: this test is order-sensitive by design.
- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts:225-238` — updated to `{ status: 'ignored' }`, still `toEqual`, still 200. The only existing assertion whose expected value changes.
- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts:211-223` (push) and `:190-204` (valid-signature passthrough, uses `push`) — must **still** assert `{ ignored: true }`. If either turns into `{ status: 'ignored' }`, your branch is matching too broadly.
- [ ] `packages/lambdas/__tests__/integration/full-flow.test.ts` and `quick-flow.test.ts` — both import `webhook-handler.js` and mock `@telos/core` via `makeCoreServiceMocks`. Their `TaskGraphsService` mock (`helpers.ts:222-267`) has no `findTaskByPrNumber`, which is fine because neither test sends a `pull_request` event — but the **lazy** accessor from Step 2 is what keeps module import safe there. Both must still pass unmodified.
- [ ] *(optional, nice-to-have)* add a `findTaskByPrNumber` entry to `makeCoreServiceMocks` in `packages/lambdas/__tests__/integration/helpers.ts:222` scanning the in-memory `taskGraphs` map, so future integration tests can exercise the path.
- [ ] `packages/cdk/**` — **no changes.** `lambda-functions.ts:120-122` already calls `grantReadWriteData` on all five tables for every handler including `webhook-handler` (that covers `dynamodb:Scan`), and `DYNAMODB_TABLE_TASK_GRAPHS` is already in the shared `environment` (line 72). The CDK snapshot test (`packages/cdk/__tests__/__snapshots__`) must remain **unchanged** — if it fails, you edited CDK and shouldn't have.
- [ ] `packages/cdk/lib/constructs/step-functions.ts` — `REVIEW_PR` is an existing routed work-item type; no change.
- [ ] Test counts: baseline **37 files / 732 tests**. After Step 6 → **735**; after Step 7 → **738**. No new test files. If total files ≠ 37, you created a file you shouldn't have.
- [ ] American English throughout new comments and test titles (`behavior`, `canceled`, `organize`).

---

## 4. Acceptance checklist

Run from the repo root.

1. **Core builds and lambdas type-check against the new method**
   ```bash
   pnpm -s build
   ```
   Must exit 0. A `Property 'findTaskByPrNumber' does not exist on type 'TaskGraphsService'` error here means you edited `src` but didn't rebuild, or added the method to the wrong class.

2. **Full suite green, counts as expected**
   ```bash
   pnpm -s test
   ```
   Expect `Test Files 37 passed (37)` and `Tests 738 passed (738)` (735 if you skipped the optional Step 7 core tests). Zero failures, zero skips.

3. **The three required behaviors, in isolation**
   ```bash
   pnpm vitest run packages/lambdas/__tests__/webhook-handler.test.ts -t "pull_request"
   ```
   Confirm by name: wrong-action → 200 `{ status: 'ignored' }`; unknown PR → 200 `{ status: 'ignored', reason: 'unknown pr' }`; match → 202 `{ status: 'queued' }` with one `REVIEW_PR` entry.

4. **Existing webhook behaviors preserved**
   ```bash
   pnpm vitest run packages/lambdas/__tests__/webhook-handler.test.ts
   ```
   All pre-existing tests pass. Spot-check the diff of this file: the only pre-existing line whose *expected value* changed is the `pull_request` `opened` body at line 237. Everything else in the diff must be additive.

5. **Integration flows untouched**
   ```bash
   pnpm vitest run packages/lambdas/__tests__/integration
   ```
   All three files pass with no edits to `full-flow.test.ts` / `quick-flow.test.ts`.

6. **Infrastructure untouched**
   ```bash
   pnpm vitest run packages/cdk
   ```
   51 tests pass **including the snapshot** with no `-u`. If the snapshot is obsolete or mismatched, revert your CDK changes — none are required.

7. **Lint clean**
   ```bash
   pnpm -s lint
   ```

8. **Manual spec re-read** — reopen the diff of `webhook-handler.ts` and confirm against Section 1, literally: `202` (not 200) on the success path; `'unknown pr'` spelled exactly; `projectId` sourced from the matched task and not from `uuidv4()`; `correlationId` freshly generated; exactly one item passed to `enqueueWorkItems`; the new branch placed above the final `{ ignored: true }` return.

9. **Summary** — report: files touched, the new `findTaskByPrNumber` scan helper and why a scan (no GSI on `prNumber`) plus its cross-project-collision caveat, the three new handler tests, and explicitly call out the one existing test whose expected body changed from `{ ignored: true }` to `{ status: 'ignored' }` because the brief redefines that response.