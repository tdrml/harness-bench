/**
 * harness-bench pilot 7 holdout - epic1 / i7 (lambdas half, brief item 4's
 * wiring clause: "Wire it into the merge gate only").
 *
 * A separate file from the core holdout because vitest's projects are
 * package-rooted — a `packages/core` test cannot import a lambdas handler
 * without breaking that package's `rootDir` under `tsc --build`.
 *
 * `validateWordCount` is mocked on the `@auto-graph/core` barrel. That records
 * ONLY the merge handler's own call: `evaluateMergeReadiness` reaches its copy
 * through a deep relative import inside core, so the two do not interfere.
 *
 * Numbers: NOVEL's band is [3000, 5000] (WORD_COUNT_DEFAULTS).
 *   100000 / 10 = 10000 → merge range {8000, 12000}. Both endpoints clamp into
 *   NOVEL's [3000, 5000], and since the whole range sits above the band it
 *   collapses onto the nearer bound: {5000, 5000}.
 *    39999 / 10 =  3999 → merge range {3199,  4799} → already inside the band
 * The second case is the control: it fails if the range is clamped to the band
 * unconditionally, it fails if the merge tolerance is not 0.20, and its upper
 * bound (ceil 4798.8 = 4799, not floor 4798) discriminates the rounding change
 * this issue makes to the merge stage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

vi.mock('@auto-graph/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auto-graph/core')>();
  return {
    ...actual,
    createDynamoClient: vi.fn().mockReturnValue({}),
    ProjectService: vi.fn(),
    TaskGraphService: vi.fn(),
    RepoLockService: vi.fn(),
    createGitHubClient: vi.fn(),
    validateWordCount: vi.fn().mockReturnValue({ valid: true, wordCount: 4000, deviation: 0 }),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  ProjectService,
  TaskGraphService,
  RepoLockService,
  createGitHubClient,
  validateWordCount,
  ProjectType,
} from '@auto-graph/core';
import { handler as mergeChapterHandler } from '../merge-chapter.js';

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

function makeProject(targetWordCount: number, chapterCount: number) {
  return {
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
      targetWordCount,
      chapterCount,
      style: { voice: 'sparse and mythic', tense: 'past' as const, pov: 'third-limited' as const },
      maxRevisionRounds: 5,
      concurrencyLimit: 3,
      author: 'Jordan Vale',
    },
  };
}

const validTaskGraph = {
  projectId: 'proj-123',
  version: 1,
  nodes: [
    {
      nodeId: 'node-1',
      chapterNumber: 1,
      title: 'The Gunslinger',
      status: 'REVIEWING' as const,
      dependencies: [],
      revisionRound: 0,
      issueNumber: 10,
    },
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

const mergeWorkItem = { type: 'MERGE_CHAPTER' as const, projectId: 'proj-123', nodeId: 'node-1', prNumber: 7 };

let mockProjectServiceMethods: {
  get: ReturnType<typeof vi.fn>;
  updateWordCount: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();

  for (const [key, value] of Object.entries(baseEnv)) {
    process.env[key] = value;
  }

  mockProjectServiceMethods = {
    get: vi.fn().mockResolvedValue(makeProject(100000, 10)),
    updateWordCount: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(ProjectService).mockImplementation(() => mockProjectServiceMethods as never);

  vi.mocked(TaskGraphService).mockImplementation(
    () =>
      ({
        getLatest: vi.fn().mockResolvedValue(validTaskGraph),
        updateNodeStatus: vi.fn().mockResolvedValue(undefined),
      }) as never,
  );

  vi.mocked(RepoLockService).mockImplementation(
    () => ({ release: vi.fn().mockResolvedValue(undefined) }) as never,
  );

  vi.mocked(createGitHubClient).mockReturnValue({
    getFileContent: vi.fn().mockResolvedValue({
      content: Buffer.from(Array(4000).fill('word').join(' ')).toString('base64'),
      path: 'manuscript/chapter-01.md',
      sha: 'abc',
      encoding: 'base64',
    }),
    listPRReviews: vi.fn().mockResolvedValue([
      { id: 1, state: 'APPROVED', body: 'Looks great!', submitted_at: '2024-01-02T00:00:00.000Z', user: { login: 'editor' } },
    ]),
    listPRComments: vi.fn().mockResolvedValue([]),
    addPRComment: vi.fn().mockResolvedValue(undefined),
    mergePR: vi.fn().mockResolvedValue({ sha: 'merge-sha', merged: true, message: 'Merged' }),
    closeIssue: vi.fn().mockResolvedValue(undefined),
  } as never);

  vi.mocked(validateWordCount).mockReturnValue({ valid: true, wordCount: 4000, deviation: 0 });
});

describe('holdout i7: the merge gate uses the clamped merge-stage range', () => {
  it('collapses a band that overshoots the project type onto the band bound', async () => {
    mockProjectServiceMethods.get.mockResolvedValue(makeProject(100000, 10));

    await mergeChapterHandler(makeEvent([makeRecord(mergeWorkItem)]), {} as never, () => {});

    expect(vi.mocked(validateWordCount)).toHaveBeenCalled();
    const [, range] = vi.mocked(validateWordCount).mock.calls[0]!;
    expect(range).toEqual({ min: 5000, max: 5000 });
  });

  it('leaves a band already inside the project type band alone, ceiling the upper bound', async () => {
    mockProjectServiceMethods.get.mockResolvedValue(makeProject(39999, 10));

    await mergeChapterHandler(makeEvent([makeRecord(mergeWorkItem)]), {} as never, () => {});

    expect(vi.mocked(validateWordCount)).toHaveBeenCalled();
    const [, range] = vi.mocked(validateWordCount).mock.calls[0]!;
    expect(range).toEqual({ min: 3199, max: 4799 });
  });
});
