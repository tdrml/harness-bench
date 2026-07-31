You are working in a TypeScript monorepo (pnpm workspaces + vitest) rooted at the current directory. The full test suite is currently GREEN.

Production bug report:
"An operator set LOG_LEVEL=verbose on one of the Lambdas (not a valid level - our levels are DEBUG/INFO/WARN/ERROR). Instead of falling back to the documented default of INFO, the service started emitting EVERYTHING including DEBUG, flooding CloudWatch. An unrecognized LOG_LEVEL value must behave exactly like the default."

Find the defect responsible and fix it.

Rules:
- Do not add or modify any test files - tests are the specification.
- Verify with: pnpm -s test
- Keep changes minimal and idiomatic.

When done, state the root cause and your fix briefly.
