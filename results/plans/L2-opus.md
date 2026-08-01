# Implementation Plan: Pluggable Queue Backend

## 1. Spec-critical details

Every value below is pinned by the brief or by existing behavior that must not change.

**Interface**
- Interface name: `QueueBackend` (exported from the queue index).
- Single method: `sendBatch(entries: Array<{ id: string; body: string; groupId: string }>): Promise<{ failedIds: string[] }>`.
- Entry field names are exactly `id`, `body`, `groupId` — lowercase, not SQS's `Id`/`MessageBody`/`MessageGroupId`.
- Return field name is exactly `failedIds` (plural, camelCase), type `string[]`.
- Suggested shared alias: `QueueEntry = { id: string; body: string; groupId: string }` — export it as a type so tests and handlers can name it.

**`SqsQueueBackend`**
- Class name exactly `SqsQueueBackend` (lowercase `qs` — not `SQSQueueBackend`).
- Constructor takes a single `SQSClient` argument.
- Reads `process.env['SQS_QUEUE_URL']` **at send time** (inside `sendBatch`), not in the constructor.
- If `SQS_QUEUE_URL` is unset/empty: `throw new Error('SQS_QUEUE_URL environment variable is not set')` — this exact message string is asserted (partially, on `'SQS_QUEUE_URL'`) by `packages/core/__tests__/queue.test.ts:263`.
- Issues exactly one `SendMessageBatchCommand` per `sendBatch` call, via `client.send(command)`.
- Command input shape, unchanged: `{ QueueUrl: <env value>, Entries: [{ Id: entry.id, MessageBody: entry.body, MessageGroupId: entry.groupId }] }`.
- `failedIds` derived from the SQS response's `Failed` array → each entry's `Id`.
- The SQS response may be `undefined` at runtime (test mocks return `undefined` or `{}`). Use `result?.Failed ?? []`. **Not** `result.Failed`.
- `BatchResultErrorEntry.Id` is typed `string | undefined` in the AWS SDK — filter or coerce; do not let `undefined` into `failedIds: string[]`.
- Returns `{ failedIds: [] }` when nothing failed.

**`InMemoryQueueBackend`**
- Class name exactly `InMemoryQueueBackend`.
- No constructor arguments.
- Public field named exactly `sent`, typed `Array<{ id: string; body: string; groupId: string }>`, initialized to `[]`.
- `sendBatch` appends all entries to `sent` (accumulates across calls, preserving order) and always returns `{ failedIds: [] }`. Never throws, never reads env.

**`enqueueWorkItems`**
- New signature: `enqueueWorkItems(items: WorkItem[], backend: QueueBackend): Promise<void>`. Second parameter is a `QueueBackend`, **not** an `SQSClient`.
- Return type stays `Promise<void>`.
- `BATCH_SIZE = 10`; batches are `items.slice(i, i + BATCH_SIZE)` — max 10 entries per batch.
- Batches are sent **sequentially** (`await` in the loop), same as today.
- `entry.id = String(index)` where `index` is the index **within the batch** (0–9), reset per batch — not a global running index.
- `entry.body = JSON.stringify(item)`.
- `entry.groupId = item.repoFullName`.
- Empty `items` array ⇒ zero `sendBatch` calls (the loop simply never runs).
- Batching/grouping/id assignment lives entirely in `enqueueWorkItems`, so both backends receive identical entry streams. Backends must not re-batch or re-index.

**Failure path**
- If a `sendBatch` result has a non-empty `failedIds`, throw `RetryableError` from `packages/core/src/errors/index.ts`.
- `RetryableError` constructor is `(message: string, cause?: Error)` and sets `code = 'RETRYABLE_ERROR'`.
- The message must name the failed ids. Use exactly: `` `Failed to enqueue ${failedIds.length} work item(s): ${failedIds.join(', ')}` ``.
- Throw immediately on the failing batch — do not continue sending subsequent batches.
- Empty `failedIds` array ⇒ no throw.

**Env / behavior preservation**
- `SQS_QUEUE_URL` check now lives in `SqsQueueBackend.sendBatch`. Consequence, and it is correct: `enqueueWorkItems([], sqsBackend)` no longer throws when the env var is unset. No existing test covers that case (the empty-array test at `queue.test.ts:254` sets the env var in `beforeEach`), so the suite stays green.

**Build/tooling constants**
- Baseline: **37 test files, 732 tests, all passing** (`pnpm -s test`, ~16s).
- `@telos/core` resolves for `@telos/lambdas` via `main: dist/index.js` — **the compiled `dist`, not `src`**. Core must be rebuilt before lambdas tests will see the new exports.
- Formatting (biome): single quotes, trailing commas `all`, 2-space indent, line width 100.
- TS: `strict: true`, `module: Node16` — **all relative imports need the `.js` extension**.

---

## 2. Ordered steps

### Step 1 — `packages/core/src/queue/backend.ts` (new file)

Define and export:
- `export interface QueueEntry { id: string; body: string; groupId: string }`
- `export interface QueueBackend { sendBatch(entries: QueueEntry[]): Promise<{ failedIds: string[] }> }`

Pattern to follow: `packages/core/src/merge-policy/index.ts` — plain exported `interface` declarations with no imports, no classes. Keep this file dependency-free (no AWS imports) so `InMemoryQueueBackend` consumers never pull in the SDK types transitively for a reason.

### Step 2 — `packages/core/src/queue/sqs-backend.ts` (new file)

`export class SqsQueueBackend implements QueueBackend`.

Pattern to follow: `packages/core/src/dynamodb/repo-locks.ts` — `constructor(private readonly client: SQSClient) {}`, one public async method, imports the SDK command type at the top, imports errors via `'../errors/index.js'`.

Contents:
- `import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';` (move this import here from `index.ts`).
- `import type { QueueBackend, QueueEntry } from './backend.js';`
- `sendBatch(entries)`:
  1. Read `process.env['SQS_QUEUE_URL']`; if falsy, `throw new Error('SQS_QUEUE_URL environment variable is not set')`.
  2. Build `new SendMessageBatchCommand({ QueueUrl, Entries: entries.map(e => ({ Id: e.id, MessageBody: e.body, MessageGroupId: e.groupId })) })`.
  3. `const result = await this.client.send(command);`
  4. Derive `failedIds` from `result?.Failed ?? []`, keeping only defined `Id`s (a type guard predicate `(id): id is string => id !== undefined` after `.map(f => f.Id)` is the cleanest way to satisfy `strict`).
  5. Return `{ failedIds }`.

Do **not** loop or slice here — it receives an already-sized batch.

### Step 3 — `packages/core/src/queue/in-memory-backend.ts` (new file)

`export class InMemoryQueueBackend implements QueueBackend` with:
- `readonly sent: QueueEntry[] = [];`
- `async sendBatch(entries: QueueEntry[]): Promise<{ failedIds: string[] }> { this.sent.push(...entries); return { failedIds: [] }; }`

No env reads, no throws.

### Step 4 — `packages/core/src/queue/index.ts` (rewrite `enqueueWorkItems`, add exports)

- Remove the `@aws-sdk/client-sqs` import entirely (it moved to `sqs-backend.ts`).
- Add `import { RetryableError } from '../errors/index.js';` and `import type { QueueBackend } from './backend.js';`
- Keep `const BATCH_SIZE = 10;` and the existing `export { WorkItemSchema, ... } from './work-items.js'` block untouched.
- Add re-exports in the same explicit style as the existing work-items block:
  - `export type { QueueBackend, QueueEntry } from './backend.js';`
  - `export { SqsQueueBackend } from './sqs-backend.js';`
  - `export { InMemoryQueueBackend } from './in-memory-backend.js';`
- Rewrite the function body:
  ```
  for each slice of BATCH_SIZE:
    entries = batch.map((item, index) => ({ id: String(index), body: JSON.stringify(item), groupId: item.repoFullName }))
    { failedIds } = await backend.sendBatch(entries)
    if (failedIds.length > 0) throw new RetryableError(`Failed to enqueue ${failedIds.length} work item(s): ${failedIds.join(', ')}`)
  ```

`packages/core/src/index.ts` already does `export * from './queue/index.js'` — **no edit needed there**; the new symbols propagate to `@telos/core` automatically.

### Step 5 — Rebuild core

```bash
pnpm --filter @telos/core build
```
This must happen before any lambdas test run. `dist/` is gitignored, so it produces no commit noise.

### Step 6 — Update the 15 lambda handlers (21 call sites)

In `packages/lambdas/src/handlers/`, for each of:

`bootstrap-project.ts`, `bootstrap-repo.ts`, `create-issues.ts`, `enrich-issue.ts`, `generate-architecture.ts`, `merge-pr.ts`, `plan-tasks.ts`, `quick-task.ts`, `rebase-pr.ts`, `reconcile.ts`, `reconcile-enqueuer.ts`, `review-pr.ts`, `revise-pr.ts`, `trigger-task.ts`, `webhook-handler.ts`

do exactly two mechanical things:

**(a)** Add `SqsQueueBackend` to the existing `@telos/core` import list, and add one module-level line right after the existing client construction (pattern: `packages/lambdas/src/handlers/reconcile-enqueuer.ts:6-8`, the "Module-level clients and services — warm across Lambda invocations" block):
```ts
const sqsClient = new SQSClient({});
const queueBackend = new SqsQueueBackend(sqsClient);
```
Keep the `sqsClient` variable — it is now consumed by the backend constructor, so no unused-variable lint.

**(b)** Change every `enqueueWorkItems(X, sqsClient)` to `enqueueWorkItems(X, queueBackend)`.

Call-site map (line numbers are pre-edit):
| File | Call sites |
|---|---|
| `bootstrap-project.ts` | 92 |
| `bootstrap-repo.ts` | 73 |
| `create-issues.ts` | 121 |
| `enrich-issue.ts` | 59 |
| `generate-architecture.ts` | 78 |
| `merge-pr.ts` | 81, 126, 145 |
| `plan-tasks.ts` | 203 |
| `quick-task.ts` | 101 |
| `rebase-pr.ts` | 105 |
| `reconcile.ts` | 239 |
| `reconcile-enqueuer.ts` | 33 |
| `review-pr.ts` | 138, 158, 192 |
| `revise-pr.ts` | 138 |
| `trigger-task.ts` | 102 |
| `webhook-handler.ts` | 136, 189, 209 — note these are **multi-line** calls where the argument sits alone on lines 149, 199, 219 as `sqsClient,` |

A `sed`-style sweep of `, sqsClient)` → `, queueBackend)` covers 18 sites; webhook-handler's three multi-line `      sqsClient,` argument lines must be handled separately.

### Step 7 — Update `packages/core/__tests__/queue.test.ts` (signature only)

This is the **only existing test file that needs editing**. Its `enqueueWorkItems` describe block (lines 200–267) asserts on `client.send` calls, so keep the SQS mock and wrap it.

- Add `SqsQueueBackend` (and later `InMemoryQueueBackend`, `type QueueBackend`) to the existing import on line 2.
- At each of the 8 call sites (lines 210, 216, 224, 232, 240, 247, 256, 263), change `enqueueWorkItems(items, client)` → `enqueueWorkItems(items, new SqsQueueBackend(client))`.
- Change **nothing else** — every `expect(...)` in that block stays byte-identical, including `toHaveBeenCalledTimes(1)`, `toHaveBeenCalledTimes(3)`, the `Entries` length assertions `10/10/3`, the `MessageGroupId`/`MessageBody`/`QueueUrl` assertions, and the `'SQS_QUEUE_URL'` rejection.

### Step 8 — Add new tests to `packages/core/__tests__/queue.test.ts`

Append after the existing `enqueueWorkItems` describe, using the same style: a `// ---` banner comment, `describe`/`it`, small local helpers reusing the existing `makeItem` factory.

**`describe('InMemoryQueueBackend')`**
- `sendBatch` records entries into `sent` and returns `{ failedIds: [] }`.
- `enqueueWorkItems` with 5 items records 5 entries in `sent`.
- 25 items ⇒ `sent` has 25 entries and their `id`s are `'0'..'9','0'..'9','0'..'4'` (proves per-batch index reset).
- `body` round-trips: `JSON.parse(sent[0].body)` equals the item.
- `groupId` equals `repoFullName`.
- Empty items array leaves `sent` empty.
- Does not require `SQS_QUEUE_URL` — add an `it` that `delete process.env['SQS_QUEUE_URL']` and still resolves. (Note: the outer `beforeEach` at line 203 sets it; scope the delete inside the `it`.)

**`describe('enqueueWorkItems — failedIds')`**
- A hand-rolled stub `const backend: QueueBackend = { sendBatch: vi.fn(async () => ({ failedIds: ['0', '3'] })) }` ⇒ `await expect(enqueueWorkItems([item], backend)).rejects.toThrow(RetryableError)` (import `RetryableError` from `'../src/errors/index.js'`).
- The thrown message contains `'0'` and `'3'`.
- `failedIds: []` ⇒ resolves, no throw.
- A stub failing only on its **second** batch, given 25 items ⇒ rejects, and `sendBatch` was called exactly 2 times (proves it stops early and does not send batch 3).

**`describe('SqsQueueBackend — failed entries')`**
- `makeSqsClient(() => ({ Successful: [], Failed: [{ Id: '2', Code: 'X', SenderFault: false }] }))` ⇒ `enqueueWorkItems` rejects with `RetryableError` naming `2`.
- `Failed: []` ⇒ resolves (guards the `webhook-handler.test.ts` mock shape).
- `send` resolving `{}` / `undefined` ⇒ resolves (guards the `result?.Failed` defensiveness).

### Step 9 — Rebuild and verify

```bash
pnpm --filter @telos/core build && pnpm --filter @telos/lambdas build
pnpm -s test
pnpm lint
```

---

## 3. Consistency sweep

Checklist — tick each before declaring done.

**Core source**
- [ ] `packages/core/src/queue/backend.ts` created; `QueueBackend` + `QueueEntry` exported.
- [ ] `packages/core/src/queue/sqs-backend.ts` created; `SqsQueueBackend` exported.
- [ ] `packages/core/src/queue/in-memory-backend.ts` created; `InMemoryQueueBackend` exported.
- [ ] `packages/core/src/queue/index.ts` re-exports all three new symbols and no longer imports `@aws-sdk/client-sqs`.
- [ ] `enqueueWorkItems` second parameter is `QueueBackend`; `RetryableError` imported and thrown on non-empty `failedIds`.
- [ ] `packages/core/src/index.ts` — verified **no change needed** (`export * from './queue/index.js'`).
- [ ] All new relative imports carry the `.js` extension (`module: Node16`).

**Handlers — all 15 files, 21 call sites**
- [ ] bootstrap-project.ts · [ ] bootstrap-repo.ts · [ ] create-issues.ts · [ ] enrich-issue.ts · [ ] generate-architecture.ts
- [ ] merge-pr.ts (×3) · [ ] plan-tasks.ts · [ ] quick-task.ts · [ ] rebase-pr.ts · [ ] reconcile.ts
- [ ] reconcile-enqueuer.ts · [ ] review-pr.ts (×3) · [ ] revise-pr.ts · [ ] trigger-task.ts · [ ] webhook-handler.ts (×3, multi-line args)
- [ ] Zero hits from `grep -rn "enqueueWorkItems(.*sqsClient" packages --include='*.ts'` and `grep -rn "^\s*sqsClient,$" packages/lambdas/src`.

**Tests that need editing**
- [ ] `packages/core/__tests__/queue.test.ts` — 8 signature-only edits + new describes. **This is the only pre-existing test file that changes.**

**Tests verified to need NO changes** (confirm they still pass; do not touch them)
- [ ] The 14 lambda unit tests that `vi.mock('@telos/core', ...)` with `mockEnqueueWorkItems` — every one destructures `const [items] = mockEnqueueWorkItems.mock.calls[0]`; **none asserts the second argument**, so the mock shape is unaffected. All spread `...actual` from `importOriginal`, so the real `SqsQueueBackend` is available for the handlers' module-level construction: `bootstrap-project`, `bootstrap-repo`, `create-issues`, `enrich-issue`, `generate-architecture`, `merge-pr`, `plan-tasks`, `quick-task`, `rebase-pr`, `reconcile`, `reconcile-enqueuer`, `review-pr`, `revise-pr`, `trigger-task`.
- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts` — **the highest-risk file**. It does *not* mock `@telos/core`, so it runs the real `enqueueWorkItems` + real `SqsQueueBackend` against a mocked `@aws-sdk/client-sqs` (`SQSClient` → `{ send: mockSqsSend }`, `SendMessageBatchCommand` → `(input) => ({ input })`). Its 5 assertions on `mockSqsSend.mock.calls[0][0].input.Entries` (lines 336, 337, 366, 388, 435, 487) only pass if `SqsQueueBackend` keeps constructing `SendMessageBatchCommand` with the identical `{ QueueUrl, Entries: [{ Id, MessageBody, MessageGroupId }] }` shape. Its `beforeEach` (line 105) resolves `{ Successful: [...], Failed: [] }` — the empty `Failed` array must not trigger `RetryableError`.
- [ ] `packages/lambdas/__tests__/integration/helpers.ts` (`makeCoreServiceMocks`, line 282) + the 3 integration tests (`full-flow`, `quick-flow`, `error-scenarios`) — they mock `enqueueWorkItems` and spread `...actual`, and their `@aws-sdk/client-sqs` mocks already export `SendMessageBatchCommand`. No edits.
- [ ] `packages/worker/**` — does not import queue code. `packages/cdk/**` — infrastructure only, snapshot unaffected.
- [ ] `docs/` and `README.md` — grep confirmed zero mentions of `enqueueWorkItems`. No doc updates required.

**Build-order trap (this is how this task fails silently)**
- [ ] `@telos/core` was rebuilt (`pnpm --filter @telos/core build`) **after** the core src edits and **before** running `pnpm -s test`. Lambdas resolve `@telos/core` → `packages/core/dist/index.js`, not `src`. If you skip the rebuild, every lambda handler gets `SqsQueueBackend === undefined` and throws `TypeError: SqsQueueBackend is not a constructor` at module import — dozens of unrelated-looking failures.
- [ ] `packages/lambdas` also rebuilt, to type-check the handlers against core's regenerated `.d.ts`.

**Count assertions to re-check after the run**
- [ ] Test file count still **37** (no new files created; new tests go into the existing `queue.test.ts`).
- [ ] Test count is **732 + (number of new `it`s you added)**, and 0 failed.

---

## 4. Acceptance checklist

Run from the repo root.

**1. Full suite green — the primary gate**
```bash
pnpm -s test
```
- [ ] `Test Files  37 passed (37)`
- [ ] `Tests  <732 + N> passed`, 0 failed, 0 skipped.
- [ ] If you see `TypeError: ... is not a constructor` or `undefined is not a constructor` in lambda tests → you skipped the core rebuild (Step 5). Run `pnpm --filter @telos/core build` and re-run.

**2. Both packages compile**
```bash
pnpm -r run build
```
- [ ] Exits 0. Note: `__tests__/` is outside each `tsconfig.json`'s `include`, and vitest does not type-check — so **test-file type errors will not surface here or in `pnpm -s test`**. Read your new test code carefully, or spot-check with `npx tsc --noEmit -p packages/core/tsconfig.json` after temporarily adding `__tests__` to `include` if you want certainty.

**3. Lint / format clean**
```bash
pnpm lint
```
- [ ] Exits 0 (biome: single quotes, trailing commas, 100-col).

**4. Requirement 1 — `QueueBackend` interface**
```bash
grep -n "sendBatch" packages/core/src/queue/backend.ts
```
- [ ] Signature reads `sendBatch(entries: QueueEntry[]): Promise<{ failedIds: string[] }>` with `QueueEntry = { id; body; groupId }`.

**5. Requirement 2 — both implementations exported from the queue index**
```bash
node -e "import('./packages/core/dist/index.js').then(m => console.log(typeof m.SqsQueueBackend, typeof m.InMemoryQueueBackend))"
```
- [ ] Prints `function function` (run after `pnpm --filter @telos/core build`).

**6. Requirement 2 — `SqsQueueBackend` preserves today's behavior**
- [ ] The 8 pre-existing `enqueueWorkItems` tests in `packages/core/__tests__/queue.test.ts` pass with only the second argument changed — in particular `toHaveBeenCalledTimes(3)` for 25 items and `Entries` lengths `10/10/3` for 23 items.
- [ ] `packages/lambdas/__tests__/webhook-handler.test.ts` passes untouched (proves `QueueUrl`, `Id`, `MessageBody`, `MessageGroupId` are byte-identical end-to-end through a real handler).
```bash
pnpm vitest run packages/core/__tests__/queue.test.ts packages/lambdas/__tests__/webhook-handler.test.ts
```

**7. Requirement 3 — new signature everywhere, shared batching**
```bash
grep -rn "enqueueWorkItems(.*sqsClient" packages --include='*.ts'
grep -rn "sqsClient,$" packages/lambdas/src
grep -rn "queueBackend" packages/lambdas/src | wc -l
```
- [ ] First two commands return nothing.
- [ ] Third returns **36** (15 construction lines + 21 call sites).
- [ ] `packages/core/src/queue/index.ts` contains the only `BATCH_SIZE` / `slice` / `String(index)` logic; neither backend file contains `slice(` or `BATCH_SIZE`.
- [ ] New test confirms `InMemoryQueueBackend.sent` ids for 25 items are `0..9, 0..9, 0..4` — identical indexing to what SQS receives.

**8. Requirement 4 — `RetryableError` on `failedIds`**
- [ ] New test asserts `rejects.toThrow(RetryableError)` (the class, not just a string) and that the message contains each failed id.
- [ ] New test asserts a batch-2 failure with 25 items calls `sendBatch` exactly twice.

**9. Requirement 5 — no test assertions weakened**
```bash
git diff --stat
```
- [ ] The only changed test file is `packages/core/__tests__/queue.test.ts`.
```bash
git diff packages/core/__tests__/queue.test.ts
```
- [ ] Every removed line inside the pre-existing `describe('enqueueWorkItems')` block differs from its replacement **only** by `client` → `new SqsQueueBackend(client)`. No `expect(...)` line was removed, reworded, or renumbered.

**10. Requirement 6 — new tests at consistent depth**
- [ ] `InMemoryQueueBackend` has ≥6 `it`s covering: accumulation, `failedIds` empty, per-batch id reset over 25 items, body JSON round-trip, `groupId`, empty-input, and no env dependency.
- [ ] The `failedIds` path has ≥4 `it`s (throws / message names ids / empty passes / stops after failing batch), plus the `SqsQueueBackend` `Failed`-array cases.

**11. Final confirmation**
```bash
pnpm -r run build && pnpm -s test && pnpm lint
```
- [ ] All three exit 0 in one chain. Only then report done, quoting the final `Test Files` / `Tests` counts.