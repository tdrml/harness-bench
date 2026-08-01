/** harness-bench holdout (tb2): expiresAt rename, persisted shape + expressions. */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoLocksService } from '../src/dynamodb/repo-locks.js';
import { TaskOutputsService } from '../src/dynamodb/task-outputs.js';

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

function makeClient(result: unknown = {}) {
  return { send: vi.fn().mockResolvedValue(result) } as unknown as DynamoDBDocumentClient;
}
function ctor<T>(C: unknown, client: DynamoDBDocumentClient, table: string): T {
  try {
    return new (C as new (c: unknown, t: string) => T)(client, table);
  } catch {
    return new (C as new (c: unknown) => T)(client);
  }
}

describe('holdout tb2: repo-locks uses expiresAt', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
  });

  it('persists expiresAt (not ttl) with the correct horizon', async () => {
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    await ctor<{ acquireLock: (r: string, o: string) => Promise<void> }>(RepoLocksService, client, 'telos-repo-locks').acquireLock('acme/app', 'o1');
    const after = Math.floor(Date.now() / 1000);
    const item = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input.Item as Record<string, unknown>;
    expect(item['ttl']).toBeUndefined();
    expect(typeof item['expiresAt']).toBe('number');
    expect(item['expiresAt'] as number).toBeGreaterThanOrEqual(before + 1800);
    expect(item['expiresAt'] as number).toBeLessThanOrEqual(after + 1800);
  });

  it('condition expression names expiresAt and no longer mentions ttl', async () => {
    const client = makeClient();
    await ctor<{ acquireLock: (r: string, o: string) => Promise<void> }>(RepoLocksService, client, 'telos-repo-locks').acquireLock('acme/app', 'o1');
    const input = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input as Record<string, never>;
    const cond = String(input['ConditionExpression']);
    expect(cond).toContain('attribute_not_exists(repoFullName)');
    expect(cond.toLowerCase()).not.toContain('ttl');
    const names = input['ExpressionAttributeNames'] as unknown as Record<string, string>;
    expect(Object.values(names)).toContain('expiresAt');
    expect(Object.values(names)).not.toContain('ttl');
    // every placeholder used in the expression must be declared
    for (const tok of cond.match(/#[A-Za-z0-9_]+/g) ?? []) expect(names[tok]).toBeDefined();
  });

  it('isLocked still reads the persisted expiry correctly', async () => {
    const future = Math.floor(Date.now() / 1000) + 999;
    const client = makeClient({ Item: { repoFullName: 'acme/app', lockOwner: 'o', expiresAt: future, acquiredAt: 'x' } });
    const svc = ctor<{ isLocked: (r: string) => Promise<boolean> }>(RepoLocksService, client, 'telos-repo-locks');
    expect(await svc.isLocked('acme/app')).toBe(true);
  });
});

describe('holdout tb2: task-outputs uses expiresAt', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
  });

  it('writeInput persists expiresAt with a 24h horizon', async () => {
    const client = makeClient();
    const before = Math.floor(Date.now() / 1000);
    const svc = ctor<{ writeInput: (r: string, i: Record<string, unknown>) => Promise<void> }>(TaskOutputsService, client, 'telos-task-outputs');
    await svc.writeInput('run-1', { foo: 'bar' });
    const after = Math.floor(Date.now() / 1000);
    const item = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input.Item as Record<string, unknown>;
    expect(item['ttl']).toBeUndefined();
    expect(item['expiresAt'] as number).toBeGreaterThanOrEqual(before + 86400);
    expect(item['expiresAt'] as number).toBeLessThanOrEqual(after + 86400);
  });

  it('writeOutput update expression declares every placeholder and targets expiresAt', async () => {
    const client = makeClient();
    const svc = ctor<{ writeOutput: (r: string, o: Record<string, unknown>) => Promise<void> }>(TaskOutputsService, client, 'telos-task-outputs');
    await svc.writeOutput('run-1', { result: 'ok' });
    const input = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0].input as Record<string, never>;
    const expr = String(input['UpdateExpression']);
    const names = input['ExpressionAttributeNames'] as unknown as Record<string, string>;
    const values = input['ExpressionAttributeValues'] as unknown as Record<string, unknown>;
    expect(Object.values(names)).toContain('expiresAt');
    expect(Object.values(names)).not.toContain('ttl');
    for (const tok of expr.match(/#[A-Za-z0-9_]+/g) ?? []) expect(names[tok]).toBeDefined();
    for (const tok of expr.match(/:[A-Za-z0-9_]+/g) ?? []) expect(values[tok]).toBeDefined();
  });
});
