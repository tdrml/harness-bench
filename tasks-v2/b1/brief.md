You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is currently GREEN.

Production bug report:
"Twice this week, two dev-agent workers held the repo lock for the SAME repository at the same time and pushed interleaved commits. Repo locks must be exclusive: a second owner may only take a lock over when the existing lock's TTL has already expired. Nothing in our telemetry shows locks being released early."

Find the defect responsible and fix it.

Rules:
- Do not add or modify any test files - tests are the specification.
- Verify with: pnpm -s test
- Keep changes minimal and idiomatic.

When done, state the root cause and your fix briefly.
