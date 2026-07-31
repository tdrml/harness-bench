/** harness-bench holdout (b2): per-item FIFO grouping by repoFullName. */
import type { SQSClient } from '@aws-sdk/client-sqs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../src/queue/index.js';
import { enqueueWorkItems } from '../src/queue/index.js';

describe('holdout b2: MessageGroupId is per-item repoFullName', () => {
  beforeEach(() => {
    process.env['SQS_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo';
  });

  it('mixed-repo items in one call each carry their own repo as MessageGroupId', async () => {
    const sent: Array<{ Entries: Array<{ MessageBody: string; MessageGroupId: string }> }> = [];
    const sqs = {
      send: vi.fn().mockImplementation((cmd: { input: never }) => {
        sent.push(cmd.input as (typeof sent)[number]);
        return {};
      }),
    } as unknown as SQSClient;

    const repos = ['acme/alpha', 'acme/beta', 'acme/gamma'];
    const items: WorkItem[] = Array.from({ length: 9 }, (_, n) => ({
      type: 'RECONCILE',
      projectId: 'proj-' + n,
      repoFullName: repos[n % 3],
      correlationId: 'corr-' + n,
    }));
    await enqueueWorkItems(items, sqs);

    const entries = sent.flatMap((b) => b.Entries);
    expect(entries.length).toBe(9);
    for (const e of entries) {
      const item = JSON.parse(e.MessageBody) as WorkItem;
      expect(e.MessageGroupId).toBe(item.repoFullName);
    }
    expect(new Set(entries.map((e) => e.MessageGroupId)).size).toBe(3);
  });
});
