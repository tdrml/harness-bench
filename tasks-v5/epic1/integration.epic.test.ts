/**
 * harness-bench pilot 7 holdout - epic1 END-TO-END: final review → packaging →
 * listing generation → validation → released.
 *
 * This test drives work items through the integration harness
 * (`helpers/pipeline-runner.ts`'s `dispatch` / `runAll`), never by calling
 * handlers directly. That is the point: it detonates if issue 4 or issue 6
 * registered their handler in production dispatch but not in the harness's
 * HANDLER_MAP, which is the half of "registration" that is easy to skip.
 *
 * Setup is copied from the existing integration tests (`pipeline-flow.test.ts`,
 * `escalation.test.ts`): the same in-memory `@auto-graph/core` mock, the same
 * ECS launcher mock (`STOPPED` / exit 0 → every launched task reconciles as an
 * immediate success), the same store/queue/GitHub reset in `beforeEach`.
 *
 * The two release-stage task-definition ARNs are set on top of BASE_ENV here
 * rather than assumed to be in it, so this file grades handler registration and
 * the release chain, not the contents of a test fixture.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

vi.mock('@auto-graph/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auto-graph/core')>();
  const mockAws = await import('./helpers/mock-aws.js');
  const { mockGitHub } = await import('./helpers/mock-github.js');
  const { addToQueue } = await import('./helpers/queue.js');
  const { TEST_PROJECT_CONFIG, PROJECT_ID } = await import('./helpers/test-data.js');

  return {
    ...actual,
    createDynamoClient: vi.fn().mockReturnValue({}),
    ProjectService: mockAws.MockProjectService,
    TaskGraphService: mockAws.MockTaskGraphService,
    AgentRunService: mockAws.MockAgentRunService,
    RepoLockService: mockAws.MockRepoLockService,
    TaskOutputService: mockAws.MockTaskOutputService,
    RateLimitService: mockAws.MockRateLimitService,
    createGitHubClient: vi.fn().mockReturnValue(mockGitHub),
    enqueue: vi.fn().mockImplementation(async (_url: string, item: unknown) => {
      addToQueue(item);
    }),
    validateProjectConfig: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      ...TEST_PROJECT_CONFIG,
      projectId: (data['projectId'] as string | undefined) ?? PROJECT_ID,
    })),
  };
});

vi.mock('../../shared/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/index.js')>();
  return {
    ...actual,
    launchECSTask: vi.fn().mockResolvedValue(
      'arn:aws:ecs:us-east-1:123456789:task/inttest/mock-task-id',
    ),
    getECSTaskStatus: vi.fn().mockResolvedValue({ status: 'STOPPED', exitCode: 0 }),
  };
});

// The launcher is ALSO mocked at the leaf module, with identical values. The
// existing integration tests mock only the `shared/index.js` barrel; after the
// launch block moves into a shared helper, that helper may reach `launchECSTask`
// through the leaf rather than through the barrel. Mocking both means no real
// ECS client is ever constructed whichever import path the code takes, and both
// mocks answer the same way, so nothing depends on which one is hit.
vi.mock('../../shared/ecs-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/ecs-launcher.js')>();
  return {
    ...actual,
    launchECSTask: vi.fn().mockResolvedValue(
      'arn:aws:ecs:us-east-1:123456789:task/inttest/mock-task-id',
    ),
    getECSTaskStatus: vi.fn().mockResolvedValue({ status: 'STOPPED', exitCode: 0 }),
  };
});

import { store, resetStore } from './helpers/store.js';
import { resetQueue, pendingQueue } from './helpers/queue.js';
import { resetMockGitHub, fileContents } from './helpers/mock-github.js';
import {
  PROJECT_ID,
  BASE_ENV,
  makeProjectItem,
  makeTaskGraphItem,
  makeChapterNode,
} from './helpers/test-data.js';
import { dispatch, runAll } from './helpers/pipeline-runner.js';

const NODE_ID = 'node-chapter-1';

const VALID_LISTING = JSON.stringify({
  title: 'The Test Novel',
  subtitle: 'A Novel',
  blurb: 'A hero embarks on a journey to save the world from an <b>ancient</b> darkness.',
  keywords: ['fantasy', 'quest', 'magic', 'hero', 'adventure', 'epic', 'saga'],
  categories: ['Fiction', 'Fantasy', 'Epic'],
  author: 'Jordan Vale',
});

/** Same listing with five keywords instead of seven — KEYWORD_COUNT. */
const INVALID_LISTING = JSON.stringify({
  title: 'The Test Novel',
  subtitle: 'A Novel',
  blurb: 'A hero embarks on a journey to save the world from an ancient darkness.',
  keywords: ['fantasy', 'quest', 'magic', 'hero', 'adventure'],
  categories: ['Fiction', 'Fantasy', 'Epic'],
  author: 'Jordan Vale',
});

beforeAll(() => {
  for (const [key, value] of Object.entries(BASE_ENV)) {
    process.env[key] = value;
  }
  process.env['PACKAGER_TASK_DEF_ARN'] =
    'arn:aws:ecs:us-east-1:123456789:task-definition/packager:1';
  process.env['MARKETER_TASK_DEF_ARN'] =
    'arn:aws:ecs:us-east-1:123456789:task-definition/marketer:1';
});

/** Seed a project sitting exactly where final review runs: all chapters merged. */
function seedAtFinalReview(): void {
  store.projects.set(PROJECT_ID, makeProjectItem({ status: 'REVIEWING' }));

  const node = makeChapterNode(NODE_ID, 1, { status: 'MERGED', wordCount: 300 });
  store.taskGraphsByProjectVersion.set(PROJECT_ID, new Map([[2, makeTaskGraphItem([node])]]));
  store.taskGraphLatestVersion.set(PROJECT_ID, 2);
}

/** The types of every work item enqueued so far, in order. */
async function enqueuedTypes(): Promise<string[]> {
  const { enqueue } = await import('@auto-graph/core');
  return vi.mocked(enqueue).mock.calls.map(([, item]) => (item as { type: string }).type);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  resetQueue();
  resetMockGitHub();

  fileContents.set('manuscript/chapter-01.md', Array(300).fill('word').join(' '));
  fileContents.set('release/listing.json', VALID_LISTING);
});

// ---------------------------------------------------------------------------
// Harness registration — the half of "registration" a production-dispatch-only
// change silently skips.
// ---------------------------------------------------------------------------

describe('epic1 integration: the pipeline harness knows the release stages', () => {
  it('can execute a PACKAGE_MANUSCRIPT work item', async () => {
    seedAtFinalReview();

    await dispatch({ type: 'PACKAGE_MANUSCRIPT', projectId: PROJECT_ID });

    const runs = Array.from(store.agentRuns.values());
    expect(runs.map((r) => r.workerType)).toContain('packager');
  });

  it('can execute a GENERATE_LISTING work item', async () => {
    seedAtFinalReview();

    await dispatch({ type: 'GENERATE_LISTING', projectId: PROJECT_ID });

    const runs = Array.from(store.agentRuns.values());
    expect(runs.map((r) => r.workerType)).toContain('marketer');
  });
});

// ---------------------------------------------------------------------------
// The release phase, end to end.
// ---------------------------------------------------------------------------

describe('epic1 integration: final review through to a released project', () => {
  it('runs the release chain in order and ends RELEASED', async () => {
    seedAtFinalReview();

    pendingQueue.push({ type: 'FINAL_REVIEW', projectId: PROJECT_ID });
    await runAll();

    expect(pendingQueue).toHaveLength(0);

    const types = await enqueuedTypes();

    expect(types).toContain('PACKAGE_MANUSCRIPT');
    expect(types).toContain('GENERATE_LISTING');
    expect(types.indexOf('PACKAGE_MANUSCRIPT')).toBeLessThan(types.indexOf('GENERATE_LISTING'));

    const project = store.projects.get(PROJECT_ID);
    expect(project).toBeDefined();
    expect(project!.status).toBe('RELEASED');
  });

  it('launches both release workers on the way through', async () => {
    seedAtFinalReview();

    pendingQueue.push({ type: 'FINAL_REVIEW', projectId: PROJECT_ID });
    await runAll();

    const workerTypes = Array.from(store.agentRuns.values()).map((r) => r.workerType);
    expect(workerTypes).toContain('packager');
    expect(workerTypes).toContain('marketer');
  });

  it('ends FAILED when the generated listing does not validate', async () => {
    fileContents.set('release/listing.json', INVALID_LISTING);
    seedAtFinalReview();

    pendingQueue.push({ type: 'FINAL_REVIEW', projectId: PROJECT_ID });
    await runAll();

    expect(pendingQueue).toHaveLength(0);

    const types = await enqueuedTypes();
    expect(types).toContain('PACKAGE_MANUSCRIPT');
    expect(types).toContain('GENERATE_LISTING');

    const project = store.projects.get(PROJECT_ID);
    expect(project).toBeDefined();
    expect(project!.status).toBe('FAILED');
  });
});
