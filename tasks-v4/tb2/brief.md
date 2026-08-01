You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Migration: rename the DynamoDB time-to-live attribute from `ttl` to `expiresAt` everywhere it is persisted or referenced, for BOTH tables that use it (repo-locks and task-outputs).

Requirements:
1. The attribute name stored in DynamoDB becomes `expiresAt`. This includes the item shape, the TypeScript interfaces (RepoLock, TaskOutput), and the CDK table definitions' time-to-live attribute.
2. Every DynamoDB expression that names the attribute must be updated: the repo-locks conditional-write expression, its ExpressionAttributeNames mapping, and the task-outputs update expression and its mapping. The placeholder tokens should read naturally after the rename (e.g. `#expiresAt` / `:expiresAt`) rather than keeping `#ttl`.
3. Runtime semantics are unchanged: same epoch-second values, same lock-takeover condition, same 24h task-output horizon, same lock TTL from config.
4. The env var and config key names (e.g. REPO_LOCK_TTL_SECONDS) are NOT renamed - only the persisted attribute.
5. Every test that asserts on the old attribute name, the old expression strings, or the old CDK time-to-live attribute must be updated to the new name, including any infrastructure snapshot.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters what they set up or assert about the renamed thing; do not weaken unrelated assertions.
When done, summarize your change briefly.
