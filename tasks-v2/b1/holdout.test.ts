/** harness-bench holdout (b1): lock takeover only on EXPIRED ttl. */
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

function makeClient() {
  return { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
}

describe('holdout b1: acquireLock takeover condition', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
    vi.resetModules();
  });

  it('compares the existing ttl against the CURRENT time, not a future time', async () => {
    const before = Math.floor(Date.now() / 1000);
    const client = makeClient();
    await new RepoLocksService(client).acquireLock('acme/app', 'owner-1');
    const after = Math.floor(Date.now() / 1000);
    const cmd = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const now = cmd.input.ExpressionAttributeValues[':now'] as number;
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('new lock ttl sits exactly REPO_LOCK_TTL_SECONDS beyond the takeover threshold', async () => {
    const client = makeClient();
    await new RepoLocksService(client).acquireLock('acme/app', 'owner-1');
    const cmd = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const now = cmd.input.ExpressionAttributeValues[':now'] as number;
    expect((cmd.input.Item.ttl as number) - now).toBe(1800);
  });
});
