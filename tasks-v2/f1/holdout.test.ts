/** harness-bench holdout (f1): ciGreen gate on evaluateMergePolicy. */
import { describe, expect, it } from 'vitest';
import { evaluateMergePolicy } from '../src/merge-policy/index.js';

type LooseParams = Parameters<typeof evaluateMergePolicy>[0] & { ciGreen?: boolean };
const evaluate = evaluateMergePolicy as (p: LooseParams) => ReturnType<typeof evaluateMergePolicy>;

describe('holdout f1: ciGreen parameter', () => {
  it('ciGreen=false blocks merging with WAIT and a CI-mentioning reason', () => {
    const r = evaluate({ prApproved: true, hasConflicts: false, predecessorsMerged: true, ciGreen: false });
    expect(r.canMerge).toBe(false);
    expect(r.action).toBe('WAIT');
    expect(r.reason.toLowerCase()).toContain('ci');
  });

  it('ciGreen defaults to true (omitted keeps happy path merging)', () => {
    const r = evaluate({ prApproved: true, hasConflicts: false, predecessorsMerged: true });
    expect(r.canMerge).toBe(true);
    expect(r.action).toBe('MERGE');
  });

  it('conflicts still dominate ciGreen', () => {
    const r = evaluate({ prApproved: true, hasConflicts: true, predecessorsMerged: true, ciGreen: false });
    expect(r.action).toBe('REBASE');
  });

  it('approval still dominates ciGreen', () => {
    const r = evaluate({ prApproved: false, hasConflicts: false, predecessorsMerged: true, ciGreen: false });
    expect(r.action).toBe('BLOCKED');
  });

  it('ciGreen dominates predecessors', () => {
    const r = evaluate({ prApproved: true, hasConflicts: false, predecessorsMerged: false, ciGreen: false });
    expect(r.action).toBe('WAIT');
    expect(r.reason.toLowerCase()).toContain('ci');
  });
});
