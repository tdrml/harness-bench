You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Refactor: make every DynamoDB service class in packages/core/src/dynamodb (ProjectsService, TaskGraphsService, RunsService, TaskOutputsService, RepoLocksService) take its table name explicitly instead of reading config in the constructor.

1. Each service's constructor becomes `(client: DynamoDBDocumentClient, tableName: string)` and must not call getConfig() at construction time.
2. Update EVERY instantiation site across the monorepo (lambda handlers, worker, helpers, tests) to pass the table name from getConfig() (e.g. `new RepoLocksService(client, getConfig().DYNAMODB_TABLE_REPO_LOCKS)`), preserving current behavior exactly.
3. Runtime behavior must be unchanged: same commands, same table names, same errors.

Rules:
- Verify with: pnpm -s build && pnpm -s test (full suite green).
- Keep changes minimal and idiomatic; follow neighboring code's conventions.
- Updating existing tests is allowed ONLY where your change legitimately alters their setup (signatures, fixtures, counts); do not weaken what they assert. Add tests for new behavior at the depth of neighboring tests.
When done, summarize your change briefly.
