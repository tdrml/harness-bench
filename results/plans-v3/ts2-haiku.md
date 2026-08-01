Now I'll write a comprehensive implementation plan based on my review of the codebase.

---

# Implementation Plan: Takeover Grace Period for RepoLocksService

## 1. Spec-Critical Details

- **New signature:** `acquireLock(repoFullName: string, lockOwner: string, opts?: { takeoverGraceSeconds?: number })`
- **Default takeoverGraceSeconds:** 30 seconds
- **Grace period mechanism:** A lock may only be taken over when the existing lock has been EXPIRED for at least the grace period
- **Condition expression:** stays as `attribute_not_exists(repoFullName) OR #ttl < :now`
- **:now value:** computed as `currentEpochSeconds - takeoverGraceSeconds`
- **New lock TTL:** unchanged, remains `currentEpochSeconds + REPO_LOCK_TTL_SECONDS` (NOT shifted by grace)
- **Backward compatibility:** `{ takeoverGraceSeconds: 0 }` must reproduce today's behavior exactly (`:now` = `currentEpochSeconds`)

## 2. Ordered Steps

### Step 1: Update RepoLocksService.acquireLock signature and implementation
**File:** `packages/core/src/dynamodb/repo-locks.ts`

- Add type for options: `interface AcquireLockOptions { takeoverGraceSeconds?: number }`
- Update method signature to accept optional `opts` parameter
- Compute grace period: `const graceSeconds = opts?.takeoverGraceSeconds ?? 30`
- Modify `:now` calculation: `const now = Math.floor(Date.now() / 1000); const checkTime = now - graceSeconds`
- Pass `checkTime` instead of `now` to ExpressionAttributeValues (`:now: checkTime`)
- Keep TTL calculation unchanged: `const ttl = now + config.REPO_LOCK_TTL_SECONDS` (using original `now`, not `checkTime`)
- Verify the ConditionExpression remains exactly: `'attribute_not_exists(repoFullName) OR #ttl < :now'`
- Follow the existing pattern: error handling with `ConditionalCheckFailedException` → `LockConflictError` stays the same

### Step 2: Add tests for new grace period behavior
**File:** `packages/core/__tests__/dynamodb.test.ts` (within the `RepoLocksService` suite, lines 456–563)

- **Test: grace period default (30 seconds)**
  - Acquire a lock normally with no opts
  - Verify ExpressionAttributeValues[':now'] equals Math.floor(Date.now() / 1000) - 30
  - Verify Item.ttl still equals Math.floor(Date.now() / 1000) + 1800 (unchanged)

- **Test: custom grace period (45 seconds)**
  - Call acquireLock with `{ takeoverGraceSeconds: 45 }`
  - Verify ExpressionAttributeValues[':now'] equals Math.floor(Date.now() / 1000) - 45
  - Verify Item.ttl still equals Math.floor(Date.now() / 1000) + 1800 (unchanged)

- **Test: zero grace period (backward compatibility)**
  - Call acquireLock with `{ takeoverGraceSeconds: 0 }`
  - Verify ExpressionAttributeValues[':now'] equals Math.floor(Date.now() / 1000) (same as today)
  - Verify Item.ttl still equals Math.floor(Date.now() / 1000) + 1800
  - Verify behavior matches the original test exactly

- **Test: lock can only be taken when expired plus grace period has passed**
  - Set up a lock with ttl = now - 20 (expired 20 seconds ago)
  - With default grace (30), it should NOT be takeable (20 < 30)
  - The condition should fail and throw LockConflictError
  - Add separate test: set up a lock with ttl = now - 35 (expired 35 seconds ago)
  - With default grace (30), it SHOULD be takeable (35 > 30)
  - The PutCommand should succeed

## 3. Consistency Sweep

- [ ] **RepoLocksService constructor:** no changes needed
- [ ] **isLocked() method:** no changes needed (remains unchanged per requirement)
- [ ] **releaseLock() method:** no changes needed (remains unchanged per requirement)
- [ ] **getLock() method:** no changes needed
- [ ] **Types:** verify RepoLock interface in `packages/core/src/dynamodb/types.ts` needs no updates (grace is runtime-only, not stored)
- [ ] **Existing tests:** 
  - [ ] Test "acquireLock calls PutCommand with conditional expression" (line 462–473): should still pass, only :now value changes
  - [ ] Test "acquireLock sets TTL using REPO_LOCK_TTL_SECONDS" (line 475–484): must still pass, TTL calculation is unchanged
  - [ ] Test "acquireLock throws LockConflictError when condition fails" (line 486–494): still passes (error path unchanged)
  - [ ] Test "acquireLock re-throws non-conditional errors" (line 496–500): still passes (error handling unchanged)
  - [ ] All releaseLock tests (line 502–520): no changes needed
  - [ ] All getLock tests (line 522–535): no changes needed
  - [ ] All isLocked tests (line 537–562): no changes needed
- [ ] **Lambda/CDK usages:** the step-functions CDK construct at `packages/cdk/lib/constructs/step-functions.ts` defines an `acquireLockFn` Lambda, but that handler is not visible in the grep results. Since no handlers are calling `.acquireLock()` directly, the Lambda layer likely wraps the service. Verify no signature breaking downstream: the opts parameter is optional, so existing calls remain compatible.
- [ ] **Index/exports:** verify `packages/core/src/dynamodb/index.ts` exports RepoLocksService (no changes to export needed)

## 4. Acceptance Checklist

- [ ] Run `pnpm -s build` — all packages build successfully
- [ ] Run `pnpm -s test` — full test suite passes GREEN (including new grace-period tests)
- [ ] Verify new tests cover:
  - [ ] Default grace period (30 seconds) applied when no opts provided
  - [ ] Custom grace period respected when provided
  - [ ] Zero grace period reproduces original behavior (`:now = currentEpochSeconds`)
  - [ ] New lock's TTL is always `now + REPO_LOCK_TTL_SECONDS`, regardless of grace
  - [ ] Takeover succeeds only when existing lock has been expired for ≥ grace seconds
- [ ] Verify backward compatibility:
  - [ ] Existing calls like `acquireLock('repo', 'owner')` still work (opts is optional)
  - [ ] All existing tests pass without modification
- [ ] Verify the condition expression `'attribute_not_exists(repoFullName) OR #ttl < :now'` is unchanged in the code
- [ ] Verify no callers of acquireLock are affected (opts is optional, so no signature-breaking change)