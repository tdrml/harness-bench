/** harness-bench holdout (ab3): 3-digit chapter padding, helper + every duplicated site. */
import { describe, expect, it } from 'vitest';
import { getChapterFilePath } from '../paths.js';

describe('holdout ab3: path helper', () => {
  it('pads to three digits', () => {
    expect(getChapterFilePath(7)).toBe('manuscript/chapter-007.md');
    expect(getChapterFilePath(42)).toBe('manuscript/chapter-042.md');
  });

  it('leaves 3-digit and wider numbers intact', () => {
    expect(getChapterFilePath(128)).toBe('manuscript/chapter-128.md');
    expect(getChapterFilePath(1024)).toBe('manuscript/chapter-1024.md');
  });
});
