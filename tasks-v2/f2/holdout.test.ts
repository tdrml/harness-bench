/** harness-bench holdout (f2): SQS partial-failure surfacing. */
import type { SQSClient } from '@aws-sdk/client-sqs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryableError } from '../src/errors/index.js';
import type { WorkItem } from '../src/queue/index.js';
import { enqueueWorkItems } from '../src/queue/index.js';

function makeItems(n: number): WorkItem[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'RECONCILE',
    projectId: 'proj-' + i,
    repoFullName: 'acme/app',
    correlationId: 'corr-' + i,
  }));
}

describe('holdout f2: SendMessageBatch Failed entries', () => {
  beforeEach(() => {
    process.env['SQS_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo';
  });

  it('throws RetryableError naming the failed entry when a batch reports Failed', async () => {
    const sqs = {
      send: vi.fn().mockResolvedValue({ Failed: [{ Id: '3', Code: 'InternalError' }] }),
    } as unknown as SQSClient;
    await expect(enqueueWorkItems(makeItems(5), sqs)).rejects.toBeInstanceOf(RetryableError);
    await expect(enqueueWorkItems(makeItems(5), sqs)).rejects.toThrow(/3/);
  });

  it('does not throw when Failed is empty or absent', async () => {
    const sqsEmpty = { send: vi.fn().mockResolvedValue({ Failed: [] }) } as unknown as SQSClient;
    await expect(enqueueWorkItems(makeItems(5), sqsEmpty)).resolves.toBeUndefined();
    const sqsAbsent = { send: vi.fn().mockResolvedValue({}) } as unknown as SQSClient;
    await expect(enqueueWorkItems(makeItems(5), sqsAbsent)).resolves.toBeUndefined();
  });
});
