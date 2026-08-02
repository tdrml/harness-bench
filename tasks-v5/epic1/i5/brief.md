**Issue 5 — extract `launchAgentRun` and migrate every launching handler**

Every handler that starts an ECS worker repeats the same block: generate a run id,
save the system prompt as a task output, launch the ECS task, then create the
agent-run record. It is duplicated across every launching handler in
`packages/lambdas/src/handlers/`, and the handlers do not even agree on how the run
id is generated — some use `ulid()`, some use `randomUUID()`.

1. Add `packages/lambdas/src/shared/launch-agent-run.ts` exporting:

```ts
export interface LaunchAgentRunParams {
  taskDefArn: string;
  workerType: WorkerType;
  systemPrompt: string;
  projectId: string;
  repoName: string;
  extraEnv?: Record<string, string> | undefined;
  config: HandlerContext['config'];
  agentRunService: AgentRunService;
  taskOutputService: TaskOutputService;
  nodeId?: string | undefined;
}

export async function launchAgentRun(params: LaunchAgentRunParams): Promise<{ runId: string; taskArn: string }>
```

   It must generate the run id, save the `system-prompt` task output, launch the
   ECS task with the standard environment keys (`PROJECT_ID`, `REPO_NAME`,
   `RUN_ID`, `AWS_REGION`, `DYNAMODB_TABLE_PREFIX`) merged with `extraEnv`, create
   the agent-run record with status `RUNNING` and `nodeId` when supplied, and
   return the ids. Surface it from the shared module the way its siblings are
   surfaced.

2. **Migrate every handler that launches an ECS worker** to use it. Each handler
   keeps its own behavior — its own env vars, its own prompt, its own extra
   environment entries, its own project-status update and its own follow-up
   enqueue. Only the duplicated launch block moves.

3. **Unify run-id generation on `ulid()`**, which is the majority convention and is
   already a dependency. After this issue no handler may generate a run id with
   `randomUUID()`.

4. After this issue, no handler under `packages/lambdas/src/handlers/` may call
   `agentRunService.create(...)` directly — the helper owns that write.

Existing handler tests assert the arguments passed to the ECS launch; those
assertions must still hold. Where a test asserts a UUID-shaped run id it may be
updated to the new format, but do not weaken what it checks.
