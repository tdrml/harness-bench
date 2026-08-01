/** harness-bench holdout (as1): strict word-count vectors. */
import { describe, expect, it } from 'vitest';
import { validateWordCount } from '../word-count.js';

type Strict = (t: string, g: { min: number; max: number }, o?: { mode?: string }) => { valid: boolean; wordCount: number; deviation: number };
const vwc = validateWordCount as unknown as Strict;
const target = { min: 1, max: 10 };

describe('holdout as1: strict mode', () => {
  it('legacy default unchanged: numbers count, em-dash does not split', () => {
    expect(vwc('one 2 three', target).wordCount).toBe(3);
    expect(vwc('fire—and—forget', target).wordCount).toBe(1);
  });

  it('strict: pure-number tokens excluded', () => {
    expect(vwc('one 2 three', target, { mode: 'strict' }).wordCount).toBe(2);
    expect(vwc('3.14 1,000', target, { mode: 'strict' }).wordCount).toBe(0);
    expect(vwc('3rd v2 win', target, { mode: 'strict' }).wordCount).toBe(3);
  });

  it('strict: em-dash splits words', () => {
    expect(vwc('fire—and—forget', target, { mode: 'strict' }).wordCount).toBe(3);
  });

  it('hyphenated compounds one word in both modes', () => {
    expect(vwc('state-of-the-art rocks', target).wordCount).toBe(2);
    expect(vwc('state-of-the-art rocks', target, { mode: 'strict' }).wordCount).toBe(2);
  });

  it('valid/deviation operate on the strict count', () => {
    const r = vwc('3.14 100', target, { mode: 'strict' });
    expect(r.wordCount).toBe(0);
    expect(r.valid).toBe(false);
    expect(r.deviation).toBe(-1);
  });
});
