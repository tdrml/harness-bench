/**
 * harness-bench pilot 7 holdout - epic1 / i5: extract launchAgentRun + migrate
 * every launching handler.
 *
 * Three graders are used, deliberately:
 *
 *  1. THE COMPILER. `LaunchAgentRunParams` is imported as a type from the SHARED
 *     BARREL (`../../shared/index.js`) and a full object literal is annotated with
 *     it. The brief pins that interface exactly, so both a missing field and an
 *     extra required field fail `tsc --build` — no runtime footprint.
 *  2. VITEST, on behavior: the helper's own contract, plus the observable
 *     consequence of the migration (every launching handler now yields a
 *     ULID-shaped run id, which is what unifying on `ulid()` means from outside).
 *  3. THE FILESYSTEM, for the two universally-quantified rules ("no handler may…").
 *     Reading the handler sources with `node:fs` is deterministic and states the
 *     rule as written, rather than guessing at internals.
 *
 * `launchECSTask` is mocked at `../../shared/ecs-launcher.js` rather than at the
 * `../../shared/index.js` barrel, so the mock intercepts the call whether it is
 * made by a handler directly or from inside the new helper.
 *
 * Run ids are ULIDs after this issue: shape is asserted (26 chars, Crockford
 * base32), never a specific value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../shared/ecs-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/ecs-launcher.js')>();
  return {
    ...actual,
    launchECSTask: vi.fn().mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/abc123'),
  };
});

import {
  ProjectService,
  TaskGraphService,
  AgentRunService,
  TaskOutputService,
  ProjectType,
} from '@auto-graph/core';
import type { AgentRunService as AgentRunServiceType, TaskOutputService as TaskOutputServiceType } from '@auto-graph/core';
import { launchECSTask } from '../../shared/ecs-launcher.js';
import { launchAgentRun } from '../../shared/index.js';
import type { HandlerContext, LaunchAgentRunParams } from '../../shared/index.js';
import { handler as generateOutlineHandler } from '../generate-outline.js';
import { handler as continuityAuditHandler } from '../continuity-audit.js';
import { handler as packageManuscriptHandler } from '../package-manuscript.js';

/** Crockford base32, 26 characters — the ULID shape. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
  OUTLINER_TASK_DEF_ARN: 'arn:aws:ecs:us-east-1:123:task-definition/outliner:1',
  AUDITOR_TASK_DEF_ARN: 'arn:aws:ecs:us-east-1:123:task-definition/auditor:1',
  PACKAGER_TASK_DEF_ARN: 'arn:aws:ecs:us-east-1:123:task-definition/packager:1',
  LOG_LEVEL: 'info',
};

const config: HandlerContext['config'] = {
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
  status: 'WRITING' as const,
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

let mockProjectServiceMethods: { get: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };
let mockTaskGraphServiceMethods: { getLatest: ReturnType<typeof vi.fn> };
let mockAgentRunServiceMethods: { create: ReturnType<typeof vi.fn> };
let mockTaskOutputServiceMethods: { save: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();

  for (const [key, value] of Object.entries(baseEnv)) {
    process.env[key] = value;
  }

  mockProjectServiceMethods = {
    get: vi.fn().mockResolvedValue(validProject),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(ProjectService).mockImplementation(() => mockProjectServiceMethods as never);

  mockTaskGraphServiceMethods = { getLatest: vi.fn().mockResolvedValue(validTaskGraph) };
  vi.mocked(TaskGraphService).mockImplementation(() => mockTaskGraphServiceMethods as never);

  mockAgentRunServiceMethods = { create: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(AgentRunService).mockImplementation(() => mockAgentRunServiceMethods as never);

  mockTaskOutputServiceMethods = { save: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(TaskOutputService).mockImplementation(() => mockTaskOutputServiceMethods as never);

  vi.mocked(launchECSTask).mockResolvedValue('arn:aws:ecs:us-east-1:123:task/test/abc123');
});

// ---------------------------------------------------------------------------
// 1. The helper itself (brief item 1)
// ---------------------------------------------------------------------------

/**
 * A fully-populated `LaunchAgentRunParams`. The annotation is the point: the
 * brief pins this interface exactly, so a missing or extra required field is a
 * compile error. Variants are built by spreading this and overriding literally,
 * which keeps `exactOptionalPropertyTypes` out of the way.
 */
function makeHelperParams(): LaunchAgentRunParams {
  const agentRunService = { create: vi.fn().mockResolvedValue(undefined) } as unknown as AgentRunServiceType;
  const taskOutputService = { save: vi.fn().mockResolvedValue(undefined) } as unknown as TaskOutputServiceType;

  return {
    taskDefArn: 'arn:aws:ecs:us-east-1:123:task-definition/writer:1',
    workerType: 'writer',
    systemPrompt: 'a system prompt',
    projectId: 'proj-123',
    repoName: 'the-dark-tower',
    config,
    agentRunService,
    taskOutputService,
  };
}

const createSpy = (params: LaunchAgentRunParams): ReturnType<typeof vi.fn> =>
  (params.agentRunService as unknown as { create: ReturnType<typeof vi.fn> }).create;

const saveSpy = (params: LaunchAgentRunParams): ReturnType<typeof vi.fn> =>
  (params.taskOutputService as unknown as { save: ReturnType<typeof vi.fn> }).save;

describe('holdout i5: launchAgentRun is surfaced from the shared module', () => {
  it('is exported from the shared barrel', () => {
    expect(typeof launchAgentRun).toBe('function');
  });

  it('returns a ULID-shaped run id and the launched task ARN', async () => {
    const { runId, taskArn } = await launchAgentRun(makeHelperParams());

    expect(runId).toMatch(ULID_RE);
    expect(taskArn).toBe('arn:aws:ecs:us-east-1:123:task/test/abc123');
  });

  it('launches with exactly the five standard environment keys when no extra env is given', async () => {
    const { runId } = await launchAgentRun(makeHelperParams());

    expect(vi.mocked(launchECSTask)).toHaveBeenCalledOnce();
    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(params.taskDefinition).toBe('arn:aws:ecs:us-east-1:123:task-definition/writer:1');
    expect(Object.keys(params.environment).sort()).toEqual(
      ['AWS_REGION', 'DYNAMODB_TABLE_PREFIX', 'PROJECT_ID', 'REPO_NAME', 'RUN_ID'],
    );
    expect(params.environment['PROJECT_ID']).toBe('proj-123');
    expect(params.environment['REPO_NAME']).toBe('the-dark-tower');
    expect(params.environment['AWS_REGION']).toBe('us-east-1');
    expect(params.environment['DYNAMODB_TABLE_PREFIX']).toBe('test');
    expect(params.environment['RUN_ID']).toBe(runId);
  });

  it('merges extraEnv into the standard environment', async () => {
    await launchAgentRun({
      ...makeHelperParams(),
      extraEnv: { CHAPTER_NUMBER: '7', BRANCH_NAME: 'chapter-07' },
    });

    const [params] = vi.mocked(launchECSTask).mock.calls[0]!;
    expect(params.environment['CHAPTER_NUMBER']).toBe('7');
    expect(params.environment['BRANCH_NAME']).toBe('chapter-07');
    expect(params.environment['PROJECT_ID']).toBe('proj-123');
    expect(params.environment['RUN_ID']).toBeDefined();
  });

  it('saves the system prompt as a system-prompt task output for the run', async () => {
    const params = makeHelperParams();
    const save = saveSpy(params);

    const { runId } = await launchAgentRun(params);

    expect(save).toHaveBeenCalledOnce();
    const [outputItem] = save.mock.calls[0]!;
    expect(outputItem.runId).toBe(runId);
    expect(outputItem.projectId).toBe('proj-123');
    expect(outputItem.outputType).toBe('system-prompt');
    expect(outputItem.content).toBe('a system prompt');
  });

  it('creates the agent-run record with status RUNNING', async () => {
    const params = makeHelperParams();
    const create = createSpy(params);

    const { runId, taskArn } = await launchAgentRun(params);

    expect(create).toHaveBeenCalledOnce();
    const [runItem] = create.mock.calls[0]!;
    expect(runItem.runId).toBe(runId);
    expect(runItem.projectId).toBe('proj-123');
    expect(runItem.taskArn).toBe(taskArn);
    expect(runItem.workerType).toBe('writer');
    expect(runItem.status).toBe('RUNNING');
  });

  it('records nodeId on the agent run when one is supplied', async () => {
    const params = makeHelperParams();
    const create = createSpy(params);

    await launchAgentRun({ ...params, workerType: 'editor', nodeId: 'node-1' });

    const [runItem] = create.mock.calls[0]!;
    expect(runItem.nodeId).toBe('node-1');
    expect(runItem.workerType).toBe('editor');
  });
});

// ---------------------------------------------------------------------------
// 2. The migration's observable consequence (brief items 2 and 3): every
// launching handler now produces a ULID run id, and the same id reaches both
// the ECS environment and the agent-run record.
// ---------------------------------------------------------------------------

async function runAndReadRunId(
  handler: (event: SQSEvent, context: never, callback: () => void) => unknown,
  workItem: unknown,
): Promise<{ runId: string; envRunId: string | undefined }> {
  await handler(makeEvent([makeRecord(workItem)]), {} as never, () => {});

  expect(mockAgentRunServiceMethods.create).toHaveBeenCalledOnce();
  const [runItem] = mockAgentRunServiceMethods.create.mock.calls[0]!;

  expect(vi.mocked(launchECSTask)).toHaveBeenCalledOnce();
  const [launchParams] = vi.mocked(launchECSTask).mock.calls[0]!;

  return { runId: runItem.runId as string, envRunId: launchParams.environment['RUN_ID'] };
}

describe('holdout i5: launching handlers yield ULID run ids', () => {
  it('generate-outline', async () => {
    const { runId, envRunId } = await runAndReadRunId(generateOutlineHandler, {
      type: 'GENERATE_OUTLINE',
      projectId: 'proj-123',
    });

    expect(runId).toMatch(ULID_RE);
    expect(envRunId).toBe(runId);
  });

  it('continuity-audit', async () => {
    const { runId, envRunId } = await runAndReadRunId(continuityAuditHandler, {
      type: 'CONTINUITY_AUDIT',
      projectId: 'proj-123',
    });

    expect(runId).toMatch(ULID_RE);
    expect(envRunId).toBe(runId);
  });

  it('package-manuscript', async () => {
    const { runId, envRunId } = await runAndReadRunId(packageManuscriptHandler, {
      type: 'PACKAGE_MANUSCRIPT',
      projectId: 'proj-123',
    });

    expect(runId).toMatch(ULID_RE);
    expect(envRunId).toBe(runId);
  });
});

// ---------------------------------------------------------------------------
// 3. The two universally-quantified rules (brief items 3 and 4), read off the
// handler sources on disk.
// ---------------------------------------------------------------------------

const handlersDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function readHandlerSources(): { name: string; source: string }[] {
  return readdirSync(handlersDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(join(handlersDir, name), 'utf-8') }));
}

describe('holdout i5: handler-wide rules', () => {
  it('reads a non-empty set of handler sources', () => {
    const sources = readHandlerSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.map((s) => s.name)).toContain('generate-outline.ts');
  });

  it('no handler generates a run id with randomUUID()', () => {
    const offenders = readHandlerSources()
      .filter(({ source }) => /runId\s*(?::[^=]*)?=\s*randomUUID\s*\(/.test(source))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('no handler calls agentRunService.create directly', () => {
    const offenders = readHandlerSources()
      .filter(({ source }) => /agentRunService\s*\.\s*create\s*\(/.test(source))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
