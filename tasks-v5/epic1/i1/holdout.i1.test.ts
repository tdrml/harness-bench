/**
 * harness-bench pilot 7 holdout - epic1 / i1: release-policy listing validation.
 *
 * Imports through the PACKAGE BARREL (`../../index.js` === packages/core/src/index.ts),
 * not the module directly: reaching consumers of `@auto-graph/core` is a stated
 * requirement of the brief and barrel omission is the failure class under study.
 * The `import type` line is graded by tsc, which runs with this file in the tree.
 */
import { describe, expect, it } from 'vitest';
import {
  validateListing,
  MAX_BLURB_LENGTH,
  REQUIRED_KEYWORD_COUNT,
  REQUIRED_CATEGORY_COUNT,
  ALLOWED_BLURB_TAGS,
} from '../../index.js';
import type { KdpListing, ListingValidation, ListingError } from '../../index.js';

const base: KdpListing = {
  title: 'The Long Horizon',
  subtitle: 'A Novel',
  blurb: 'A sweeping tale of <b>persistence</b> and <i>consequence</i>.',
  keywords: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
  categories: ['Fiction', 'Literary', 'Sagas'],
  author: 'A. Writer',
};

const codes = (r: ListingValidation): string[] => r.errors.map((e: ListingError) => e.code);

describe('holdout i1: constants', () => {
  it('pins the documented limits', () => {
    expect(MAX_BLURB_LENGTH).toBe(4000);
    expect(REQUIRED_KEYWORD_COUNT).toBe(7);
    expect(REQUIRED_CATEGORY_COUNT).toBe(3);
  });

  it('allows exactly the documented blurb tags', () => {
    expect([...ALLOWED_BLURB_TAGS].sort()).toEqual(
      ['b', 'br', 'h4', 'h5', 'h6', 'i', 'li', 'ol', 'p', 'u', 'ul'].sort(),
    );
  });
});

describe('holdout i1: validateListing', () => {
  it('accepts a well-formed listing', () => {
    const r = validateListing(base);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('flags a blurb over 4000 characters but not one at exactly 4000', () => {
    expect(codes(validateListing({ ...base, blurb: 'a'.repeat(4001) }))).toContain('BLURB_TOO_LONG');
    expect(codes(validateListing({ ...base, blurb: 'a'.repeat(4000) }))).not.toContain('BLURB_TOO_LONG');
  });

  it('flags an empty or whitespace-only blurb', () => {
    expect(codes(validateListing({ ...base, blurb: '' }))).toContain('BLURB_EMPTY');
    expect(codes(validateListing({ ...base, blurb: '   \n\t ' }))).toContain('BLURB_EMPTY');
  });

  it('requires exactly seven keywords', () => {
    expect(codes(validateListing({ ...base, keywords: base.keywords.slice(0, 6) }))).toContain('KEYWORD_COUNT');
    expect(codes(validateListing({ ...base, keywords: [...base.keywords, 'eight'] }))).toContain('KEYWORD_COUNT');
    expect(codes(validateListing(base))).not.toContain('KEYWORD_COUNT');
  });

  it('requires exactly three categories', () => {
    expect(codes(validateListing({ ...base, categories: ['Fiction', 'Literary'] }))).toContain('CATEGORY_COUNT');
    expect(codes(validateListing({ ...base, categories: [...base.categories, 'Extra'] }))).toContain('CATEGORY_COUNT');
    expect(codes(validateListing(base))).not.toContain('CATEGORY_COUNT');
  });

  it('reports an unresolved placeholder exactly once however many fields carry one', () => {
    const many = validateListing({
      ...base,
      title: 'TODO: title',
      blurb: 'TODO: write the blurb',
      author: 'TODO: author',
    });
    expect(many.errors.filter((e) => e.code === 'UNRESOLVED_PLACEHOLDER')).toHaveLength(1);
  });

  it('detects placeholders inside keyword and category entries', () => {
    expect(codes(validateListing({ ...base, keywords: ['one', 'two', 'three', 'four', 'five', 'six', 'TODO: seven'] })))
      .toContain('UNRESOLVED_PLACEHOLDER');
    expect(codes(validateListing({ ...base, categories: ['Fiction', 'Literary', 'TODO: pick one'] })))
      .toContain('UNRESOLVED_PLACEHOLDER');
  });

  it('rejects HTML outside the allowlist and accepts HTML inside it', () => {
    expect(codes(validateListing({ ...base, blurb: 'Hello <script>alert(1)</script>' }))).toContain('DISALLOWED_HTML');
    expect(codes(validateListing({ ...base, blurb: 'A <div>block</div> of text' }))).toContain('DISALLOWED_HTML');
    expect(codes(validateListing({ ...base, blurb: '<p>Fine <b>bold</b> and <i>italic</i>.<br/>New line.</p>' })))
      .not.toContain('DISALLOWED_HTML');
  });

  it('treats tag matching as case-insensitive and counts closing tags', () => {
    expect(codes(validateListing({ ...base, blurb: '<B>bold</B> is fine' }))).not.toContain('DISALLOWED_HTML');
    expect(codes(validateListing({ ...base, blurb: 'text </table> more' }))).toContain('DISALLOWED_HTML');
  });

  it('reports a disallowed-HTML violation exactly once for multiple bad tags', () => {
    const r = validateListing({ ...base, blurb: '<div>a</div><span>b</span><table>c</table>' });
    expect(r.errors.filter((e) => e.code === 'DISALLOWED_HTML')).toHaveLength(1);
  });

  it('sorts errors by code ascending', () => {
    const r = validateListing({
      ...base,
      keywords: ['only', 'three', 'here'],
      categories: ['just-one'],
      blurb: 'TODO: fill in <script>x</script>',
    });
    expect(r.errors.length).toBeGreaterThan(1);
    expect(codes(r)).toEqual([...codes(r)].sort());
    expect(r.valid).toBe(false);
  });
});
