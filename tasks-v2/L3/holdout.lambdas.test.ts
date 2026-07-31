/** harness-bench holdout (L3): pull_request review_requested webhook flow. */
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
const WEBHOOK_SECRET = 'test-webhook-secret';

// Env must be live BEFORE the handler import: implementations may idiomatically
// initialize config-dependent services at module scope (the handler already
// creates module-level AWS clients), and getConfig() Zod-validates the env.
process.env = { ...process.env, ...REQUIRED_ENV };

const mockSsmSend = vi.fn();
const mockSqsSend = vi.fn();
const mockDdbSend = vi.fn();
const mockEnqueue = vi.fn();

const MATCHING_TASK = {
  projectId: 'proj-1',
  taskId: 'task-7',
  prNumber: 42,
  status: 'IN_REVIEW',
  title: 'sample task',
  description: 'sample',
  dependsOn: [],
  branchName: 'feat/sample',
};

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: vi.fn((input) => ({ input })),
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: vi.fn((input) => ({ input })),
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockDdbSend })),
  ConditionalCheckFailedException: class extends Error {},
}));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (name: string) => vi.fn((input) => ({ __cmd: name, input }));
  return {
    DynamoDBDocumentClient: { from: vi.fn(() => ({ send: mockDdbSend })) },
    QueryCommand: cmd('Query'),
    ScanCommand: cmd('Scan'),
    GetCommand: cmd('Get'),
    PutCommand: cmd('Put'),
    UpdateCommand: cmd('Update'),
    DeleteCommand: cmd('Delete'),
  };
});
vi.mock('@telos/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueWorkItems: mockEnqueue,
    createDynamoDBClient: vi.fn(() => ({ send: mockDdbSend })),
  };
});

const { handler } = await import('../src/handlers/webhook-handler.js');

function makeSignature(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

function makeEvent(payload: unknown, githubEvent: string): APIGatewayProxyEventV2 {
  const body = JSON.stringify(payload);
  return {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    rawQueryString: '',
    headers: {
      'x-hub-signature-256': makeSignature(body),
      'x-github-event': githubEvent,
      'content-type': 'application/json',
    },
    requestContext: {} as APIGatewayProxyEventV2['requestContext'],
    body,
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

function prPayload(action: string, prNumber = 42) {
  return {
    action,
    number: prNumber,
    pull_request: { number: prNumber },
    repository: { full_name: 'acme/app', name: 'app', owner: { login: 'acme' } },
  };
}

describe('holdout L3: pull_request review_requested', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
    vi.clearAllMocks();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: WEBHOOK_SECRET } });
    mockSqsSend.mockResolvedValue({});
    mockDdbSend.mockResolvedValue({ Items: [MATCHING_TASK], Item: MATCHING_TASK, Count: 1 });
    mockEnqueue.mockResolvedValue(undefined);
  });

  it('enqueues exactly one REVIEW_PR item and returns 202 for a matching PR', async () => {
    const res = (await handler(makeEvent(prPayload('review_requested'), 'pull_request'))) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('queued');
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const items = mockEnqueue.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]['type']).toBe('REVIEW_PR');
    expect(items[0]['prNumber']).toBe(42);
    expect(items[0]['taskId']).toBe('task-7');
    expect(items[0]['projectId']).toBe('proj-1');
    expect(items[0]['repoFullName']).toBe('acme/app');
    expect(items[0]['correlationId']).toBeTruthy();
  });

  it('ignores other pull_request actions without enqueueing', async () => {
    const res = (await handler(makeEvent(prPayload('opened'), 'pull_request'))) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('ignores review_requested for an unknown PR without enqueueing', async () => {
    mockDdbSend.mockResolvedValue({ Items: [], Count: 0 });
    const res = (await handler(makeEvent(prPayload('review_requested', 999), 'pull_request'))) as {
      statusCode: number;
    };
    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});
