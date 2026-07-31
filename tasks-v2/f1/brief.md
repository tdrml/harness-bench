You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is GREEN.

Feature request - extend the merge policy (packages/core/src/merge-policy):

Add an optional boolean parameter `ciGreen` (default `true`) to `MergePolicyParams` and `evaluateMergePolicy`.
- When `ciGreen` is `false`: the PR cannot merge - return `canMerge: false`, `action: 'WAIT'`, and a `reason` that mentions CI.
- Precedence order (first failing condition wins): conflicts > approval > ciGreen > predecessors.
- All existing behavior must be unchanged when `ciGreen` is omitted or `true`; existing callers must keep compiling without changes.

Rules:
- Do not add or modify any test files - tests are the specification.
- Verify with: pnpm -s test
- Keep changes minimal and idiomatic.

When done, summarize your change briefly.
