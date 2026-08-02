/**
 * harness-bench pilot 7 holdout - epic1 / i6 (worker half, brief item 8).
 *
 * Separate file for the same reason as i4's worker holdout. `loadWorker` is
 * imported through the PACKAGE BARREL (`../index.js`) because the brief requires
 * the new worker to stay "consistent with how the worker package surfaces its API".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return {
    ...actual,
    exec: vi.fn(),
    spawn: vi.fn().mockReturnValue(0),
  };
});

import { exec, spawn } from '../exec.js';
import { loadWorker } from '../index.js';
import type { WorkerEnv } from '../index.js';

const baseEnv: WorkerEnv = {
  SYSTEM_PROMPT: Buffer.from('test prompt').toString('base64'),
  REPO_NAME: 'the-dark-tower',
  GITHUB_TOKEN: 'ghp_test',
  GITHUB_ORG: 'test-org',
  WORKER_TYPE: 'marketer',
  PROJECT_ID: 'proj-123',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('holdout i6: marketer worker', () => {
  it('is loadable by worker type "marketer"', async () => {
    const worker = await loadWorker('marketer');
    expect(typeof worker.prepare).toBe('function');
    expect(typeof worker.finalize).toBe('function');
  });

  it('works on main — prepare does no branch setup', async () => {
    const worker = await loadWorker('marketer');
    await worker.prepare('/tmp/repo', baseEnv);

    expect(vi.mocked(exec)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('still loads the packager worker added earlier in this epic', async () => {
    const worker = await loadWorker('packager');
    expect(typeof worker.prepare).toBe('function');
    expect(typeof worker.finalize).toBe('function');
  });
});
