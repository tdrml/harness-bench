**Issue 6 — `GENERATE_LISTING` stage**

The release phase needs its second stage: after the manuscript is packaged, a
`marketer` worker writes the store listing, and we validate it.

This stage must be registered exactly as completely as the packager stage was
earlier in this epic — same layers, same conventions, same test harness. Reuse
what the epic has already built; do not re-implement it.

1. **Work item.** `GENERATE_LISTING`, same field shape as `PACKAGE_MANUSCRIPT`
   (`projectId` required, `runId` optional), part of the validated union, with its
   schema and inferred type (`GenerateListingItem`) reachable from
   `@auto-graph/core`.
2. **Types.** Add `'marketer'` to `WorkerType`, and `'RELEASING'` and `'RELEASED'`
   to `ProjectStatus`.
3. **Prompt.** `buildMarketerPrompt(params: MarketerPromptParams)` with
   `title: string`, `repoName: string`, `genre: string` and `projectType`,
   surfaced like the other prompt builders. It must instruct the agent to write
   `release/listing.json` containing the listing fields, and to use exactly 7
   keywords and 3 categories.
4. **Handler.** `packages/lambdas/src/handlers/generate-listing.ts`, reading
   `MARKETER_TASK_DEF_ARN`, setting project status to `RELEASING`, enqueuing
   `RECONCILE`, and using the shared launch helper introduced earlier in this
   epic — it must not re-implement the launch block.
5. **Dispatch and integration harness.** A `GENERATE_LISTING` message must reach
   your handler, both in production dispatch and in the harness the integration
   tests use to drive the pipeline.
6. **Reconcile — completion.** When a `marketer` run finishes successfully,
   reconcile must:
   - read `release/listing.json` from the `main` branch of the project repo;
   - parse it as JSON and validate it with the listing validator added earlier in
     this epic;
   - if valid, set the project status to `RELEASED`;
   - if invalid, set the project status to `FAILED` and log the error codes;
   - if the file is missing or unparseable, set the project status to `FAILED`.
7. **Reconcile — retry.** A retried `marketer` run must re-enqueue a
   `GENERATE_LISTING` item for its project.
8. **Worker.** `packages/worker/src/workers/marketer.ts` (works on `main`, no
   branch setup), loadable by worker type `marketer`, consistent with how the
   worker package surfaces its API.
9. **Infrastructure.** CDK task definition family `<prefix>-marketer`, 2048 CPU
   units, 8192 MiB, 15-minute timeout. Update any count assertions.
