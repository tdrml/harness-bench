You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Hardening: add a takeover grace period to RepoLocksService.acquireLock (packages/core/src/dynamodb/repo-locks.ts).

Exact requirements:
1. Signature: `acquireLock(repoFullName: string, lockOwner: string, opts?: { takeoverGraceSeconds?: number })`. Default takeoverGraceSeconds: 30.
2. Semantics: a lock may only be taken over when the existing lock has been EXPIRED for at least the grace period. Concretely, the conditional expression stays `attribute_not_exists(repoFullName) OR #ttl < :now`, but `:now` must be computed as `currentEpochSeconds - takeoverGraceSeconds`.
3. The NEW lock's ttl is unchanged: currentEpochSeconds + REPO_LOCK_TTL_SECONDS (NOT shifted by the grace).
4. Passing `{ takeoverGraceSeconds: 0 }` must reproduce today's behavior exactly.
5. isLocked() and releaseLock() are unchanged.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters their setup (signatures, fixtures, counts); do not weaken what they assert. Add tests for new behavior at the depth of neighboring tests.
When done, summarize your change briefly.
