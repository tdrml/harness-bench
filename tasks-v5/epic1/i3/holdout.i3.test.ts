/**
 * harness-bench pilot 7 holdout - epic1 / i3: manuscript structure validation.
 *
 * Paths use the repository's existing 2-digit chapter convention, which the
 * brief requires be derived from the existing path helper rather than a
 * thirteenth inline padStart.
 */
import { describe, expect, it } from 'vitest';
import { validateManuscriptStructure } from '../../index.js';
import type { ChapterFile, ManuscriptValidation, ManuscriptError } from '../../index.js';

const ch = (n: number, content: string): ChapterFile => ({
  path: `manuscript/chapter-${String(n).padStart(2, '0')}.md`,
  content,
});

const good = (n: number, title = 'A Title'): ChapterFile =>
  ch(n, `# Chapter ${n}: ${title}\n\nSome prose follows here.\n`);

const codes = (r: ManuscriptValidation): string[] => r.errors.map((e: ManuscriptError) => e.code);

describe('holdout i3: validateManuscriptStructure', () => {
  it('accepts a well-formed contiguous manuscript', () => {
    const r = validateManuscriptStructure([good(1), good(2), good(3)]);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('flags a chapter with no level-1 heading', () => {
    const r = validateManuscriptStructure([ch(1, 'Just prose, no heading at all.\n')]);
    expect(codes(r)).toContain('H1_MISSING');
  });

  it('does not also report malformed or mismatched when the heading is missing', () => {
    const r = validateManuscriptStructure([ch(1, 'No heading here.\n')]);
    expect(codes(r)).not.toContain('H1_MALFORMED');
    expect(codes(r)).not.toContain('H1_NUMBER_MISMATCH');
  });

  it('flags a heading that is not the first non-empty line', () => {
    const r = validateManuscriptStructure([ch(1, 'A stray line.\n\n# Chapter 1: Title\n')]);
    expect(codes(r)).toContain('H1_NOT_FIRST');
  });

  it('tolerates leading blank lines before the heading', () => {
    const r = validateManuscriptStructure([ch(1, '\n\n# Chapter 1: Title\n\nProse.\n')]);
    expect(codes(r)).not.toContain('H1_NOT_FIRST');
  });

  it('flags a heading that does not match the required form', () => {
    expect(codes(validateManuscriptStructure([ch(1, '# Chapter One: Title\n')]))).toContain('H1_MALFORMED');
    expect(codes(validateManuscriptStructure([ch(1, '# Chapter 1\n')]))).toContain('H1_MALFORMED');
    expect(codes(validateManuscriptStructure([ch(1, '# Chapter 1: \n')]))).toContain('H1_MALFORMED');
  });

  it('flags a heading number that disagrees with the file path', () => {
    const r = validateManuscriptStructure([ch(1, '# Chapter 2: Wrong Number\n\nProse.\n')]);
    expect(codes(r)).toContain('H1_NUMBER_MISMATCH');
  });

  it('flags duplicate chapter numbers', () => {
    const r = validateManuscriptStructure([good(1), good(2), good(2)]);
    expect(codes(r)).toContain('CHAPTER_DUPLICATE');
  });

  it('flags a gap in the chapter sequence', () => {
    const r = validateManuscriptStructure([good(1), good(2), good(4)]);
    expect(codes(r)).toContain('CHAPTER_GAP');
  });

  it('flags a sequence that does not start at one', () => {
    const r = validateManuscriptStructure([good(2), good(3)]);
    expect(codes(r)).toContain('CHAPTER_GAP');
  });

  it('sorts errors by code ascending, consistently with the listing validator', () => {
    const r = validateManuscriptStructure([
      ch(1, 'stray\n\n# Chapter 1: Title\n'),
      ch(3, '# Chapter 9: Mismatch\n\nProse.\n'),
    ]);
    expect(r.errors.length).toBeGreaterThan(1);
    expect(codes(r)).toEqual([...codes(r)].sort());
    expect(r.valid).toBe(false);
  });
});
