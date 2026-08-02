/**
 * harness-bench pilot 7 holdout - epic1 / i8: wire the release phase end-to-end
 * + docs sync.
 *
 * This is the issue that CHANGES behavior issues 4 and 6 introduced, so it is
 * the file allowed to pin the new terminal semantics:
 *   - final review no longer ends the pipeline (brief item 1)
 *   - packager completion now chains into listing generation (brief item 2)
 * The marketer completion path (RELEASED / FAILED) is explicitly left alone by
 * this brief and is graded by i6's holdout, not here.
 *
 * As in i4/i6, the ECS launcher is mocked at `../../shared/ecs-launcher.js`
 * rather than at the `../../shared/index.js` barrel, so the mock intercepts the
 * launch through the shared helper.
 *
 * The docs assertions are deliberately narrow and literal: a number matched near
 * the wording the brief quotes, and the presence + relative order of the two new
 * stage names. Formatting (bold, list markers, casing, `PACKAGE_MANUSCRIPT` vs
 * `package-manuscript`) is tolerated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

vi.mock('@auto-graph/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auto-graph/core')>();
  return {
    ...actual,
    createDynamoClient: vi.fn().mockReturnValue({}),
    ProjectService: vi.fn(),
    TaskGraphService: vi.fn(),
    AgentRunService: vi.fn(),
    TaskOutputService: vi.fn(),
    RepoLockService: vi.fn(),
    RateLimitService: vi.fn(),
    createGitHubClient: vi.fn(),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../shared/ecs-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/ecs-launcher.js')>();
  return {
    ...actual,
    launchECSTask: vi.fn().mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/abc123'),
    getECSTaskStatus: vi.fn().mockResolvedValue({ status: 'STOPPED', exitCode: 0 }),
  };
});

import {
  ProjectService,
  TaskGraphService,
  AgentRunService,
  TaskOutputService,
  RepoLockService,
  RateLimitService,
  createGitHubClient,
  enqueue,
  ProjectType,
} from '@auto-graph/core';
import { getECSTaskStatus } from '../../shared/ecs-launcher.js';
import { handler as finalReviewHandler } from '../final-review.js';
import { handler as reconcileHandler } from '../reconcile.js';

const baseEnv = {
  AWS_REGION: 'us-east-1',
  DYNAMODB_TABLE_PREFIX: 'test',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/test.fifo',
  ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123:cluster/test',
  ECS_SUBNETS: 'subnet-abc',
  ECS_SECURITY_GROUPS: 'sg-abc',
  GITHUB_TOKEN: 'ghp_test',
  GITHUB_ORG: 'test-org',
  ORCHESTRATION_REPO: 'orchestration-repo',
  LOG_LEVEL: 'info',
};

const validProject = {
  projectId: 'proj-123',
  status: 'REVIEWING' as const,
  repoName: 'the-dark-tower',
  repoUrl: 'https://github.com/test-org/the-dark-tower',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  config: {
    projectId: 'proj-123',
    projectType: ProjectType.NOVEL,
    title: 'The Dark Tower',
    premise: 'A gunslinger pursues the Man in Black across a desert.',
    genre: 'Dark Fantasy',
    targetWordCount: 90000,
    chapterCount: 3,
    style: { voice: 'sparse and mythic', tense: 'past' as const, pov: 'third-limited' as const },
    maxRevisionRounds: 5,
    concurrencyLimit: 3,
    author: 'Jordan Vale',
  },
};

const mergedTaskGraph = {
  projectId: 'proj-123',
  version: 2,
  nodes: [
    { nodeId: 'node-1', chapterNumber: 1, title: 'One', status: 'MERGED' as const, dependencies: [], revisionRound: 0, wordCount: 30000 },
    { nodeId: 'node-2', chapterNumber: 2, title: 'Two', status: 'MERGED' as const, dependencies: [], revisionRound: 0, wordCount: 30000 },
    { nodeId: 'node-3', chapterNumber: 3, title: 'Three', status: 'MERGED' as const, dependencies: [], revisionRound: 0, wordCount: 30000 },
  ],
  edges: [],
  createdAt: '2024-01-01T00:00:00.000Z',
};

function makeRecord(body: unknown, messageId = 'msg-1'): SQSRecord {
  return {
    messageId,
    receiptHandle: 'handle',
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1000',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '1000',
    },
    messageAttributes: {},
    md5OfBody: 'abc',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
    awsRegion: 'us-east-1',
  };
}

function makeEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

let mockProjectServiceMethods: {
  get: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  setComplete: ReturnType<typeof vi.fn>;
  updateWordCount: ReturnType<typeof vi.fn>;
};
let mockAgentRunServiceMethods: {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  listByNodeId: ReturnType<typeof vi.fn>;
  listByProject: ReturnType<typeof vi.fn>;
};

function makePackagerRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-packager',
    projectId: 'proj-123',
    taskArn: 'arn:aws:ecs:us-east-1:123:task/test/pkg123',
    workerType: 'packager',
    status: 'RUNNING',
    startedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  for (const [key, value] of Object.entries(baseEnv)) {
    process.env[key] = value;
  }

  mockProjectServiceMethods = {
    get: vi.fn().mockResolvedValue(validProject),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setComplete: vi.fn().mockResolvedValue(undefined),
    updateWordCount: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(ProjectService).mockImplementation(() => mockProjectServiceMethods as never);

  vi.mocked(TaskGraphService).mockImplementation(
    () =>
      ({
        getLatest: vi.fn().mockResolvedValue(mergedTaskGraph),
        create: vi.fn().mockResolvedValue(undefined),
        updateNodeStatus: vi.fn().mockResolvedValue(undefined),
      }) as never,
  );

  mockAgentRunServiceMethods = {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(makePackagerRun()),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    listByNodeId: vi.fn().mockResolvedValue([]),
    listByProject: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(AgentRunService).mockImplementation(() => mockAgentRunServiceMethods as never);

  vi.mocked(TaskOutputService).mockImplementation(
    () => ({ save: vi.fn().mockResolvedValue(undefined), getByRun: vi.fn().mockResolvedValue([]) }) as never,
  );

  vi.mocked(RepoLockService).mockImplementation(
    () => ({ release: vi.fn().mockResolvedValue(undefined), acquire: vi.fn().mockResolvedValue(true) }) as never,
  );

  vi.mocked(RateLimitService).mockImplementation(
    () =>
      ({
        getBackoff: vi.fn().mockResolvedValue(undefined),
        resetBackoff: vi.fn().mockResolvedValue(undefined),
        tripBreaker: vi.fn().mockResolvedValue({ backoffUntil: '', consecutiveFailures: 0, isFirstTrip: false, exhausted: false }),
      }) as never,
  );

  vi.mocked(createGitHubClient).mockReturnValue({
    getFileContent: vi.fn().mockResolvedValue({
      content: Buffer.from('# Chapter 1: One\n\nprose').toString('base64'),
      path: 'manuscript/chapter-01.md',
      sha: 'abc',
      encoding: 'base64',
    }),
    createOrUpdateFile: vi.fn().mockResolvedValue(undefined),
    listPullRequests: vi.fn().mockResolvedValue([]),
    addPRComment: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ number: 1 }),
  } as never);

  vi.mocked(getECSTaskStatus).mockResolvedValue({ status: 'STOPPED', exitCode: 0 });
  vi.mocked(enqueue).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Entry (brief item 1): final review hands off to the release phase.
// ---------------------------------------------------------------------------

const finalReviewItem = { type: 'FINAL_REVIEW' as const, projectId: 'proj-123' };

describe('holdout i8: final review enters the release phase', () => {
  it('enqueues PACKAGE_MANUSCRIPT for the project', async () => {
    await finalReviewHandler(makeEvent([makeRecord(finalReviewItem)]), {} as never, () => {});

    const enqueued = vi.mocked(enqueue).mock.calls.map(([, item]) => item);
    expect(enqueued.map((item) => item.type)).toContain('PACKAGE_MANUSCRIPT');

    const packaged = enqueued.find((item) => item.type === 'PACKAGE_MANUSCRIPT');
    expect(packaged).toBeDefined();
    if (packaged && packaged.type === 'PACKAGE_MANUSCRIPT') {
      expect(packaged.projectId).toBe('proj-123');
    }
  });

  it('sets the project status to PACKAGING', async () => {
    await finalReviewHandler(makeEvent([makeRecord(finalReviewItem)]), {} as never, () => {});

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'PACKAGING');
  });

  it('no longer marks the project COMPLETE', async () => {
    await finalReviewHandler(makeEvent([makeRecord(finalReviewItem)]), {} as never, () => {});

    expect(mockProjectServiceMethods.setComplete).not.toHaveBeenCalled();
    expect(mockProjectServiceMethods.updateStatus).not.toHaveBeenCalledWith('proj-123', 'COMPLETE');
  });

  it('does not report a batch failure', async () => {
    const result = await finalReviewHandler(makeEvent([makeRecord(finalReviewItem)]), {} as never, () => {});
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Chain (brief item 2): packager completion moves to listing generation.
// ---------------------------------------------------------------------------

const reconcilePackager = { type: 'RECONCILE' as const, projectId: 'proj-123', runId: 'run-packager' };

describe('holdout i8: packager completion chains into the listing stage', () => {
  it('enqueues GENERATE_LISTING for the project', async () => {
    await reconcileHandler(makeEvent([makeRecord(reconcilePackager)]));

    const enqueued = vi.mocked(enqueue).mock.calls.map(([, item]) => item);
    expect(enqueued.map((item) => item.type)).toContain('GENERATE_LISTING');

    const listing = enqueued.find((item) => item.type === 'GENERATE_LISTING');
    expect(listing).toBeDefined();
    if (listing && listing.type === 'GENERATE_LISTING') {
      expect(listing.projectId).toBe('proj-123');
    }
  });

  it('sets the project status to RELEASING', async () => {
    await reconcileHandler(makeEvent([makeRecord(reconcilePackager)]));

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'RELEASING');
  });

  it('still marks the packager run succeeded', async () => {
    await reconcileHandler(makeEvent([makeRecord(reconcilePackager)]));

    expect(mockAgentRunServiceMethods.updateStatus).toHaveBeenCalledWith(
      'run-packager',
      'SUCCEEDED',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Docs (brief item 4)
// ---------------------------------------------------------------------------

// …/packages/lambdas/src/handlers/__tests__ → repository root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
const hld = readFileSync(join(repoRoot, 'docs', 'HLD.md'), 'utf-8');

/** "PACKAGE_MANUSCRIPT", "package-manuscript", "Package Manuscript" — all count. */
const PACKAGE_STAGE = /package[-_ ]?manuscript/i;
const LISTING_STAGE = /generate[-_ ]?listing/i;

describe('holdout i8: README describes the pipeline that now exists', () => {
  it('was read', () => {
    expect(readme.length).toBeGreaterThan(0);
  });

  it('names both new release stages', () => {
    expect(readme).toMatch(PACKAGE_STAGE);
    expect(readme).toMatch(LISTING_STAGE);
  });

  it('names them in order', () => {
    const packageAt = readme.search(PACKAGE_STAGE);
    const listingAt = readme.search(LISTING_STAGE);
    expect(packageAt).toBeGreaterThanOrEqual(0);
    expect(listingAt).toBeGreaterThan(packageAt);
  });

  it('states ten ECS Fargate worker types', () => {
    const match = /(\b\d+\b|\bten\b)[^\n]{0,16}ECS Fargate worker/i.exec(readme);
    expect(match).not.toBeNull();
    expect(match![1]!.toLowerCase()).toMatch(/^(10|ten)$/);
  });
});

describe('holdout i8: HLD describes the pipeline that now exists', () => {
  it('was read', () => {
    expect(hld.length).toBeGreaterThan(0);
  });

  it('names both new release stages', () => {
    expect(hld).toMatch(PACKAGE_STAGE);
    expect(hld).toMatch(LISTING_STAGE);
  });

  it('names them in order', () => {
    const packageAt = hld.search(PACKAGE_STAGE);
    const listingAt = hld.search(LISTING_STAGE);
    expect(packageAt).toBeGreaterThanOrEqual(0);
    expect(listingAt).toBeGreaterThan(packageAt);
  });

  it('no longer claims six agent types', () => {
    expect(hld).not.toMatch(/\bsix agent types\b/i);
  });

  it('states ten agent types', () => {
    const match = /(\b\d+\b|\bten\b)\s+agent types/i.exec(hld);
    expect(match).not.toBeNull();
    expect(match![1]!.toLowerCase()).toMatch(/^(10|ten)$/);
  });
});
