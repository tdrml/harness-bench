You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory.

CI reports the test suite is FAILING on the current commit. No further details were captured from the CI run.

Diagnose the root cause or causes and fix the CODE so the full test suite passes.

Rules:
- Do not add or modify any test files - tests are the specification.
- Verify with: pnpm -s test
- Keep changes minimal and idiomatic.

When the suite is green, state the root cause(s) and your fix(es) briefly.
