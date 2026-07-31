/** harness-bench holdout (L2): pluggable queue backends. */
import { beforeEach, describe, expect, it } from 'vitest';
import { RetryableError } from '../src/errors/index.js';
import type { WorkItem } from '../src/queue/index.js';

function makeItems(n: number, repo = (i: number) => 'acme/app'): WorkItem[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'RECONCILE',
    projectId: `proj-${i}`,
    repoFullName: repo(i),
    correlationId: `corr-${i}`,
  }));
}

describe('holdout L2: QueueBackend abstraction', () => {
  beforeEach(() => {
    process.env['SQS_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo';
  });

  it('exports SqsQueueBackend and InMemoryQueueBackend', async () => {
    const mod = (await import('../src/queue/index.js')) as Record<string, unknown>;
    expect(typeof mod['SqsQueueBackend']).toBe('function');
    expect(typeof mod['InMemoryQueueBackend']).toBe('function');
  });

  it('InMemoryQueueBackend captures all entries with per-item groupIds', async () => {
    const mod = (await import('../src/queue/index.js')) as Record<string, any>;
    const backend = new mod['InMemoryQueueBackend']();
    const items = makeItems(25, (i) => ['acme/alpha', 'acme/beta', 'acme/gamma'][i % 3]);
    await mod['enqueueWorkItems'](items, backend);
    expect(backend.sent.length).toBe(25);
    for (let i = 0; i < 25; i++) {
      const entry = backend.sent[i];
      const parsed = JSON.parse(entry.body) as WorkItem;
      expect(parsed).toEqual(items[i]);
      expect(entry.groupId).toBe(items[i].repoFullName);
    }
  });

  it('throws RetryableError naming failed ids when a backend reports failures', async () => {
    const mod = (await import('../src/queue/index.js')) as Record<string, any>;
    const failing = {
      sendBatch: async () => ({ failedIds: ['7'] }),
    };
    await expect(mod['enqueueWorkItems'](makeItems(5), failing)).rejects.toBeInstanceOf(RetryableError);
    await expect(mod['enqueueWorkItems'](makeItems(5), failing)).rejects.toThrow(/7/);
  });
});
