/** harness-bench holdout (ts1): /cancel webhook command + CANCEL_RUN schema. */
import { createHmac } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV: Record<string, string> = {
  AWS_REGION: 'us-east-1',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo',
  SQS_DLQ_URL: 'https://sqs.us-east-1.amazonaws.com/123/dlq.fifo',
  ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123:cluster/telos',
  ECS_SUBNETS: 'subnet-aaa,subnet-bbb',
  ECS_SECURITY_GROUP: 'sg-aaa',
  GITHUB_APP_ID: '1',
  GITHUB_PRIVATE_KEY_PARAM: '/github/key',
  GITHUB_WEBHOOK_SECRET_PARAM: '/github/webhook/secret',
  ANTHROPIC_API_KEY_PARAM: '/anthropic/key',
  ECR_IMAGE_URI: '123.dkr.ecr.us-east-1.amazonaws.com/telos:latest',
  DYNAMODB_TABLE_PROJECTS: 'telos-projects',
  DYNAMODB_TABLE_TASK_GRAPHS: 'telos-task-graphs',
  DYNAMODB_TABLE_RUNS: 'telos-runs',
  DYNAMODB_TABLE_TASK_OUTPUTS: 'telos-task-outputs',
  DYNAMODB_TABLE_REPO_LOCKS: 'telos-repo-locks',
  REPO_LOCK_TTL_SECONDS: '1800',
};
process.env = { ...process.env, ...REQUIRED_ENV };
const WEBHOOK_SECRET = 'test-webhook-secret';

const mockSsmSend = vi.fn();
const mockSqsSend = vi.fn();
const mockEnqueue = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: vi.fn((input) => ({ input })),
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: vi.fn((input) => ({ input })),
}));
vi.mock('@telos/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, enqueueWorkItems: mockEnqueue };
});

const { handler } = await import('../src/handlers/webhook-handler.js');
const { WorkItemSchema } = await import('@telos/core');

function makeEvent(payload: unknown): APIGatewayProxyEventV2 {
  const body = JSON.stringify(payload);
  return {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    rawQueryString: '',
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
      'x-github-event': 'issue_comment',
      'content-type': 'application/json',
    },
    requestContext: {} as APIGatewayProxyEventV2['requestContext'],
    body,
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

function commentPayload(body: string, opts: { pr?: boolean } = {}) {
  return {
    action: 'created',
    comment: { body },
    issue: { number: 55, ...(opts.pr ? { pull_request: { url: 'x' } } : {}) },
    repository: { full_name: 'acme/app', name: 'app', owner: { login: 'acme' } },
  };
}

describe('holdout ts1: CANCEL_RUN schema', () => {
  it('accepts a CANCEL_RUN item with issueNumber', () => {
    expect(() =>
      WorkItemSchema.parse({
        type: 'CANCEL_RUN',
        projectId: 'p1',
        repoFullName: 'acme/app',
        correlationId: 'c1',
        issueNumber: 55,
      }),
    ).not.toThrow();
  });

  it('rejects CANCEL_RUN without issueNumber', () => {
    expect(() =>
      WorkItemSchema.parse({
        type: 'CANCEL_RUN',
        projectId: 'p1',
        repoFullName: 'acme/app',
        correlationId: 'c1',
      }),
    ).toThrow();
  });
});

describe('holdout ts1: /cancel handler behavior', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
    vi.clearAllMocks();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: WEBHOOK_SECRET } });
    mockSqsSend.mockResolvedValue({});
    mockEnqueue.mockResolvedValue(undefined);
  });

  it('/cancel on an issue enqueues one CANCEL_RUN and returns 202 cancel-requested', async () => {
    const res = (await handler(makeEvent(commentPayload('/cancel')))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('cancel-requested');
    expect(body.issueNumber).toBe(55);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const items = mockEnqueue.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]['type']).toBe('CANCEL_RUN');
    expect(items[0]['issueNumber']).toBe(55);
    expect(items[0]['repoFullName']).toBe('acme/app');
    expect(items[0]['correlationId']).toBeTruthy();
  });

  it('/cancel on a PR comment is ignored with the exact reason', async () => {
    const res = (await handler(makeEvent(commentPayload('/cancel', { pr: true })))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('pr comment');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('/work still enqueues ENRICH_ISSUE (existing behavior intact)', async () => {
    const res = (await handler(makeEvent(commentPayload('/work')))) as { statusCode: number };
    expect(res.statusCode).toBe(200);
    const items = mockEnqueue.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(items[0]['type']).toBe('ENRICH_ISSUE');
  });
});
