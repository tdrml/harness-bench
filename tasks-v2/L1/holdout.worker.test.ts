/** harness-bench holdout (L1/worker): documenter routing. */
import { describe, expect, it } from 'vitest';
import { TASK_TYPES, createWorker } from '../src/entrypoint.js';
import { BaseWorker } from '../src/workers/base-worker.js';

describe('holdout L1: documenter worker routing', () => {
  it('TASK_TYPES includes documenter', () => {
    expect(TASK_TYPES).toContain('documenter');
  });

  it('createWorker(documenter) returns a BaseWorker', () => {
    expect(createWorker('documenter')).toBeInstanceOf(BaseWorker);
  });

  it('createWorker still rejects unknown types', () => {
    expect(() => createWorker('not-a-mode')).toThrow();
  });
});
