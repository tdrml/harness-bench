**Issue 4 — packager handler + pipeline registration**

Wire the `PACKAGE_MANUSCRIPT` work item added earlier in this epic into the
pipeline as a real stage backed by an ECS worker. Follow the structure of the
existing launching handlers — `packages/lambdas/src/handlers/generate-outline.ts`
is the canonical example.

Required end state:

1. **Handler.** `packages/lambdas/src/handlers/package-manuscript.ts` exporting
   `handle(workItem, context)` and a `handler`, like its siblings. It must:
   - reject a work item whose `type` is not `PACKAGE_MANUSCRIPT`;
   - read the task definition ARN from `PACKAGER_TASK_DEF_ARN` and throw if unset;
   - load the project and throw if it does not exist;
   - build its system prompt with a new `buildPackagerPrompt` (see 2);
   - persist the system prompt as a task output of type `system-prompt`;
   - launch the ECS task with environment keys `PROJECT_ID`, `REPO_NAME`,
     `RUN_ID`, `AWS_REGION`, `DYNAMODB_TABLE_PREFIX`, exactly as its siblings do;
   - record an agent run with `workerType: 'packager'` and status `RUNNING`;
   - set the project status to `PACKAGING`;
   - enqueue a `RECONCILE` work item for the run.
2. **Prompt.** `buildPackagerPrompt(params: PackagerPromptParams)` in the prompts
   module, surfaced the same way the other prompt builders are. `params` must
   include `title: string`, `repoName: string`, `chapterCount: number` and
   `projectType`. The prompt must instruct the agent to assemble
   `manuscript/manuscript.md` from the chapter files and to write
   `release/manifest.json`. Branch on `projectType` the way the existing builders
   do.
3. **Dispatch.** A `PACKAGE_MANUSCRIPT` message arriving on the queue must reach
   your handler.
4. **Integration-test harness.** The integration tests under
   `packages/lambdas/src/__tests__/integration/` drive the pipeline by work-item
   type through their own harness. That harness must be able to execute a
   `PACKAGE_MANUSCRIPT` item; a later issue's end-to-end test depends on it.
5. **Reconcile — completion.** Reconcile must recognize a finished `packager` agent
   run and mark it succeeded, the way it already does for the auditor.
6. **Reconcile — retry.** Reconcile also rebuilds a work item when a run has to be
   retried. A retried `packager` run must re-enqueue a `PACKAGE_MANUSCRIPT` item
   for its project.
7. **Worker.** `packages/worker/src/workers/packager.ts` following the structure of
   the simplest existing worker (the auditor works on `main` and needs no branch
   setup; so does the packager). The worker entrypoint must be able to load a
   worker of type `packager`, and the worker package's public exports must stay
   consistent with how it surfaces its entrypoint API today.
8. **Infrastructure.** The CDK compute construct must define a task definition for
   the packager: family `<prefix>-packager`, 2048 CPU units, 8192 MiB, 30-minute
   timeout, wired like the existing eight. Any test asserting how many task
   definitions the stack creates must be updated to the new count.

The full suite and `pnpm -s build` must be green when you are done.
