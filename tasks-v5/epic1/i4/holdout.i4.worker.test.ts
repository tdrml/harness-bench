/**
 * harness-bench pilot 7 holdout - epic1 / i4 (worker half, brief item 7).
 *
 * A separate file from the lambdas holdout because vitest's projects are
 * package-rooted; `packages/worker` cannot be reached from `packages/lambdas`
 * without breaking that package's `rootDir`.
 *
 * `loadWorker` is imported through the PACKAGE BARREL (`../index.js`), not from
 * `../entrypoint.js`: the brief requires the worker package's public exports to
 * stay consistent with how it surfaces its entrypoint API today, and a module
 * that never reaches the barrel is the failure class this epic plants.
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
  WORKER_TYPE: 'packager',
  PROJECT_ID: 'proj-123',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('holdout i4: packager worker', () => {
  it('is loadable by worker type "packager"', async () => {
    const worker = await loadWorker('packager');
    expect(typeof worker.prepare).toBe('function');
    expect(typeof worker.finalize).toBe('function');
  });

  it('works on main — prepare does no branch setup', async () => {
    const worker = await loadWorker('packager');
    await worker.prepare('/tmp/repo', baseEnv);

    expect(vi.mocked(exec)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('finalize does no post-processing', async () => {
    const worker = await loadWorker('packager');
    await worker.finalize('/tmp/repo', baseEnv);

    expect(vi.mocked(exec)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
