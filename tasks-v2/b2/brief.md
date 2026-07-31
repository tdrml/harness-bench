You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is currently GREEN.

Production bug report:
"When a single enqueue call carries work items for SEVERAL different repositories, we see cross-repo ordering contention: items for different repos appear to serialize behind each other as if they were in one FIFO message group. Design intent is per-repository grouping - one repo's items must never block another repo's."

Find the defect responsible and fix it.

Rules:
- Do not add or modify any test files - tests are the specification.
- Verify with: pnpm -s test
- Keep changes minimal and idiomatic.

When done, state the root cause and your fix briefly.
