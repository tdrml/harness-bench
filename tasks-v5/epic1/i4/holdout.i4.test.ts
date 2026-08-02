/**
 * harness-bench pilot 7 holdout - epic1 / i4: packager handler + pipeline registration
 * (lambdas half; the CDK and worker halves are separate files in this issue's holdout set).
 *
 * Conventions copied from `generate-outline.test.ts` / `reconcile.test.ts`: the
 * `vi.mock('@auto-graph/core', …)` + `baseEnv`-in-`beforeEach` idiom.
 *
 * ONE DELIBERATE DEVIATION: the ECS launcher is mocked at `../../shared/ecs-launcher.js`,
 * not at the `../../shared/index.js` barrel the sibling tests mock. Issue 5 moves the
 * launch block into a shared helper that imports `launchECSTask` directly from the
 * launcher module, so a barrel-level mock would stop intercepting the call after i5
 * lands and this holdout would break on a later issue's correct work. Mocking the
 * leaf module intercepts both the pre-i5 (handler → barrel → launcher) and post-i5
 * (handler → helper → launcher) call paths.
 *
 * INVARIANCE NOTES (issue 8 changes what this stage does downstream):
 *  - nothing here asserts that the packager handler enqueues *only* RECONCILE, nor
 *    that reconcile's packager-completion path enqueues nothing — i8 makes packager
 *    completion enqueue GENERATE_LISTING and set RELEASING.
 *  - the run id is NOT asserted to be ULID-shaped: i4 legitimately copies
 *    generate-outline (which uses `randomUUID()` today); i5 is the issue that pins
 *    the format, and i5's holdout grades it.
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
    buildPackagerPrompt: vi.fn().mockReturnValue('mock packager prompt'),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../shared/ecs-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/ecs-launcher.js')>();
  return {
    ...actual,
    launchECSTask: vi.fn().mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/pkg123'),
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
  buildPackagerPrompt,
  enqueue,
  ProjectType,
} from '@auto-graph/core';
// Compile-time grading of the prompt-params type reaching the package barrel.
// Field-by-field rather than an object literal so that an implementation which
// legitimately adds a param beyond the four the brief pins still typechecks.
import type { PackagerPromptParams } from '@auto-graph/core';
import { launchECSTask, getECSTaskStatus } from '../../shared/ecs-launcher.js';
import { handle as packageManuscriptHandle, handler as packageManuscriptHandler } from '../package-manuscript.js';
import { handler as dispatcherHandler } from '../dispatcher.js';
import { handler as reconcileHandler } from '../reconcile.js';

const packagerTitle: PackagerPromptParams['title'] = 'The Dark Tower';
const packagerRepoName: PackagerPromptParams['repoName'] = 'the-dark-tower';
const packagerChapterCount: PackagerPromptParams['chapterCount'] = 3;
const packagerProjectType: PackagerPromptParams['projectType'] = ProjectType.NOVEL;

const PACKAGER_TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123:task-definition/packager:1';

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
  PACKAGER_TASK_DEF_ARN,
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

const validTaskGraph = {
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

const packageWorkItem = { type: 'PACKAGE_MANUSCRIPT' as const, projectId: 'proj-123' };

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
  };
  vi.mocked(ProjectService).mockImplementation(() => mockProjectServiceMethods as never);

  mockTaskGraphServiceMethods = {
    getLatest: vi.fn().mockResolvedValue(validTaskGraph),
    create: vi.fn().mockResolvedValue(undefined),
    updateNodeStatus: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(TaskGraphService).mockImplementation(() => mockTaskGraphServiceMethods as never);

  mockAgentRunServiceMethods = {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(makePackagerRun()),
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
    getFileContent: vi.fn().mockResolvedValue({ content: Buffer.from('# x').toString('base64'), path: '', sha: 'a', encoding: 'base64' }),
    listPullRequests: vi.fn().mockResolvedValue([]),
    addPRComment: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ number: 1 }),
  };
  vi.mocked(createGitHubClient).mockReturnValue(mockGitHubClientMethods as never);

  vi.mocked(buildPackagerPrompt).mockReturnValue('mock packager prompt');
  vi.mocked(launchECSTask).mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/pkg123');
  vi.mocked(getECSTaskStatus).mockResolvedValue({ status: 'STOPPED', exitCode: 0 });
  vi.mocked(enqueue).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Handler module surface (brief 1: "exporting handle(workItem, context) and a handler")
// ---------------------------------------------------------------------------

describe('holdout i4: package-manuscript module surface', () => {
  it('exports both handle and handler', () => {
    expect(typeof packageManuscriptHandle).toBe('function');
    expect(typeof packageManuscriptHandler).toBe('function');
  });

  it('re-exports the packager prompt builder and its params type from the core barrel', () => {
    expect(buildPackagerPrompt).toBeDefined();
    expect(packagerTitle).toBe('The Dark Tower');
    expect(packagerRepoName).toBe('the-dark-tower');
    expect(packagerChapterCount).toBe(3);
    expect(packagerProjectType).toBe(ProjectType.NOVEL);
  });
});

// ---------------------------------------------------------------------------
// 2. Handler behavior (brief 1)
// ---------------------------------------------------------------------------

describe('holdout i4: PACKAGE_MANUSCRIPT handler', () => {
  it('rejects a work item whose type is not PACKAGE_MANUSCRIPT', async () => {
    const result = await packageManuscriptHandler(
      makeEvent([makeRecord({ type: 'FINAL_REVIEW', projectId: 'proj-123' }, 'msg-wrong-type')]),
      {} as never,
      () => {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-wrong-type' }] });
    expect(vi.mocked(launchECSTask)).not.toHaveBeenCalled();
  });

  it('fails when PACKAGER_TASK_DEF_ARN is not set', async () => {
    delete process.env['PACKAGER_TASK_DEF_ARN'];

    const result = await packageManuscriptHandler(
      makeEvent([makeRecord(packageWorkItem, 'msg-no-arn')]),
      {} as never,
      () => {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-no-arn' }] });
    expect(vi.mocked(launchECSTask)).not.toHaveBeenCalled();
  });

  it('fails when the project does not exist', async () => {
    mockProjectServiceMethods.get.mockResolvedValueOnce(undefined);

    const result = await packageManuscriptHandler(
      makeEvent([makeRecord({ type: 'PACKAGE_MANUSCRIPT', projectId: 'proj-missing' }, 'msg-missing')]),
      {} as never,
      () => {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-missing' }] });
    expect(vi.mocked(launchECSTask)).not.toHaveBeenCalled();
  });

  it('builds the packager prompt from the project', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

    expect(vi.mocked(buildPackagerPrompt)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(buildPackagerPrompt).mock.calls[0]!;
    expect(params.title).toBe('The Dark Tower');
    expect(params.repoName).toBe('the-dark-tower');
    expect(params.projectType).toBe('NOVEL');
    // The brief pins that chapterCount is passed, not where it is sourced from.
    expect(typeof params.chapterCount).toBe('number');
  });

  it('launches the ECS task named by PACKAGER_TASK_DEF_ARN', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

    expect(vi.mocked(launchECSTask)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(params.taskDefinition).toBe(PACKAGER_TASK_DEF_ARN);
  });

  it('passes exactly the five standard environment keys to the ECS task', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(Object.keys(params.environment).sort()).toEqual(
      ['AWS_REGION', 'DYNAMODB_TABLE_PREFIX', 'PROJECT_ID', 'REPO_NAME', 'RUN_ID'],
    );
    expect(params.environment['PROJECT_ID']).toBe('proj-123');
    expect(params.environment['REPO_NAME']).toBe('the-dark-tower');
    expect(params.environment['AWS_REGION']).toBe('us-east-1');
    expect(params.environment['DYNAMODB_TABLE_PREFIX']).toBe('test');
    expect(typeof params.environment['RUN_ID']).toBe('string');
    expect(params.environment['RUN_ID']!.length).toBeGreaterThan(0);
  });

  it('records an agent run with workerType packager and status RUNNING', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

    expect(mockAgentRunServiceMethods.create).toHaveBeenCalledOnce();
    const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;
    expect(runItem.projectId).toBe('proj-123');
    expect(runItem.workerType).toBe('packager');
    expect(runItem.status).toBe('RUNNING');
    expect(runItem.taskArn).toBe('arn:aws:ecs:us-east-1:123:task/test/pkg123');

    const [launchParams] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(runItem.runId).toBe(launchParams.environment['RUN_ID']);
  });

  it('persists the system prompt as a system-prompt task output for the same run', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

    expect(mockTaskOutputServiceMethods.save).toHaveBeenCalledOnce();
    const [outputItem] = mockTaskOutputServiceMethods.save.mock.calls[0]!;
    expect(outputItem.projectId).toBe('proj-123');
    expect(outputItem.outputType).toBe('system-prompt');
    expect(outputItem.content).toBe('mock packager prompt');

    const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;
    expect(outputItem.runId).toBe(runItem.runId);
  });

  it('sets the project status to PACKAGING', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

    expect(mockProjectServiceMethods.updateStatus).toHaveBeenCalledWith('proj-123', 'PACKAGING');
  });

  it('enqueues a RECONCILE work item carrying the run id', async () => {
    await packageManuscriptHandler(makeEvent([makeRecord(packageWorkItem)]), {} as never, () => {});

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
// 3. Prompt content (brief 2) — graded against the real builder, not the mock.
// ---------------------------------------------------------------------------

describe('holdout i4: buildPackagerPrompt content', () => {
  it('instructs the agent to assemble the manuscript and write the release manifest', async () => {
    const actual = await vi.importActual<typeof import('@auto-graph/core')>('@auto-graph/core');
    const prompt = actual.buildPackagerPrompt({
      title: 'The Dark Tower',
      repoName: 'the-dark-tower',
      chapterCount: 3,
      projectType: ProjectType.NOVEL,
    } as PackagerPromptParams);

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('manuscript/manuscript.md');
    expect(prompt).toContain('release/manifest.json');
  });
});

// ---------------------------------------------------------------------------
// 4. Dispatch (brief 3) — a PACKAGE_MANUSCRIPT message off the queue must reach
// the handler. Graded through the production dispatcher by its observable
// effect, so the assertion does not depend on the handler map's internals.
// ---------------------------------------------------------------------------

describe('holdout i4: production dispatch', () => {
  it('routes a PACKAGE_MANUSCRIPT message to the packager handler', async () => {
    const result = await dispatcherHandler(makeEvent([makeRecord(packageWorkItem, 'msg-dispatch')]));

    expect(result).toBeUndefined();
    expect(vi.mocked(launchECSTask)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(params.taskDefinition).toBe(PACKAGER_TASK_DEF_ARN);

    const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;
    expect(runItem.workerType).toBe('packager');
  });
});

// ---------------------------------------------------------------------------
// 5. Reconcile — retry (brief 6). A retried packager run re-enqueues
// PACKAGE_MANUSCRIPT for its project.
//
// (Brief 5 — "mark a finished packager run succeeded" — is not graded here: the
// success path marks every worker type SUCCEEDED before it branches, so the
// assertion would already pass before this issue and discriminates nothing.)
// ---------------------------------------------------------------------------

describe('holdout i4: reconcile retries a failed packager run', () => {
  it('re-enqueues PACKAGE_MANUSCRIPT for the project', async () => {
    vi.mocked(getECSTaskStatus).mockResolvedValue({ status: 'STOPPED', exitCode: 1 });
    mockAgentRunServiceMethods.get.mockResolvedValue(makePackagerRun({ nodeId: undefined }));
    mockAgentRunServiceMethods.listByProject.mockResolvedValue([]);

    await reconcileHandler(
      makeEvent([makeRecord({ type: 'RECONCILE', projectId: 'proj-123', runId: 'run-packager' })]),
    );

    const enqueued = vi.mocked(enqueue).mock.calls.map(([, item]) => item);
    expect(enqueued.map((item) => item.type)).toContain('PACKAGE_MANUSCRIPT');

    const retried = enqueued.find((item) => item.type === 'PACKAGE_MANUSCRIPT');
    expect(retried).toBeDefined();
    if (retried && retried.type === 'PACKAGE_MANUSCRIPT') {
      expect(retried.projectId).toBe('proj-123');
    }
    expect(mockAgentRunServiceMethods.updateStatus).toHaveBeenCalledWith(
      'run-packager',
      'FAILED',
      expect.anything(),
    );
  });
});
