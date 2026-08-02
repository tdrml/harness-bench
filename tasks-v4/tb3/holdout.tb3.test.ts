/** harness-bench holdout (tb3): every role prompt carries the shared DoD block. */
import { describe, expect, it } from 'vitest';
import { getArchitectPrompt } from '../src/prompts/architect.js';
import { getDeveloperPrompt } from '../src/prompts/developer.js';
import { getPlannerPrompt } from '../src/prompts/planner.js';
import { getRebaserPrompt } from '../src/prompts/rebaser.js';
import { getReviewerPrompt } from '../src/prompts/reviewer.js';
import { getReviserPrompt } from '../src/prompts/reviser.js';

const BULLETS = [
  'The working tree is clean and all changes are committed',
  'The full test suite passes locally before you report completion',
  'You have not modified any test to make it pass',
  'You state explicitly what you verified and how',
];

const PROMPTS: Array<[string, () => string]> = [
  ['architect', () => getArchitectPrompt({ projectDescription: 'a thing' } as Parameters<typeof getArchitectPrompt>[0])],
  ['planner', () => getPlannerPrompt({ hldContent: '# HLD' } as Parameters<typeof getPlannerPrompt>[0])],
  ['developer', () => getDeveloperPrompt({ taskDescription: 'do it', repoStructure: 'src/', branchName: 'telos/task-1' } as Parameters<typeof getDeveloperPrompt>[0])],
  ['reviewer', () => getReviewerPrompt({ prDiff: 'diff', prDescription: 'desc', taskDescription: 'task' } as Parameters<typeof getReviewerPrompt>[0])],
  ['reviser', () => getReviserPrompt({ reviewComments: 'fix', branchName: 'telos/task-1', taskDescription: 'task' } as Parameters<typeof getReviserPrompt>[0])],
  ['rebaser', () => getRebaserPrompt({ branchName: 'telos/task-1', baseBranch: 'main' } as Parameters<typeof getRebaserPrompt>[0])],
];

describe('holdout tb3: Definition of Done in every role prompt', () => {
  for (const [name, build] of PROMPTS) {
    it(`${name} prompt ends with the DoD block`, () => {
      const p = build();
      expect(p, `${name} missing DoD heading`).toContain('## Definition of Done');
      for (const b of BULLETS) expect(p, `${name} missing bullet: ${b}`).toContain(b);
      expect(p.indexOf('## Definition of Done'), `${name} DoD appears more than once`).toBe(p.lastIndexOf('## Definition of Done'));
      expect(p.trimEnd().endsWith(BULLETS[3]), `${name} DoD is not the final content`).toBe(true);
    });
  }

  it('the block is sourced from one shared constant', async () => {
    const shared = (await import('../src/prompts/shared.js')) as Record<string, unknown>;
    const dod = shared['DEFINITION_OF_DONE'];
    expect(typeof dod).toBe('string');
    expect(String(dod)).toContain('## Definition of Done');
    for (const b of BULLETS) expect(String(dod)).toContain(b);
  });
});
