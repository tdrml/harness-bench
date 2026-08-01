/** harness-bench holdout (tb1): DynamoDB services take tableName explicitly. */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsService } from '../src/dynamodb/projects.js';
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
  DYNAMODB_TABLE_PROJECTS: 'env-projects-table',
  DYNAMODB_TABLE_TASK_GRAPHS: 'telos-task-graphs',
  DYNAMODB_TABLE_RUNS: 'telos-runs',
  DYNAMODB_TABLE_TASK_OUTPUTS: 'telos-task-outputs',
  DYNAMODB_TABLE_REPO_LOCKS: 'env-locks-table',
  REPO_LOCK_TTL_SECONDS: '1800',
};
process.env = { ...process.env, ...REQUIRED_ENV };

function makeClient() {
  return { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
}

describe('holdout tb1: explicit table names', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
  });

  it('RepoLocksService uses the constructor tableName, not the env value', async () => {
    const client = makeClient();
    const svc = new (RepoLocksService as unknown as new (c: unknown, t: string) => RepoLocksService)(client, 'injected-locks');
    await svc.acquireLock('acme/app', 'owner-1');
    const cmd = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(cmd.input.TableName).toBe('injected-locks');
  });

  it('ProjectsService uses the constructor tableName on reads', async () => {
    const client = makeClient();
    const svc = new (ProjectsService as unknown as new (c: unknown, t: string) => ProjectsService)(client, 'injected-projects');
    const anySvc = svc as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const method = anySvc['getProject'] ?? anySvc['get'];
    if (method) await method.call(svc, 'proj-1').catch(() => {});
    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0].input.TableName).toBe('injected-projects');
  });
});
