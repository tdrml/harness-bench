/** harness-bench holdout (ab2): ContinuityState.locations end-to-end semantics. */
import { describe, expect, it } from 'vitest';
import { mergeContinuityState, pruneContinuityState } from '../continuity.js';
import type { ContinuityState } from '../types.js';

function makeState(overrides: Partial<ContinuityState> = {}): ContinuityState {
  return {
    characters: [],
    timeline: Array.from({ length: 8 }, (_, i) => ({ chapterNumber: i + 1, events: [`e${i + 1}`] })),
    plotThreads: [],
    worldState: { w1: 'v1' },
    locations: { lighthouse: 'ch1: intact', village: 'ch2: flooded' },
    ...overrides,
  } as ContinuityState;
}

describe('holdout ab2: locations', () => {
  it('merge: update wins on conflicts, existing preserved otherwise', () => {
    const merged = mergeContinuityState(makeState(), {
      locations: { village: 'ch5: rebuilt', harbor: 'ch5: new' },
    } as Partial<ContinuityState>);
    const locs = (merged as ContinuityState & { locations: Record<string, string> }).locations;
    expect(locs['village']).toBe('ch5: rebuilt');
    expect(locs['lighthouse']).toBe('ch1: intact');
    expect(locs['harbor']).toBe('ch5: new');
  });

  it('merge: omitted locations field leaves existing untouched', () => {
    const merged = mergeContinuityState(makeState(), { worldState: { w2: 'v2' } });
    const locs = (merged as ContinuityState & { locations: Record<string, string> }).locations;
    expect(locs).toEqual({ lighthouse: 'ch1: intact', village: 'ch2: flooded' });
  });

  it('prune: locations kept in full while timeline is truncated', () => {
    const pruned = pruneContinuityState(makeState(), 3);
    expect(pruned.timeline.length).toBe(3);
    const locs = (pruned as ContinuityState & { locations: Record<string, string> }).locations;
    expect(Object.keys(locs).length).toBe(2);
  });
});
