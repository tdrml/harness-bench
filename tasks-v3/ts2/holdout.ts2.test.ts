/** harness-bench holdout (ts2): takeover grace semantics, exact numbers. */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoLocksService } from '../src/dynamodb/repo-locks.js';

const REQUIRED_ENV: Record<string, string> = {
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo',
  SQS_DLQ_URL: 'https://sqs.us-east-1.amazonaws.com/123/dlq.fifo',
  ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123:cluster/telos',
  ECS_SUBNETS: 'subnet-aaa',
  ECS_SECURITY_GROUP: 'sg-aaa',
  GITHUB_APP_ID: '42',
  GITHUB_PRIVATE_KEY_PARAM: '/telos/github/private-key',
  GITHUB_WEBHOOK_SECRET_PARAM: '/telos/github/webhook-secret',
  ANTHROPIC_API_KEY_PARAM: '/telos/anthropic/api-key',
  ECR_IMAGE_URI: '123.dkr.ecr.us-east-1.amazonaws.com/telos:latest',
  DYNAMODB_TABLE_PROJECTS: 'telos-projects',
  DYNAMODB_TABLE_TASK_GRAPHS: 'telos-task-graphs',
  DYNAMODB_TABLE_RUNS: 'telos-runs',
  DYNAMODB_TABLE_TASK_OUTPUTS: 'telos-task-outputs',
  DYNAMODB_TABLE_REPO_LOCKS: 'telos-repo-locks',
  REPO_LOCK_TTL_SECONDS: '1800',
};
process.env = { ...process.env, ...REQUIRED_ENV };

function makeClient() {
  return { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
}
type Svc = { acquireLock: (r: string, o: string, opts?: { takeoverGraceSeconds?: number }) => Promise<void> };
function makeSvc(client: DynamoDBDocumentClient): Svc {
  try {
    return new (RepoLocksService as unknown as new (c: unknown, t: string) => Svc)(client, 'telos-repo-locks');
  } catch {
    return new (RepoLocksService as unknown as new (c: unknown) => Svc)(client);
  }
}

describe('holdout ts2: takeover grace', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
  });

  it('default grace 30: :now is currentEpoch - 30', async () => {
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    await makeSvc(client).acquireLock('acme/app', 'o1');
    const after = Math.floor(Date.now() / 1000);
    const now = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input.ExpressionAttributeValues[':now'] as number;
    expect(now).toBeGreaterThanOrEqual(before - 30);
    expect(now).toBeLessThanOrEqual(after - 30);
  });

  it('custom grace honored', async () => {
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    await makeSvc(client).acquireLock('acme/app', 'o1', { takeoverGraceSeconds: 120 });
    const after = Math.floor(Date.now() / 1000);
    const now = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input.ExpressionAttributeValues[':now'] as number;
    expect(now).toBeGreaterThanOrEqual(before - 120);
    expect(now).toBeLessThanOrEqual(after - 120);
  });

  it('grace 0 reproduces legacy behavior', async () => {
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    await makeSvc(client).acquireLock('acme/app', 'o1', { takeoverGraceSeconds: 0 });
    const after = Math.floor(Date.now() / 1000);
    const now = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input.ExpressionAttributeValues[':now'] as number;
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('new lock ttl is NOT shifted by grace', async () => {
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    await makeSvc(client).acquireLock('acme/app', 'o1');
    const after = Math.floor(Date.now() / 1000);
    const ttl = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input.Item.ttl as number;
    expect(ttl).toBeGreaterThanOrEqual(before + 1800);
    expect(ttl).toBeLessThanOrEqual(after + 1800);
  });
});
