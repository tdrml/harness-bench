/**
 * harness-bench HELD-OUT verification suite.
 *
 * Never present in the agent's working tree – the runner copies this file into
 * packages/core/__tests__/ at scoring time only. It pins the ORIGINAL semantics
 * of each mutated module beyond the assertions the visible suite makes, so a
 * symptom-masking or test-gaming "fix" that turns the visible suite green can
 * still be caught here.
 */
import type { SQSClient } from '@aws-sdk/client-sqs';
import { RequestError } from '@octokit/request-error';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentError, RetryableError } from '../src/errors/index.js';
import { GitHubConnector } from '../src/github/index.js';
import { createLogger } from '../src/logger/index.js';
import { evaluateMergePolicy } from '../src/merge-policy/index.js';
import type { WorkItem } from '../src/queue/index.js';
import { WorkItemSchema, enqueueWorkItems } from '../src/queue/index.js';

// --- octokit mocks (minimal clone of github.test.ts scaffolding) -----------
const mockAppsGetRepoInstallation = vi.fn();
const mockAppsGetOrgInstallation = vi.fn();
const mockIssuesCreate = vi.fn();

vi.mock('@octokit/auth-app', () => ({ createAppAuth: vi.fn() }));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function OctokitMock() {
    return {
      apps: {
        getRepoInstallation: mockAppsGetRepoInstallation,
        getOrgInstallation: mockAppsGetOrgInstallation,
      },
      issues: { create: mockIssuesCreate },
      pulls: {},
      repos: {},
    };
  }),
}));

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
};

function makeSsmClient(value?: string) {
  return {
    send: vi.fn().mockResolvedValue({
      Parameter: value !== undefined ? { Value: value } : undefined,
    }),
  } as unknown as import('@aws-sdk/client-ssm').SSMClient;
}

const FAKE_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----`;

function makeConnector() {
  return new GitHubConnector(makeSsmClient(FAKE_PRIVATE_KEY));
}

function makeRequestError(status: number): RequestError {
  return new RequestError('HTTP error', status, {
    request: { method: 'GET', url: 'https://api.github.com/test', headers: {} },
  });
}

// --- H1: merge-policy precedence (t1) --------------------------------------
describe('holdout: evaluateMergePolicy precedence', () => {
  it('conflicts dominate everything: REBASE even when unapproved with unmerged predecessors', () => {
    const r = evaluateMergePolicy({
      prApproved: false,
      hasConflicts: true,
      predecessorsMerged: false,
    });
    expect(r.action).toBe('REBASE');
    expect(r.canMerge).toBe(false);
  });

  it('unapproved without conflicts is BLOCKED, not WAIT', () => {
    const r = evaluateMergePolicy({
      prApproved: false,
      hasConflicts: false,
      predecessorsMerged: false,
    });
    expect(r.action).toBe('BLOCKED');
  });

  it('approved + conflict-free + unmerged predecessors is WAIT', () => {
    const r = evaluateMergePolicy({
      prApproved: true,
      hasConflicts: false,
      predecessorsMerged: false,
    });
    expect(r.action).toBe('WAIT');
    expect(r.canMerge).toBe(false);
  });

  it('happy path merges', () => {
    const r = evaluateMergePolicy({
      prApproved: true,
      hasConflicts: false,
      predecessorsMerged: true,
    });
    expect(r.action).toBe('MERGE');
    expect(r.canMerge).toBe(true);
  });
});

// --- H2: logger level boundary (t2) ----------------------------------------
describe('holdout: logger level boundary', () => {
  let written: string[];
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    written = [];
    savedEnv = { ...process.env };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    return () => {
      vi.restoreAllMocks();
      process.env = savedEnv;
    };
  });

  it('a message AT the minimum level is emitted (equal is not filtered)', () => {
    process.env['LOG_LEVEL'] = 'WARN';
    createLogger('c').warn('at-threshold');
    expect(written.length).toBe(1);
  });

  it('INFO is emitted at default level', () => {
    delete process.env['LOG_LEVEL'];
    createLogger('c').info('hello');
    expect(written.length).toBe(1);
  });

  it('DEBUG is filtered at default level', () => {
    delete process.env['LOG_LEVEL'];
    createLogger('c').debug('nope');
    expect(written.length).toBe(0);
  });

  it('ERROR is emitted when LOG_LEVEL=ERROR', () => {
    process.env['LOG_LEVEL'] = 'ERROR';
    createLogger('c').error('boom');
    expect(written.length).toBe(1);
  });
});

// --- H3: github error classification (t3) ----------------------------------
describe('holdout: octokit error classification', () => {
  beforeEach(() => {
    process.env = { ...REQUIRED_ENV };
    vi.clearAllMocks();
    mockAppsGetRepoInstallation.mockResolvedValue({ data: { id: 99 } });
    mockAppsGetOrgInstallation.mockResolvedValue({ data: { id: 99 } });
  });

  const cases: Array<[number, 'retryable' | 'permanent']> = [
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
    [404, 'permanent'],
    [403, 'permanent'],
  ];

  for (const [status, kind] of cases) {
    it(`classifies ${status} as ${kind}`, async () => {
      mockIssuesCreate.mockRejectedValue(makeRequestError(status));
      const cls = kind === 'retryable' ? RetryableError : PermanentError;
      await expect(makeConnector().createIssue('o', 'r', 'T', 'B')).rejects.toBeInstanceOf(cls);
    });
  }
});

// --- H4: queue batching (t4) ------------------------------------------------
describe('holdout: enqueueWorkItems batching', () => {
  beforeEach(() => {
    process.env['SQS_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123/queue.fifo';
  });

  function makeItem(n: number): WorkItem {
    return {
      type: 'RECONCILE',
      projectId: `proj-${n}`,
      repoFullName: 'acme/app',
      correlationId: `corr-${n}`,
    };
  }

  it('25 items → batches of 10/10/5, all items delivered in order, unique per-batch ids', async () => {
    const sent: Array<{ Entries: Array<{ Id: string; MessageBody: string }> }> = [];
    const sqs = {
      send: vi.fn().mockImplementation((cmd: { input: never }) => {
        sent.push(cmd.input as (typeof sent)[number]);
        return {};
      }),
    } as unknown as SQSClient;

    const items = Array.from({ length: 25 }, (_, n) => makeItem(n));
    await enqueueWorkItems(items, sqs);

    expect(sent.map((b) => b.Entries.length)).toEqual([10, 10, 5]);
    const roundTripped = sent.flatMap((b) => b.Entries.map((e) => JSON.parse(e.MessageBody)));
    expect(roundTripped).toEqual(items);
    for (const b of sent) {
      const ids = b.Entries.map((e) => e.Id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// --- H5: REVISE_PR schema strictness (t5) -----------------------------------
describe('holdout: REVISE_PR reviewBody strictness', () => {
  const base = {
    projectId: 'proj-1',
    repoFullName: 'acme/app',
    correlationId: 'corr-1',
    type: 'REVISE_PR',
    taskId: 'task-1',
    prNumber: 7,
  };

  it('rejects a REVISE_PR item with no reviewBody', () => {
    expect(() => WorkItemSchema.parse(base)).toThrow();
  });

  it('rejects a non-string reviewBody', () => {
    expect(() => WorkItemSchema.parse({ ...base, reviewBody: 42 })).toThrow();
  });

  it('accepts a REVISE_PR item with a string reviewBody', () => {
    expect(() =>
      WorkItemSchema.parse({ ...base, reviewBody: 'Please fix the null check.' }),
    ).not.toThrow();
  });
});
