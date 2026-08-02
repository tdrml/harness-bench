/**
 * harness-bench pilot 7 holdout - epic1 / i6: GENERATE_LISTING stage
 * (lambdas + core-type half; CDK and worker halves are separate files).
 *
 * Same registration surface the packager stage was graded on, plus the marketer
 * completion path in reconcile, which is what makes this stage terminal.
 *
 * As in i4's holdout, the ECS launcher is mocked at `../../shared/ecs-launcher.js`
 * rather than at the `../../shared/index.js` barrel, so the mock intercepts the
 * launch whether it is made directly or through the shared helper this stage is
 * required to reuse.
 *
 * The run id IS asserted to be ULID-shaped here: this issue lands after the
 * run-id unification and the brief requires this handler to go through the
 * shared helper rather than re-implement the launch block.
 *
 * INVARIANCE NOTE: issue 8 changes what reaches this stage (final review now
 * enqueues PACKAGE_MANUSCRIPT, packager completion now enqueues GENERATE_LISTING),
 * but it explicitly leaves the marketer completion path alone — so RELEASED /
 * FAILED are still the end-of-epic truth.
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
    AgentRunService: vi.fn(),
    TaskOutputService: vi.fn(),
    RepoLockService: vi.fn(),
    RateLimitService: vi.fn(),
    createGitHubClient: vi.fn(),
    buildMarketerPrompt: vi.fn().mockReturnValue('mock marketer prompt'),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../shared/ecs-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/ecs-launcher.js')>();
  return {
    ...actual,
    launchECSTask: vi.fn().mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/mkt123'),
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
  buildMarketerPrompt,
  enqueue,
  GenerateListingSchema,
  WorkItemSchema,
  ProjectType,
} from '@auto-graph/core';
import type {
  GenerateListingItem,
  MarketerPromptParams,
  WorkerType,
  ProjectStatus,
} from '@auto-graph/core';
import { launchECSTask, getECSTaskStatus } from '../../shared/ecs-launcher.js';
import { handle as generateListingHandle, handler as generateListingHandler } from '../generate-listing.js';
import { handler as dispatcherHandler } from '../dispatcher.js';
import { handler as reconcileHandler } from '../reconcile.js';

// Compile-time only: these have no runtime footprint but fail `tsc --build`
// if the type-level plumbing never reaches the `@auto-graph/core` barrel.
const marketerWorker: WorkerType = 'marketer';
const releasingStatus: ProjectStatus = 'RELEASING';
const releasedStatus: ProjectStatus = 'RELEASED';
const marketerTitle: MarketerPromptParams['title'] = 'The Dark Tower';
const marketerRepoName: MarketerPromptParams['repoName'] = 'the-dark-tower';
const marketerGenre: MarketerPromptParams['genre'] = 'Dark Fantasy';

/** Crockford base32, 26 characters — the ULID shape. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const MARKETER_TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123:task-definition/marketer:1';

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
  MARKETER_TASK_DEF_ARN,
  LOG_LEVEL: 'info',
};

const validProject = {
  projectId: 'proj-123',
  status: 'PACKAGING' as const,
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

const validListing = {
  title: 'The Dark Tower',
  subtitle: 'A Novel',
  blurb: 'A sweeping tale of <b>persistence</b> and consequence.',
  keywords: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
  categories: ['Fiction', 'Literary', 'Sagas'],
  author: 'Jordan Vale',
};

function base64(content: string) {
  return { content: Buffer.from(content).toString('base64'), path: 'release/listing.json', sha: 'a', encoding: 'base64' };
}

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

const listingWorkItem = { type: 'GENERATE_LISTING' as const, projectId: 'proj-123' };

function makeMarketerRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-marketer',
    projectId: 'proj-123',
    taskArn: 'arn:aws:ecs:us-east-1:123:task/test/mkt123',
    workerType: 'marketer',
    status: 'RUNNING',
    startedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let mockProjectServiceMethods: {
  get: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  setComplete: ReturnType<typeof vi.fn>;
};
let mockTaskGraphServiceMethods: { getLatest: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; updateNodeStatus: ReturnType<typeof vi.fn> };
let mockAgentRunServiceMethods: {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  listByNodeId: ReturnType<typeof vi.fn>;
  listByProject: ReturnType<typeof vi.fn>;
};
let mockTaskOutputServiceMethods: { save: ReturnType<typeof vi.fn>; getByRun: ReturnType<typeof vi.fn> };
let mockRepoLockServiceMethods: { release: ReturnType<typeof vi.fn>; acquire: ReturnType<typeof vi.fn> };
let mockRateLimitServiceMethods: { getBackoff: ReturnType<typeof vi.fn>; resetBackoff: ReturnType<typeof vi.fn>; tripBreaker: ReturnType<typeof vi.fn> };
let mockGitHubClientMethods: {
  getFileContent: ReturnType<typeof vi.fn>;
  listPullRequests: ReturnType<typeof vi.fn>;
  addPRComment: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();

  for (const [key, value] of Object.entries(baseEnv)) {
    process.env[key] = value;
  }

  mockProjectServiceMethods = {
    get: vi.fn().mockResolvedValue(validProject),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setComplete: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(ProjectService).mockImplementation(() => mockProjectServiceMethods as never);

  mockTaskGraphServiceMethods = {
    getLatest: vi.fn().mockResolvedValue({
      projectId: 'proj-123',
      version: 2,
      nodes: [
        { nodeId: 'node-1', chapterNumber: 1, title: 'One', status: 'MERGED' as const, dependencies: [], revisionRound: 0, wordCount: 30000 },
        { nodeId: 'node-2', chapterNumber: 2, title: 'Two', status: 'MERGED' as const, dependencies: [], revisionRound: 0, wordCount: 30000 },
        { nodeId: 'node-3', chapterNumber: 3, title: 'Three', status: 'MERGED' as const, dependencies: [], revisionRound: 0, wordCount: 30000 },
      ],
      edges: [],
      createdAt: '2024-01-01T00:00:00.000Z',
    }),
    create: vi.fn().mockResolvedValue(undefined),
    updateNodeStatus: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(TaskGraphService).mockImplementation(() => mockTaskGraphServiceMethods as never);

  mockAgentRunServiceMethods = {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(makeMarketerRun()),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    listByNodeId: vi.fn().mockResolvedValue([]),
    listByProject: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(AgentRunService).mockImplementation(() => mockAgentRunServiceMethods as never);

  mockTaskOutputServiceMethods = {
    save: vi.fn().mockResolvedValue(undefined),
    getByRun: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(TaskOutputService).mockImplementation(() => mockTaskOutputServiceMethods as never);

  mockRepoLockServiceMethods = {
    release: vi.fn().mockResolvedValue(undefined),
    acquire: vi.fn().mockResolvedValue(true),
  };
  vi.mocked(RepoLockService).mockImplementation(() => mockRepoLockServiceMethods as never);

  mockRateLimitServiceMethods = {
    getBackoff: vi.fn().mockResolvedValue(undefined),
    resetBackoff: vi.fn().mockResolvedValue(undefined),
    tripBreaker: vi.fn().mockResolvedValue({ backoffUntil: '', consecutiveFailures: 0, isFirstTrip: false, exhausted: false }),
  };
  vi.mocked(RateLimitService).mockImplementation(() => mockRateLimitServiceMethods as never);

  mockGitHubClientMethods = {
    getFileContent: vi.fn().mockResolvedValue(base64(JSON.stringify(validListing))),
    listPullRequests: vi.fn().mockResolvedValue([]),
    addPRComment: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ number: 1 }),
  };
  vi.mocked(createGitHubClient).mockReturnValue(mockGitHubClientMethods as never);

  vi.mocked(buildMarketerPrompt).mockReturnValue('mock marketer prompt');
  vi.mocked(launchECSTask).mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/mkt123');
  vi.mocked(getECSTaskStatus).mockResolvedValue({ status: 'STOPPED', exitCode: 0 });
  vi.mocked(enqueue).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Work item + types (brief items 1 and 2)
// ---------------------------------------------------------------------------

describe('holdout i6: GENERATE_LISTING work item', () => {
  it('is re-exported from the package barrel', () => {
    expect(GenerateListingSchema).toBeDefined();
  });

  it('accepts a minimal valid item and an optional runId', () => {
    expect(GenerateListingSchema.safeParse({ type: 'GENERATE_LISTING', projectId: 'proj-1' }).success).toBe(true);
    expect(
      GenerateListingSchema.safeParse({ type: 'GENERATE_LISTING', projectId: 'proj-1', runId: 'run-1' }).success,
    ).toBe(true);
  });

  it('rejects a missing or empty projectId', () => {
    expect(GenerateListingSchema.safeParse({ type: 'GENERATE_LISTING' }).success).toBe(false);
    expect(GenerateListingSchema.safeParse({ type: 'GENERATE_LISTING', projectId: '' }).success).toBe(false);
  });

  it('is part of the validated inbound union', () => {
    const parsed = WorkItemSchema.safeParse({ type: 'GENERATE_LISTING', projectId: 'proj-1' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('GENERATE_LISTING');
    }
    expect(WorkItemSchema.safeParse({ type: 'GENERATE_LISTING' }).success).toBe(false);
  });

  it('narrows to the exported item type and the new union members', () => {
    const item: GenerateListingItem = { type: 'GENERATE_LISTING', projectId: 'proj-1' };
    expect(item.projectId).toBe('proj-1');
    expect(marketerWorker).toBe('marketer');
    expect(releasingStatus).toBe('RELEASING');
    expect(releasedStatus).toBe('RELEASED');
    expect(marketerTitle).toBe('The Dark Tower');
    expect(marketerRepoName).toBe('the-dark-tower');
    expect(marketerGenre).toBe('Dark Fantasy');
  });
});

// ---------------------------------------------------------------------------
// 2. Prompt (brief item 3) — graded against the real builder, not the mock.
// ---------------------------------------------------------------------------

describe('holdout i6: buildMarketerPrompt content', () => {
  it('instructs the agent to write the listing file with 7 keywords and 3 categories', async () => {
    const actual = await vi.importActual<typeof import('@auto-graph/core')>('@auto-graph/core');
    const prompt = actual.buildMarketerPrompt({
      title: 'The Dark Tower',
      repoName: 'the-dark-tower',
      genre: 'Dark Fantasy',
      projectType: ProjectType.NOVEL,
    } as MarketerPromptParams);

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('release/listing.json');
    // Order-agnostic: the brief pins that the prompt states the counts, not the
    // sentence shape. "exactly 7 keywords" and "keywords must contain exactly 7
    // entries" both satisfy it; requiring the digit first graded phrasing.
    expect(prompt).toMatch(/\b7\b[^\n]{0,60}keywords|keywords[^\n]{0,60}\b7\b/i);
    expect(prompt).toMatch(/\b3\b[^\n]{0,60}categories|categories[^\n]{0,60}\b3\b/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Handler (brief item 4)
// ---------------------------------------------------------------------------

describe('holdout i6: GENERATE_LISTING handler', () => {
  it('exports both handle and handler', () => {
    expect(typeof generateListingHandle).toBe('function');
    expect(typeof generateListingHandler).toBe('function');
  });

  it('rejects a work item whose type is not GENERATE_LISTING', async () => {
    const result = await generateListingHandler(
      makeEvent([makeRecord({ type: 'FINAL_REVIEW', projectId: 'proj-123' }, 'msg-wrong-type')]),
      {} as never,
      () => {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-wrong-type' }] });
    expect(vi.mocked(launchECSTask)).not.toHaveBeenCalled();
  });

  it('fails when MARKETER_TASK_DEF_ARN is not set', async () => {
    delete process.env['MARKETER_TASK_DEF_ARN'];

    const result = await generateListingHandler(
      makeEvent([makeRecord(listingWorkItem, 'msg-no-arn')]),
      {} as never,
      () => {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-no-arn' }] });
    expect(vi.mocked(launchECSTask)).not.toHaveBeenCalled();
  });

  it('fails when the project does not exist', async () => {
    mockProjectServiceMethods.get.mockResolvedValueOnce(undefined);

    const result = await generateListingHandler(
      makeEvent([makeRecord({ type: 'GENERATE_LISTING', projectId: 'proj-missing' }, 'msg-missing')]),
      {} as never,
      () => {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-missing' }] });
    expect(vi.mocked(launchECSTask)).not.toHaveBeenCalled();
  });

  it('builds the marketer prompt from the project', async () => {
    await generateListingHandler(makeEvent([makeRecord(listingWorkItem)]), {} as never, () => {});

    expect(vi.mocked(buildMarketerPrompt)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(buildMarketerPrompt).mock.calls[0]!;
    expect(params.title).toBe('The Dark Tower');
    expect(params.repoName).toBe('the-dark-tower');
    expect(params.genre).toBe('Dark Fantasy');
    expect(params.projectType).toBe('NOVEL');
  });

  it('launches the ECS task named by MARKETER_TASK_DEF_ARN with the standard environment', async () => {
    await generateListingHandler(makeEvent([makeRecord(listingWorkItem)]), {} as never, () => {});

    expect(vi.mocked(launchECSTask)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(params.taskDefinition).toBe(MARKETER_TASK_DEF_ARN);
    expect(Object.keys(params.environment).sort()).toEqual(
      ['AWS_REGION', 'DYNAMODB_TABLE_PREFIX', 'PROJECT_ID', 'REPO_NAME', 'RUN_ID'],
    );
    expect(params.environment['PROJECT_ID']).toBe('proj-123');
    expect(params.environment['REPO_NAME']).toBe('the-dark-tower');
  });

  it('records a marketer agent run with a ULID run id and status RUNNING', async () => {
    await generateListingHandler(makeEvent([makeRecord(listingWorkItem)]), {} as never, () => {});

    expect(mockAgentRunServiceMethods.create).toHaveBeenCalledOnce();
    const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;
    expect(runItem.projectId).toBe('proj-123');
    expect(runItem.workerType).toBe('marketer');
    expect(runItem.status).toBe('RUNNING');
    // Proves the launch went through the shared helper introduced by issue 5.
    expect(runItem.runId).toMatch(ULID_RE);

    const [launchParams] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(launchParams.environment['RUN_ID']).toBe(runItem.runId);
  });

  it('persists the system prompt as a system-prompt task output', async () => {
    await generateListingHandler(makeEvent([makeRecord(listingWorkItem)]), {} as never, () => {});

    expect(mockTaskOutputServiceMethods.save).toHaveBeenCalledOnce();
    const [outputItem] = mockTaskOutputServiceMethods.save.mock.calls[0]!;
    expect(outputItem.outputType).toBe('system-prompt');
    expect(outputItem.content).toBe('mock marketer prompt');
  });

  it('sets the project status to RELEASING and enqueues RECONCILE for the run', async () => {
    await generateListingHandler(makeEvent([makeRecord(listingWorkItem)]), {} as never, () => {});

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'RELEASING');

    const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;
    const reconciles = vi
      .mocked(enqueue)
      .mock.calls.map(([, item]) => item)
      .filter((item) => item.type === 'RECONCILE');

    expect(reconciles).toHaveLength(1);
    const reconcile = reconciles[0]!;
    if (reconcile.type === 'RECONCILE') {
      expect(reconcile.projectId).toBe('proj-123');
      expect(reconcile.runId).toBe(runItem.runId);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Dispatch (brief item 5, production half — the integration-harness half is
// graded by the epic's end-to-end holdout).
// ---------------------------------------------------------------------------

describe('holdout i6: production dispatch', () => {
  it('routes a GENERATE_LISTING message to the marketer handler', async () => {
    const result = await dispatcherHandler(makeEvent([makeRecord(listingWorkItem, 'msg-dispatch')]));

    expect(result).toBeUndefined();
    expect(vi.mocked(launchECSTask)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(params.taskDefinition).toBe(MARKETER_TASK_DEF_ARN);

    const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;
    expect(runItem.workerType).toBe('marketer');
  });
});

// ---------------------------------------------------------------------------
// 5. Reconcile — marketer completion (brief item 6)
// ---------------------------------------------------------------------------

const reconcileMarketer = { type: 'RECONCILE' as const, projectId: 'proj-123', runId: 'run-marketer' };

describe('holdout i6: reconcile marketer completion', () => {
  it('reads release/listing.json from main', async () => {
    await reconcileHandler(makeEvent([makeRecord(reconcileMarketer)]));

    const listingCalls = mockGitHubClientMethods.getFileContent.mock.calls.filter(
      (args: unknown[]) => args[1] === 'release/listing.json',
    );
    expect(listingCalls.length).toBeGreaterThan(0);
    expect(listingCalls[0]![2]).toBe('main');
  });

  it('sets the project RELEASED when the listing is valid', async () => {
    await reconcileHandler(makeEvent([makeRecord(reconcileMarketer)]));

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'RELEASED');
  });

  it('sets the project FAILED when the listing is invalid', async () => {
    mockGitHubClientMethods.getFileContent.mockResolvedValue(
      base64(JSON.stringify({ ...validListing, keywords: ['one', 'two', 'three', 'four', 'five'] })),
    );

    await reconcileHandler(makeEvent([makeRecord(reconcileMarketer)]));

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'FAILED');
    expect(mockProjectServiceMethods.updateStatus).not.toHaveBeenCalledWith('proj-123', 'RELEASED');
  });

  it('sets the project FAILED when the listing file is missing', async () => {
    mockGitHubClientMethods.getFileContent.mockRejectedValue(new Error('Not Found'));

    await reconcileHandler(makeEvent([makeRecord(reconcileMarketer)]));

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'FAILED');
  });

  it('sets the project FAILED when the listing file is unparseable', async () => {
    mockGitHubClientMethods.getFileContent.mockResolvedValue(base64('{ not json'));

    await reconcileHandler(makeEvent([makeRecord(reconcileMarketer)]));

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'FAILED');
  });
});

// ---------------------------------------------------------------------------
// 6. Reconcile — retry (brief item 7)
// ---------------------------------------------------------------------------

describe('holdout i6: reconcile retries a failed marketer run', () => {
  it('re-enqueues GENERATE_LISTING for the project', async () => {
    vi.mocked(getECSTaskStatus).mockResolvedValue({ status: 'STOPPED', exitCode: 1 });
    mockAgentRunServiceMethods.get.mockResolvedValue(makeMarketerRun({ nodeId: undefined }));
    mockAgentRunServiceMethods.listByProject.mockResolvedValue([]);

    await reconcileHandler(makeEvent([makeRecord(reconcileMarketer)]));

    const enqueued = vi.mocked(enqueue).mock.calls.map(([, item]) => item);
    expect(enqueued.map((item) => item.type)).toContain('GENERATE_LISTING');

    const retried = enqueued.find((item) => item.type === 'GENERATE_LISTING');
    expect(retried).toBeDefined();
    if (retried && retried.type === 'GENERATE_LISTING') {
      expect(retried.projectId).toBe('proj-123');
    }
  });
});
