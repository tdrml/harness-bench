/** harness-bench holdout (ab1): enqueue params-object signature, behavior preserved. */
import { describe, expect, it, vi } from 'vitest';
import { enqueue } from '../enqueue.js';
import type { WorkItem } from '../types.js';

function makeClient() {
  const sent: Array<{ input: Record<string, unknown> }> = [];
  const client = {
    send: vi.fn().mockImplementation((cmd: { input: Record<string, unknown> }) => {
      sent.push(cmd);
      return {};
    }),
  };
  return { client, sent };
}

describe('holdout ab1: params-object enqueue', () => {
  it('accepts a single params object and sends to the given queue', async () => {
    const { client, sent } = makeClient();
    const workItem = { type: 'RECONCILE', projectId: 'p1', runId: 'run-9' } as unknown as WorkItem;
    await (enqueue as unknown as (p: Record<string, unknown>) => Promise<void>)({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q.fifo',
      workItem,
      sqsClient: client,
    });
    expect(sent.length).toBe(1);
    expect(sent[0].input['QueueUrl']).toBe('https://sqs.us-east-1.amazonaws.com/1/q.fifo');
  });

  it('preserves the RECONCILE per-runId message group rule', async () => {
    const { client, sent } = makeClient();
    const workItem = { type: 'RECONCILE', projectId: 'p1', runId: 'run-9' } as unknown as WorkItem;
    await (enqueue as unknown as (p: Record<string, unknown>) => Promise<void>)({
      queueUrl: 'q',
      workItem,
      sqsClient: client,
    });
    expect(sent[0].input['MessageGroupId']).toBe('p1-RECONCILE-run-9');
  });

  it('preserves the projectId-type group rule for other items and honors explicit messageGroupId', async () => {
    const { client, sent } = makeClient();
    const item = { type: 'MERGE_CHAPTER', projectId: 'p2' } as unknown as WorkItem;
    await (enqueue as unknown as (p: Record<string, unknown>) => Promise<void>)({ queueUrl: 'q', workItem: item, sqsClient: client });
    expect(sent[0].input['MessageGroupId']).toBe('p2-MERGE_CHAPTER');
    await (enqueue as unknown as (p: Record<string, unknown>) => Promise<void>)({
      queueUrl: 'q',
      workItem: item,
      options: { messageGroupId: 'custom-group' },
      sqsClient: client,
    });
    expect(sent[1].input['MessageGroupId']).toBe('custom-group');
  });
});
