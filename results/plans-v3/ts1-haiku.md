Now I have enough context. Here's the implementation plan:

---

# Implementation Plan: Add `/cancel` Comment Command

## 1. Spec-critical details

- Comment command detection: `commentBody.startsWith('/cancel')`
- New work item type name: `CANCEL_RUN`
- PR comment response: HTTP 200, body `{ status: 'ignored', reason: 'pr comment' }`
- Issue comment response: HTTP 202, body `{ status: 'cancel-requested', issueNumber: <number> }`
- Work item enqueue count: exactly one CANCEL_RUN item (issues only; zero for PRs)
- Work item type discriminator: `'CANCEL_RUN'` (literal string)
- Work item required fields: `type`, `projectId`, `repoFullName`, `correlationId`, `issueNumber`
- `issueNumber` field type: Zod `z.number().int()`
- PR detection: presence of `pull_request` property on the issue object (check `issue['pull_request'] !== undefined`)
- `projectId` value: generated via `uuidv4()` (follows `/work` pattern, not literal string)
- `correlationId` value: generated via `uuidv4()` (follows `/work` and `/retry` pattern)
- All existing commands (`/work`, `/retry`, unlabeled) remain unchanged
- All existing status codes and response bodies for other commands remain unchanged

## 2. Ordered steps

### Step 1: packages/core/src/queue/work-items.ts
**Pattern reference:** existing single-field work items like `EnrichIssueSchema` (lines 73–76) and `TriggerTaskSchema` (lines 34–37)

- After line 82 (after `QuickTaskSchema`), add:
  ```
  const CancelRunSchema = WorkItemBaseSchema.extend({
    type: z.literal('CANCEL_RUN'),
    issueNumber: z.number().int(),
  });
  ```
- Line 84: insert `CancelRunSchema` into the discriminated union array (after `QuickTaskSchema`, before the closing `]`)
- After line 117 (after `QuickTaskWorkItem` type export), add:
  ```
  export type CancelRunWorkItem = z.infer<typeof CancelRunSchema>;
  ```

### Step 2: packages/lambdas/src/handlers/webhook-handler.ts
**Pattern reference:** existing `/work` handler (lines 185–202) and `/retry` handler (lines 205–222)

- Line 224, after the `/retry` block (after line 223) and before `return respond(200, { ignored: true })`, insert:
  ```typescript
  if (commentBody.startsWith('/cancel')) {
    if (issue['pull_request'] !== undefined) {
      return respond(200, { status: 'ignored', reason: 'pr comment' });
    }

    const correlationId = uuidv4();
    const projectId = uuidv4();

    await enqueueWorkItems(
      [
        {
          type: 'CANCEL_RUN',
          projectId,
          repoFullName,
          correlationId,
          issueNumber,
        },
      ],
      sqsClient,
    );

    return respond(202, { status: 'cancel-requested', issueNumber });
  }
  ```

### Step 3: packages/lambdas/__tests__/webhook-handler.test.ts
**Pattern reference:** existing test suites for `/work` (lines 415–461) and `/retry` (lines 467–512)

- After line 512 (end of `/retry` test suite), add a new test suite:
  ```typescript
  // -------------------------------------------------------------------------
  // issue_comment /cancel → CANCEL_RUN
  // -------------------------------------------------------------------------
  describe('issue_comment /cancel → CANCEL_RUN', () => {
    it('enqueues CANCEL_RUN work item for /cancel on issue', async () => {
      const body = JSON.stringify({
        action: 'created',
        comment: { body: '/cancel' },
        issue: { number: 42, body: '' },
        repository: {
          full_name: 'acme/myapp',
          name: 'myapp',
          owner: { login: 'acme' },
        },
      });
      const event = makeWebhookEvent({ githubEvent: 'issue_comment', body });
      const result = await handler(event);

      expect(result).toMatchObject({ statusCode: 202 });
      const parsed = JSON.parse((result as { body: string }).body);
      expect(parsed.status).toBe('cancel-requested');
      expect(parsed.issueNumber).toBe(42);

      const cmd = mockSqsSend.mock.calls[0][0] as {
        input: { Entries: Array<{ MessageBody: string }> };
      };
      const workItem = JSON.parse(cmd.input.Entries[0].MessageBody);
      expect(workItem.type).toBe('CANCEL_RUN');
      expect(workItem.issueNumber).toBe(42);
      expect(workItem.repoFullName).toBe('acme/myapp');
      expect(workItem.correlationId).toBe('test-uuid');
      expect(workItem.projectId).toBe('test-uuid');
    });

    it('returns 200 { status: ignored, reason: pr comment } for /cancel on pull request', async () => {
      const body = JSON.stringify({
        action: 'created',
        comment: { body: '/cancel this PR' },
        issue: { number: 50, body: '', pull_request: { url: 'https://...' } },
        repository: {
          full_name: 'acme/myapp',
          name: 'myapp',
          owner: { login: 'acme' },
        },
      });
      const event = makeWebhookEvent({ githubEvent: 'issue_comment', body });
      const result = await handler(event);

      expect(result).toMatchObject({ statusCode: 200 });
      const parsed = JSON.parse((result as { body: string }).body);
      expect(parsed.status).toBe('ignored');
      expect(parsed.reason).toBe('pr comment');

      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('enqueues CANCEL_RUN for /cancel with extra text on issue', async () => {
      const body = JSON.stringify({
        action: 'created',
        comment: { body: '/cancel this run now' },
        issue: { number: 99, body: '' },
        repository: {
          full_name: 'acme/myapp',
          name: 'myapp',
          owner: { login: 'acme' },
        },
      });
      const event = makeWebhookEvent({ githubEvent: 'issue_comment', body });
      const result = await handler(event);

      expect(result).toMatchObject({ statusCode: 202 });
      expect(JSON.parse((result as { body: string }).body).type).toBeUndefined();
      
      const cmd = mockSqsSend.mock.calls[0][0] as {
        input: { Entries: Array<{ MessageBody: string }> };
      };
      const workItem = JSON.parse(cmd.input.Entries[0].MessageBody);
      expect(workItem.type).toBe('CANCEL_RUN');
      expect(workItem.issueNumber).toBe(99);
    });
  });
  ```

## 3. Consistency sweep

- **Existing test counts remain unchanged**: All existing test suites for `/work`, `/retry`, `issues labeled kickoff`, and error handling remain unaffected
- **No changes to existing test fixtures**: No modification to `makeEvent`, `makeWebhookEvent`, or mock setup needed
- **No changes to existing handlers**: `issues labeled kickoff` path, `/work`, `/retry`, and fallback responses remain untouched
- **No changes to other work-item types**: All existing schemas and exports in work-items.ts remain unchanged
- **SQS enqueue behavior**: One item enqueued only for issue comments (zero for PRs), matching `/work` and `/retry` pattern
- **No change to signature validation, JSON parsing, or repo extraction**: All upstream validation remains identical

## 4. Acceptance checklist

- [ ] Run `pnpm -s build` — no TypeScript errors
- [ ] Run `pnpm -s test` — all tests pass (existing + new), full suite green
- [ ] Verify new test suite runs and passes:
  - `/cancel` on issue enqueues CANCEL_RUN with correct fields (type, issueNumber, projectId, correlationId, repoFullName)
  - `/cancel` on PR returns 200 with `{ status: 'ignored', reason: 'pr comment' }` and enqueues nothing
  - `/cancel` with trailing text enqueues CANCEL_RUN correctly
- [ ] Verify response status codes:
  - `/cancel` on issue: **202** (not 200)
  - `/cancel` on PR: **200**
- [ ] Verify response bodies:
  - `/cancel` on issue: `{ status: 'cancel-requested', issueNumber: <n> }`
  - `/cancel` on PR: `{ status: 'ignored', reason: 'pr comment' }`
- [ ] Verify existing commands unchanged:
  - `/work` still responds 200, enqueues ENRICH_ISSUE
  - `/retry` still responds 200, enqueues TRIGGER_TASK
  - Unknown commands still respond 200 with `{ ignored: true }`
- [ ] Verify PR detection works: issue object with `pull_request` field (any truthy value) triggers PR path
- [ ] Verify work item structure: all CANCEL_RUN items have type, projectId, repoFullName, correlationId, issueNumber with correct types (issueNumber is integer)