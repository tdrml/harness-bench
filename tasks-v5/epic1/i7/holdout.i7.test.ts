/**
 * harness-bench pilot 7 holdout - epic1 / i7: word-count policy consolidation.
 *
 * Imports through the PACKAGE BARREL (`../../index.js` === packages/core/src/index.ts):
 * the brief requires the new module be surfaced from `@auto-graph/core` the way
 * core's other modules are, and barrel omission is the failure class under study.
 * The `import type { WordCountStage }` line plus the typed `const` below are
 * graded by tsc, which runs with this file in the tree.
 *
 * Every number below is chosen so that `floor` and `ceil` DISAGREE on the upper
 * bound (target 3333 → merge max is 3999.6: ceil 4000, floor 3999). That is what
 * makes the assertions discriminate the pinned rounding, which is a real change
 * for the merge stage.
 *
 * The two "after this issue, no file may contain…" rules are graded by reading
 * the sources off disk. That is deterministic, and it states the rule as the
 * brief states it rather than guessing at internals.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveChapterTarget,
  resolveWordCountRange,
  resolveTolerance,
  formatToleranceForPrompt,
  clampToProjectType,
  buildWriterPrompt,
  buildEditorPrompt,
  buildReviserPrompt,
  ProjectType,
  WORD_COUNT_DEFAULTS,
} from '../../index.js';
import type {
  WordCountStage,
  WriterPromptParams,
  EditorPromptParams,
  ReviserPromptParams,
  ContinuityState,
  Style,
} from '../../index.js';

// Compile-time only: fails `tsc --build`, never vitest.
const writerStage: WordCountStage = 'writer';
const reviewStage: WordCountStage = 'review';
const mergeStage: WordCountStage = 'merge';

// 10000 / 3 = 3333.33… → per-chapter target 3333.
const TARGET_WORD_COUNT = 10000;
const CHAPTER_COUNT = 3;
const PER_CHAPTER = 3333;

// ---------------------------------------------------------------------------
// resolveChapterTarget
// ---------------------------------------------------------------------------

describe('holdout i7: resolveChapterTarget', () => {
  it('floors the per-chapter target', () => {
    expect(resolveChapterTarget({ targetWordCount: TARGET_WORD_COUNT, chapterCount: CHAPTER_COUNT })).toBe(PER_CHAPTER);
    expect(resolveChapterTarget({ targetWordCount: 90000, chapterCount: 25 })).toBe(3600);
    expect(resolveChapterTarget({ targetWordCount: 7, chapterCount: 2 })).toBe(3);
  });

  it('throws when chapterCount is zero or negative', () => {
    expect(() => resolveChapterTarget({ targetWordCount: 10000, chapterCount: 0 })).toThrow();
    expect(() => resolveChapterTarget({ targetWordCount: 10000, chapterCount: -3 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveTolerance / formatToleranceForPrompt
// ---------------------------------------------------------------------------

describe('holdout i7: resolveTolerance', () => {
  it('pins one tolerance per stage', () => {
    expect(resolveTolerance('writer')).toBe(0.05);
    expect(resolveTolerance('review')).toBe(0.1);
    expect(resolveTolerance('merge')).toBe(0.2);
    expect(resolveTolerance(writerStage)).toBe(0.05);
    expect(resolveTolerance(reviewStage)).toBe(0.1);
    expect(resolveTolerance(mergeStage)).toBe(0.2);
  });
});

describe('holdout i7: formatToleranceForPrompt', () => {
  it('renders the prose form of each stage tolerance', () => {
    expect(formatToleranceForPrompt('writer')).toBe('±5%');
    expect(formatToleranceForPrompt('review')).toBe('±10%');
    expect(formatToleranceForPrompt('merge')).toBe('±20%');
  });
});

// ---------------------------------------------------------------------------
// resolveWordCountRange — floor on the lower bound, CEIL on the upper bound,
// for every stage (a change for merge, which floors today).
// ---------------------------------------------------------------------------

describe('holdout i7: resolveWordCountRange', () => {
  const range = (stage: WordCountStage) =>
    resolveWordCountRange({ targetWordCount: TARGET_WORD_COUNT, chapterCount: CHAPTER_COUNT, stage });

  it('writer: floor(3333 * 0.95) = 3166, ceil(3333 * 1.05) = 3500', () => {
    expect(range('writer')).toEqual({ min: 3166, max: 3500 });
  });

  it('review: floor(3333 * 0.90) = 2999, ceil(3333 * 1.10) = 3667', () => {
    expect(range('review')).toEqual({ min: 2999, max: 3667 });
  });

  it('merge: floor(3333 * 0.80) = 2666, ceil(3333 * 1.20) = 4000 (floor would give 3999)', () => {
    expect(range('merge')).toEqual({ min: 2666, max: 4000 });
    expect(range('merge').max).not.toBe(3999);
  });

  it('is derived from the floored per-chapter target', () => {
    expect(
      resolveWordCountRange({ targetWordCount: 90000, chapterCount: 25, stage: 'writer' }),
    ).toEqual({ min: 3420, max: 3780 });
  });
});

// ---------------------------------------------------------------------------
// clampToProjectType — clamps into the project type's chapterMin/chapterMax band
// ---------------------------------------------------------------------------

describe('holdout i7: clampToProjectType', () => {
  it('raises min to chapterMin and lowers max to chapterMax', () => {
    expect(
      clampToProjectType({ range: { min: 2000, max: 6000 }, projectType: ProjectType.NOVEL }),
    ).toEqual({
      min: WORD_COUNT_DEFAULTS[ProjectType.NOVEL].chapterMin,
      max: WORD_COUNT_DEFAULTS[ProjectType.NOVEL].chapterMax,
    });
    expect(
      clampToProjectType({ range: { min: 2000, max: 6000 }, projectType: ProjectType.NOVEL }),
    ).toEqual({ min: 3000, max: 5000 });
  });

  it('leaves a range already inside the band untouched', () => {
    expect(
      clampToProjectType({ range: { min: 3200, max: 4800 }, projectType: ProjectType.NOVEL }),
    ).toEqual({ min: 3200, max: 4800 });
  });

  it('uses the band of the project type it is given', () => {
    expect(
      clampToProjectType({ range: { min: 1000, max: 9000 }, projectType: ProjectType.NOVELLA }),
    ).toEqual({ min: 2500, max: 4000 });
  });

  it('collapses a range lying entirely outside the band onto the nearer bound', () => {
    // Both endpoints are clamped, so an out-of-band range degenerates instead of
    // inverting into a min greater than its max.
    expect(
      clampToProjectType({ range: { min: 8000, max: 12000 }, projectType: ProjectType.NOVEL }),
    ).toEqual({ min: 5000, max: 5000 });
    expect(
      clampToProjectType({ range: { min: 500, max: 1500 }, projectType: ProjectType.NOVEL }),
    ).toEqual({ min: 3000, max: 3000 });
  });

  it('clamps only the bound that is out of band', () => {
    expect(
      clampToProjectType({ range: { min: 3500, max: 9000 }, projectType: ProjectType.NOVEL }),
    ).toEqual({ min: 3500, max: 5000 });
    expect(
      clampToProjectType({ range: { min: 100, max: 4200 }, projectType: ProjectType.NOVEL }),
    ).toEqual({ min: 3000, max: 4200 });
  });
});

// ---------------------------------------------------------------------------
// Prompts interpolate the policy rather than hardcoding it (brief item 3).
//
// The runtime half of this pair ("the prompt says ±5%") is already true before
// this issue — it is the SOURCE half below that discriminates. Kept together
// because the pair is the actual requirement: the right string, produced by
// interpolation rather than by a literal.
// ---------------------------------------------------------------------------

const emptyContinuity: ContinuityState = {
  characters: [],
  timeline: [],
  plotThreads: [],
  worldState: {},
};

const style: Style = { voice: 'sparse and mythic', tense: 'past', pov: 'third-limited' };

describe('holdout i7: prompts state the policy tolerance', () => {
  it('the writer prompt states the writer tolerance', () => {
    const prompt = buildWriterPrompt({
      chapterNumber: 1,
      chapterOutline: 'Roland crosses the desert.',
      predecessorChapters: [],
      continuityState: emptyContinuity,
      style,
      wordCountTarget: PER_CHAPTER,
      projectType: ProjectType.NOVEL,
    } as WriterPromptParams);

    expect(prompt).toContain(formatToleranceForPrompt('writer'));
    expect(prompt).toContain('±5%');
  });

  it('the editor prompt states the review tolerance', () => {
    const prompt = buildEditorPrompt({
      chapterNumber: 1,
      style,
      wordCountTarget: PER_CHAPTER,
      continuityState: emptyContinuity,
      prNumber: 7,
      projectType: ProjectType.NOVEL,
      revisionRound: 0,
    } as EditorPromptParams);

    expect(prompt).toContain(formatToleranceForPrompt('review'));
    expect(prompt).toContain('±10%');
  });

  it('the reviser prompt states the review tolerance', () => {
    const prompt = buildReviserPrompt({
      reviewComments: 'Tighten the opening.',
      style,
      wordCountTarget: PER_CHAPTER,
      revisionRound: 1,
      chapterNumber: 1,
      projectType: ProjectType.NOVEL,
    } as ReviserPromptParams);

    expect(prompt).toContain(formatToleranceForPrompt('review'));
    expect(prompt).toContain('±10%');
  });
});

// ---------------------------------------------------------------------------
// Source-level invariants (brief items 2 and 3), read off disk.
// ---------------------------------------------------------------------------

// …/packages/core/src/word-count-policy/__tests__ → repository root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const promptsDir = join(repoRoot, 'packages', 'core', 'src', 'prompts');
const handlersDir = join(repoRoot, 'packages', 'lambdas', 'src', 'handlers');

const readSource = (path: string): string => readFileSync(path, 'utf-8');

const handlerSources = (): { name: string; source: string }[] =>
  readdirSync(handlersDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readSource(join(handlersDir, name)) }));

/** e.g. "±5%", "± 10 %" — a hardcoded tolerance percentage. */
const HARDCODED_PERCENT = /±\s*\d+(?:\.\d+)?\s*%/;

describe('holdout i7: the tolerance is no longer hardcoded in the prompt sources', () => {
  it('finds the prompt sources it is grading', () => {
    expect(readSource(join(promptsDir, 'writer.ts')).length).toBeGreaterThan(0);
    expect(readSource(join(promptsDir, 'editor.ts')).length).toBeGreaterThan(0);
    expect(readSource(join(promptsDir, 'reviser.ts')).length).toBeGreaterThan(0);
  });

  it('no word-count tolerance percentage literal remains in writer, editor or reviser', () => {
    const offenders = ['writer.ts', 'editor.ts', 'reviser.ts'].filter((name) =>
      HARDCODED_PERCENT.test(readSource(join(promptsDir, name))),
    );

    expect(offenders).toEqual([]);
  });
});

describe('holdout i7: handlers no longer recompute the policy', () => {
  it('finds the handler sources it is grading', () => {
    const sources = handlerSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.map((s) => s.name)).toContain('merge-chapter.ts');
  });

  it('no handler contains the expression "targetWordCount / "', () => {
    const offenders = handlerSources()
      .filter(({ source }) => source.includes('targetWordCount / '))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('no handler contains a literal word-count tolerance', () => {
    const offenders = handlerSources()
      .filter(({ source }) => /tolerance\s*(?::[^=]*)?=\s*0\.\d+/i.test(source))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
