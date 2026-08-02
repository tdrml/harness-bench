**Issue 3 — manuscript structure validation**

Before a manuscript can be packaged we must be able to reject a malformed one.
Add structure validation to the release-policy area of core.

Export a function:

```ts
export interface ChapterFile { path: string; content: string }

export interface ManuscriptError { code: string; detail: string }
export interface ManuscriptValidation { valid: boolean; errors: ManuscriptError[] }

export function validateManuscriptStructure(chapters: ChapterFile[]): ManuscriptValidation
```

Per-chapter rules, evaluated in `chapters` order:

1. `H1_MISSING` — the chapter content has no level-1 markdown heading.
2. `H1_NOT_FIRST` — the first non-empty line of the content is not the level-1
   heading.
3. `H1_MALFORMED` — the level-1 heading does not match `# Chapter <N>: <Title>`
   where `<N>` is one or more digits and `<Title>` is non-empty.
4. `H1_NUMBER_MISMATCH` — the `<N>` in the heading is not equal to the chapter
   number implied by the file's `path`.

Set-level rules, evaluated after the per-chapter pass:

5. `CHAPTER_DUPLICATE` — two chapters resolve to the same chapter number.
6. `CHAPTER_GAP` — the set of chapter numbers, sorted, is not `1..n` with no
   gaps.

Rules 3 and 4 are skipped for a chapter that already produced `H1_MISSING`.

`valid` is `true` only when `errors` is empty, and `errors` must be sorted by
`code` ascending, exactly like the validation function added earlier in this
epic — the two must be consistent in shape and ordering so callers can treat
them uniformly.

The canonical chapter-path convention already lives in this repository as a
helper in the writing module. Derive the expected path/number relationship from
that existing helper rather than writing another zero-padding expression: this
codebase already has that logic duplicated in a dozen places and we are not
adding a thirteenth.
