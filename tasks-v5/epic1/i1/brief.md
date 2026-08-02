**Issue 1 — `release-policy`: KDP listing validation**

We are about to automate the publishing step that today is a manual checklist in
`docs/KDP-LISTING.md`. Start with the pure validation rules; nothing is wired into
the pipeline in this issue.

Create a new core module at `packages/core/src/release-policy/` exporting:

```ts
export interface KdpListing {
  title: string;
  subtitle?: string | undefined;
  blurb: string;
  keywords: string[];
  categories: string[];
  author: string;
}

export interface ListingError { code: string; detail: string }
export interface ListingValidation { valid: boolean; errors: ListingError[] }

export function validateListing(listing: KdpListing): ListingValidation
```

Rules — each violation contributes exactly one error with the given `code`:

1. `BLURB_TOO_LONG` — `blurb` longer than 4000 characters.
2. `BLURB_EMPTY` — `blurb` is empty or whitespace only.
3. `KEYWORD_COUNT` — `keywords.length` is not exactly 7.
4. `CATEGORY_COUNT` — `categories.length` is not exactly 3.
5. `UNRESOLVED_PLACEHOLDER` — any string field (including entries of `keywords`
   and `categories`) contains the substring `TODO:`. One error total, not one per
   field.
6. `DISALLOWED_HTML` — `blurb` contains an HTML tag outside this allowlist:
   `b`, `i`, `u`, `br`, `p`, `ul`, `li`, `ol`, `h4`, `h5`, `h6`. Matching is
   case-insensitive and closing tags count as the same tag. One error total.

`valid` is `true` only when `errors` is empty. `errors` must be sorted by `code`
ascending (plain lexicographic order) so the output is stable.

Also export a constant `MAX_BLURB_LENGTH = 4000`, `REQUIRED_KEYWORD_COUNT = 7`,
`REQUIRED_CATEGORY_COUNT = 3` and `ALLOWED_BLURB_TAGS` (the allowlist above) from
the module.

Everything this module exports must be reachable by consumers of the `@auto-graph/core`
package, following the way the package's other modules are surfaced.
