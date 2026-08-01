# Plan: Pluggable Queue Backend for `packages/core/src/queue`

## 1. Spec-critical details

- New file `packages/core/src/queue/backends.ts` exports:
  - `interface QueueBackend { sendBatch(entries: Array<{ id: string; body: string; groupId: string }>): Promise<{ failedIds: string[] }> }`
  - `class SqsQueueBackend implements QueueBackend` — constructor signature `constructor(private readonly client: SQSClient)`.
  - `class InMemoryQueueBackend implements QueueBackend` — public field `sent: Array<{ id: string; body: string; groupId: string }> = []`.
- `SqsQueueBackend.sendBatch`:
  - Reads `process.env['SQS_QUEUE_URL']` **inside `sendBatch`**, not the constructor (today's behavior: URL is read at send time, so it can change between construction and use, e.g. under test env mutation).
  - Throws `new Error('SQS_QUEUE_URL environment variable is not set')` if unset — same message as today, verbatim (a lambda test may assert on this string).
  - Builds exactly one `SendMessageBatchCommand` per call (batching is now the caller's job — `sendBatch` itself does not chunk; `enqueueWorkItems` chunks before calling it).
  - Maps `entries` 1:1: `Id: entry.id`, `MessageBody: entry.body`, `MessageGroupId: entry.groupId`.
  - Returns `{ failedIds: [] }` on success (this refactor's contract does not require parsing `SendMessageBatchCommand`'s `Failed` array from the real SQS response — the queue.test.ts mock client never returns failures today, so do not invent new parsing logic beyond what's needed to satisfy the tests you add in step 6; if you do choose to surface real SQS `Failed[].Id` entries, that's a bonus but not required — do not let it become a rabbit hole).
- `InMemoryQueueBackend.sendBatch`:
  - Pushes all `entries` onto `this.sent` (never chunks — it's an in-memory sink, not an SQS gateway).
  - Always returns `{ failedIds: [] }`. Never throws.
- `enqueueWorkItems(items: WorkItem[], backend: QueueBackend): Promise<void>` (in `packages/core/src/queue/index.ts`):
  - `BATCH_SIZE = 10` constant stays (already exists at `queue/index.ts:22`) — unchanged value.
  - For each batch of ≤10 items, build `entries` with `id: String(index)` where `index` is the **per-batch** index (0–9), `body: JSON.stringify(item)`, `groupId: item.repoFullName` — identical semantics to today's `Id`/`MessageBody`/`MessageGroupId` mapping at `queue/index.ts:34-38`.
  - Calls `await backend.sendBatch(entries)` per batch (sequential loop, same as today's sequential `await sqsClient.send(command)`).
  - If the result has `failedIds.length > 0`, throw `new RetryableError(...)` naming the failed ids — e.g. `` `Failed to enqueue work items: ${failedIds.join(', ')}` `` — imported from `../errors/index.js` (see pattern at `packages/core/src/github/index.ts:6,15`).
  - **No more `SQS_QUEUE_URL` check inside `enqueueWorkItems`** — that check now lives solely in `SqsQueueBackend.sendBatch`. This is a behavior-location change, not a behavior change: `enqueueWorkItems([item], backend)` still throws the same message when the URL is missing, because `SqsQueueBackend.sendBatch` throws it — but only when it actually runs (i.e., not on an empty `items` array, matching today's "sends nothing / doesn't touch SQS for empty input" behavior).
  - Empty `items` array ⇒ loop body never runs ⇒ `backend.sendBatch` never called (preserves the existing "sends nothing for empty items array" test).
- `queue/index.ts` re-exports `QueueBackend`, `SqsQueueBackend`, `InMemoryQueueBackend` from `./backends.js` (barrel already flows up through `packages/core/src/index.ts:10`'s `export * from './queue/index.js'` — no change needed there).
- `RetryableError` constructor is `(message: string, cause?: Error)` — no `code` param, `code` is fixed internally to `'RETRYABLE_ERROR'` (`packages/core/src/errors/index.ts:18-22`). Do not pass a third argument.
- Every existing call site changes from `enqueueWorkItems(items, sqsClient)` to `enqueueWorkItems(items, someQueueBackendInstance)` — the `SQSClient` itself is now wrapped in a module-level `new SqsQueueBackend(sqsClient)`, not passed directly.

## 2. Ordered steps

1. **`packages/core/src/queue/backends.ts` (new file)** — model the single-purpose-file split on `packages/core/src/dynamodb/projects.ts` (one concern per file, re-exported from that module's `index.ts`).
   - Import `SendMessageBatchCommand`, `type SQSClient` from `@aws-sdk/client-sqs` (moved from `queue/index.ts`).
   - Define `QueueBackend` interface, `SqsQueueBackend`, `InMemoryQueueBackend` per section 1.
2. **`packages/core/src/queue/index.ts`** — rework:
   - Remove the direct `@aws-sdk/client-sqs` import (no longer needed here — it moves to `backends.ts`).
   - Add `export * from './backends.js';` alongside the existing `export { WorkItemSchema, ... } from './work-items.js';` re-exports.
   - Import `RetryableError` from `../errors/index.js` (pattern: `packages/core/src/github/index.ts:6`).
   - Import `QueueBackend` type from `./backends.js`.
   - Rewrite `enqueueWorkItems` per section 1's contract, keeping the existing `BATCH_SIZE = 10` loop structure (`queue/index.ts:30-31`) but replacing the SQS-specific command construction with entry-building + `backend.sendBatch(entries)`, then the `failedIds` check.
3. **`packages/core/__tests__/queue.test.ts`** — this file is the one place the "no-test-edits" exception applies for *behavior-shape* reasons (signature change), plus you're adding new coverage:
   - Change `makeSqsClient()` usage in the `enqueueWorkItems` describe block: keep the helper (still useful for constructing `SqsQueueBackend`), but every `enqueueWorkItems(items, client)` call becomes `enqueueWorkItems(items, new SqsQueueBackend(client))`. Assertions on `client.send.mock.calls[...]` and `cmd.input.*` stay exactly as written — `SqsQueueBackend` preserves the exact `SendMessageBatchCommand` shape, so no assertion text changes.
   - Add `import { SqsQueueBackend, InMemoryQueueBackend } from '../src/queue/index.js';` and `import { RetryableError } from '../src/errors/index.js';`.
   - Add a new `describe('InMemoryQueueBackend', ...)` block, at the same depth/style as the existing `describe('enqueueWorkItems', ...)` block (`queue.test.ts:200`): construct items via the existing `makeItem` helper, call `enqueueWorkItems(items, backend)`, assert on `backend.sent` — cover (a) single batch accumulates in order, (b) `>10` items still all land in `sent` in one flattened array (since `InMemoryQueueBackend` doesn't batch, but `enqueueWorkItems` still calls `sendBatch` once per 10-item chunk — assert `sendBatch`-style behavior via a spy, or simply assert `sent.length === items.length` and entry shape/order), (c) never throws / no env var required (don't set `SQS_QUEUE_URL` for this block, proving `InMemoryQueueBackend` doesn't care).
   - Add a `describe('enqueueWorkItems — failedIds', ...)` block: build a stub backend object `{ sendBatch: vi.fn(async () => ({ failedIds: ['3', '7'] })) }` (satisfies `QueueBackend`), call `enqueueWorkItems([...], stubBackend)`, assert `await expect(...).rejects.toBeInstanceOf(RetryableError)` (mirror the assertion style at `packages/core/__tests__/github.test.ts:150-152`) and that the failed ids appear in the thrown message (`.rejects.toThrow('3')` or similar, matching the existing `.rejects.toThrow('SQS_QUEUE_URL')` style at `queue.test.ts:263-266`).
   - Leave the `SQS_QUEUE_URL` missing-env test (`queue.test.ts:260-266`) — it still must pass, now indirectly (the error still surfaces through `SqsQueueBackend.sendBatch` inside `enqueueWorkItems`), with `client` swapped for `new SqsQueueBackend(client)`.
4. **All 14 lambda handler source files** that hold a module-level `const sqsClient = new SQSClient({});` and call `enqueueWorkItems(followOn, sqsClient)` — mechanical signature update, same pattern in every file (`trigger-task.ts`, `enrich-issue.ts`, `revise-pr.ts`, `quick-task.ts`, `merge-pr.ts`, `reconcile-enqueuer.ts`, `plan-tasks.ts`, `bootstrap-repo.ts`, `review-pr.ts`, `rebase-pr.ts`, `webhook-handler.ts`, `generate-architecture.ts`, `reconcile.ts`, `bootstrap-project.ts`, `create-issues.ts`):
   - Add `SqsQueueBackend` to each file's `@telos/core` import list.
   - Directly below each file's existing `const sqsClient = new SQSClient({});` line, add `const queueBackend = new SqsQueueBackend(sqsClient);`.
   - Change every `enqueueWorkItems(followOn, sqsClient)` (and the webhook-handler's three inline calls that pass `sqsClient` as the trailing arg — `webhook-handler.ts:149,199,219`) to use `queueBackend` instead of `sqsClient`.
   - Do this for **every** call site in files with multiple (`merge-pr.ts` has 3 at lines 81/126/145; `review-pr.ts` has 3 at lines 138/158/192; `webhook-handler.ts` has 3).
5. **No lambda test-file edits should be needed** for 13 of these handlers (`bootstrap-project`, `bootstrap-repo`, `create-issues`, `enrich-issue`, `generate-architecture`, `merge-pr`, `plan-tasks`, `quick-task`, `rebase-pr`, `reconcile`, `reconcile-enqueuer`, `review-pr`, `revise-pr`, `trigger-task`) — verify this assumption per file (see Consistency Sweep) rather than assuming: their tests `vi.mock('@telos/core', ...)` and replace `enqueueWorkItems` wholesale with a `vi.fn()`, and every assertion destructures only the first (`items`) argument (`const [items] = mockEnqueueWorkItems.mock.calls[0]`), never the second. Because `SqsQueueBackend` is still the *real* class (mocks spread `...actual`), constructing it against a stubbed `SQSClient` (often just `vi.fn(() => ({}))`) is harmless since `sendBatch` is never invoked when `enqueueWorkItems` itself is mocked.
6. **`webhook-handler.test.ts` must NOT need edits either** — it does not mock `enqueueWorkItems`; it lets the real function run and mocks `@aws-sdk/client-sqs`'s `SQSClient` (returning `{ send: mockSqsSend }`) and asserts on `mockSqsSend.mock.calls[0][0].input.Entries[...]` (e.g. `webhook-handler.test.ts:336-346`). This is exactly why `SqsQueueBackend` must preserve the `SendMessageBatchCommand` shape byte-for-byte — confirm these assertions still pass unmodified after step 4's edit to `webhook-handler.ts`.
7. **Integration tests** (`packages/lambdas/__tests__/integration/{full-flow,quick-flow,error-scenarios}.test.ts`) — no edits expected. They use `makeCoreServiceMocks(...)` (`packages/lambdas/__tests__/integration/helpers.ts:190-286`), whose `enqueueWorkItems: vi.fn(...)` override (helpers.ts:282-284) fully replaces the real function; their `SendMessageBatchCommand: vi.fn(...)` mocks in each test file are vestigial (dead code paths, unreachable once `enqueueWorkItems` is mocked) and don't need touching.

## 3. Consistency sweep

Check off each — a signature-only mechanical change, verified against the assumptions above (don't assume; grep to confirm each test file's mock strategy before moving on):

- [ ] `packages/core/src/queue/backends.ts` created with `QueueBackend`, `SqsQueueBackend`, `InMemoryQueueBackend`
- [ ] `packages/core/src/queue/index.ts` reworked: no direct `@aws-sdk/client-sqs` import, re-exports `backends.js`, `enqueueWorkItems` takes `QueueBackend`, throws `RetryableError` on `failedIds`
- [ ] `packages/core/__tests__/queue.test.ts`: existing `enqueueWorkItems` tests updated to wrap `client` in `new SqsQueueBackend(client)`; new `InMemoryQueueBackend` describe block added; new `failedIds` → `RetryableError` describe block added
- [ ] `packages/lambdas/src/handlers/trigger-task.ts` — import + module-level backend + 1 call site
- [ ] `packages/lambdas/src/handlers/enrich-issue.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/revise-pr.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/quick-task.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/merge-pr.ts` — same, **3** call sites (lines ~81, 126, 145)
- [ ] `packages/lambdas/src/handlers/reconcile-enqueuer.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/plan-tasks.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/bootstrap-repo.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/review-pr.ts` — same, **3** call sites (lines ~138, 158, 192)
- [ ] `packages/lambdas/src/handlers/rebase-pr.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/webhook-handler.ts` — same, **3** call sites (lines ~149, 199, 219)
- [ ] `packages/lambdas/src/handlers/generate-architecture.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/reconcile.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/bootstrap-project.ts` — same, 1 call site
- [ ] `packages/lambdas/src/handlers/create-issues.ts` — same, 1 call site
- [ ] Confirm zero remaining references to the old two-arg-with-`SQSClient` call shape: `grep -rn "enqueueWorkItems(" packages --include='*.ts' | grep -v '__tests__'` — every result should pass a `QueueBackend`-typed variable, never `sqsClient` directly
- [ ] Confirm no test file other than `packages/core/__tests__/queue.test.ts` required edits — if any lambda test *did* need a change, it means that test was asserting on the second `enqueueWorkItems` argument or constructing `SqsQueueBackend`/`SQSClient` in a way that breaks; re-verify against section 1's exact-preservation requirement rather than loosening a test assertion
- [ ] No stale `import { SQSClient } from '@aws-sdk/client-sqs'` left unused in `packages/core/src/queue/index.ts` (moved to `backends.ts`)
- [ ] `pnpm -s lint` (biome) clean — catches unused imports/vars from the mechanical edits

## 4. Acceptance checklist

- [ ] `pnpm -s test` — full suite green, run from repo root
- [ ] `pnpm -s --filter @telos/core test` (or equivalent workspace-scoped run) green in isolation, confirming `queue.test.ts` changes don't depend on lambda-package state
- [ ] `pnpm -s --filter @telos/lambdas test` green, confirming all 14 handler updates + `webhook-handler.test.ts`'s real-SQS assertions still pass unmodified
- [ ] Grep confirms `SqsQueueBackend` preserves exact SQS semantics: batches ≤10, `MessageGroupId = groupId`, queue URL read from `process.env['SQS_QUEUE_URL']` inside `sendBatch` (not the constructor)
- [ ] Grep confirms `InMemoryQueueBackend.sent` is populated in call order and the class never throws, even without `SQS_QUEUE_URL` set
- [ ] Grep confirms `enqueueWorkItems` throws `RetryableError` (not a bare `Error`) when `sendBatch` reports `failedIds`, and the thrown message names the failed ids
- [ ] `grep -rn "enqueueWorkItems(" packages --include='*.ts'` shows every call site passing a `QueueBackend` (a `SqsQueueBackend`/`InMemoryQueueBackend` instance or compatible stub), never a raw `SQSClient`
- [ ] `pnpm -s lint` clean (no unused `SQSClient` type imports left behind in `queue/index.ts`, no unused `sqsClient` locals in handlers — `sqsClient` remains used as the constructor arg to `SqsQueueBackend`)
- [ ] Diff review: confirm no test file's *assertions* changed beyond the mechanical `client` → `new SqsQueueBackend(client)` wrapping in `queue.test.ts` — every lambda `__tests__/*.test.ts` file should show **zero** diff