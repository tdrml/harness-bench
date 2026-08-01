/** harness-bench holdout (ab3/prompts): prompt builders must emit 3-digit paths. */
import { describe, expect, it } from 'vitest';
import { buildEditorPrompt } from '../editor.js';
import { buildReviserPrompt } from '../reviser.js';
import { buildContinuityCheckerPrompt } from '../continuity-checker.js';

const style = { voice: 'wry', tense: 'past' as const, pov: 'third-limited' as const };
const continuityState = { characters: [], timeline: [], plotThreads: [], worldState: {} };

function assertThreeDigit(text: string, label: string) {
  // no two-digit chapter filename may survive anywhere in the prompt
  const twoDigit = text.match(/chapter-\d{2}(?!\d)[.\-]/g) ?? [];
  expect(twoDigit, `${label} still emits 2-digit chapter paths: ${twoDigit.join(', ')}`).toEqual([]);
  expect(text, `${label} should reference the 3-digit path`).toContain('chapter-007');
}

describe('holdout ab3: prompt builders', () => {
  it('reviser prompt uses 3-digit chapter paths', () => {
    const p = buildReviserPrompt({
      reviewComments: 'fix it',
      style,
      wordCountTarget: 2000,
      revisionRound: 1,
      chapterNumber: 7,
    } as Parameters<typeof buildReviserPrompt>[0]);
    assertThreeDigit(p, 'reviser');
  });

  it('editor prompt uses 3-digit chapter paths', () => {
    const p = buildEditorPrompt({
      chapterNumber: 7,
      style,
      wordCountTarget: 2000,
      continuityState,
      prNumber: 3,
    } as Parameters<typeof buildEditorPrompt>[0]);
    assertThreeDigit(p, 'editor');
  });

  it('continuity-checker prompt uses 3-digit chapter paths', () => {
    const p = buildContinuityCheckerPrompt({
      chapterNumber: 7,
      continuityState,
      style,
    } as Parameters<typeof buildContinuityCheckerPrompt>[0]);
    assertThreeDigit(p, 'continuity-checker');
  });
});
