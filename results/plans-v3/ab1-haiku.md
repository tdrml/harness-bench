Perfect. Now I have all the context. Let me create the implementation plan.

---

# Implementation Plan: Convert `enqueue` to Params Object

## Spec-critical Details

- New function signature: `enqueue(params: { queueUrl: string; workItem: WorkItem; options?: EnqueueOptions; sqsClient?: SQSClient }): Promise<void>`
- Old positional signature removed entirely (no overloads)
- All existing behavior preserved: default SQSClient construction, message group ID derivation (RECONCILE-per-runId rule), deduplication ID handling, delaySeconds semantics
- Total call sites to migrate: 44 (10 in tests, 34 in lambda handlers)
- Export location: `packages/core/src/queue/index.ts` (no changes needed there—only function signature)
- EnqueueOptions interface unchanged: `{ deduplicationId?: string; messageGroupId?: string; delaySeconds?: number }`
- Message group ID logic unchanged: "global" if no projectId, "projectId-type" for most, "projectId-RECONCILE-runId" for RECONCILE items
- Deduplication ID pattern unchanged: "type-projectId-timestamp" or override via options

## Ordered Steps

### 1. Update function signature (packages/core/src/queue/enqueue.ts)
- Change `enqueue` function signature from 4 positional parameters to single params object
- Destructure params in function body: `const { queueUrl, workItem, options, sqsClient } = params`
- Preserve all internal logic unchanged (getProjectId, messageGroupId derivation, deduplicationId generation, client construction, SendMessageCommand)
- Pattern reference: Use TypeScript function parameter destructuring style seen in this codebase

### 2. Update tests (packages/core/src/queue/__tests__/queue.test.ts)
- 10 call sites to migrate (all 10 calls in the enqueue test suite)
- Lines: 121, 143, 153, 163, 176, 186, 196, 207, 223, 235
- Convert each from positional: `enqueue(queueUrl, item, options, client)` → object: `enqueue({ queueUrl, workItem: item, options, sqsClient: client })`
- Omit sqsClient/options if undefined or not needed (idiomatic: `enqueue({ queueUrl, workItem: item })` instead of passing `undefined`)
- All test assertions remain unchanged (they verify the SendMessageCommand calls, not the call syntax)
- Note: Test at line 235 passes no options or client—becomes `enqueue({ queueUrl, workItem: item })`

### 3. Update lambda handlers (packages/lambdas/src/handlers/)
Migrate 34 call sites across the following files (listed with line counts):

**Single-line calls (migrate inline with object shorthand):**
- bootstrap-project.ts:82 — convert to `enqueue({ queueUrl: config.SQS_QUEUE_URL, workItem: { ... } })`
- bootstrap-repo.ts:220
- continuity-audit.ts:91
- continuity-check.ts:120
- continuity-fixer.ts:91
- generate-outline.ts:88
- plan-chapters.ts:82
- review-chapter.ts:133
- trigger-next-chapter.ts:46, 65
- webhook-handler.ts:90, 117, 132, 160

**Multi-line calls (maintain formatting with params object):**
- create-issues.ts:52, 139
- merge-chapter.ts:131, 139, 189
- rate-limit-recovery.ts:162, 170, 180, 193, 206, 219, 228
- reconcile-enqueuer.ts:224, 297, 349
- reconcile.ts:35
- revise-chapter.ts:102, 160
- trigger-chapter.ts:109, 162

**Special case — helper function:**
- reconcile.ts: Update `enqueueReaction` helper (lines 30–38) to pass single params object to enqueue

### 4. Verify consistency sweep

Count assertions and ensure no behavioral change:
- [ ] Test suite has 10 enqueue calls — all migrated to params object
- [ ] 34 handler enqueue calls migrated — verify no calls remain with positional signature
- [ ] All test assertions pass (expect no weaker coverage, only signature change)
- [ ] No new test fixtures or counts added (existing tests already cover: default client, message group ID derivation, deduplication ID generation, RECONCILE-per-runId rule, custom overrides)

### 5. Acceptance checklist

Run before declaring done:
- [ ] `pnpm -s install` — rebuild workspace (if package.json lockfile changed)
- [ ] `pnpm -s build` — full build succeeds with no type errors
- [ ] `pnpm -s test` — full test suite passes (all 10 queue tests + all handler tests green)
- [ ] Manual grep: `grep -r "enqueue(" --include="*.ts" packages/core packages/lambdas` — verify NO remaining calls with old positional signature (should all be `enqueue({` with object destructuring)
- [ ] Spot-check 3 handler files for idiomatic object shorthand: e.g., `await enqueue({ queueUrl: config.SQS_QUEUE_URL, workItem: { type: '...', projectId: '...' } })`