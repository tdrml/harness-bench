# Pilot 7 – pre-registration (committed before any graded run)

**Date:** 2026-08-02 · **Study:** `tdrml/harness-bench` · **Author:** Thomas Loth

Pilots 1–6 all ran **single-session, minutes-to-an-hour** tasks. The study's own
headline claim is that *harness ROI is a function of horizon*, and the production
contrast it cites (28.8% of dev-class runs hitting a deterministic guardrail block)
comes from multi-hour, multi-issue, stateful work. That regime was never tested.
Pilot 7 tests it.

## Question

When work arrives as a **sequence of dependent issues against one accumulating
codebase** — rather than as one well-scoped task against a pristine one — does the
enforcement harness matter more, and does model tier still substitute for it?

## Design

**One epic, eight sequentially dependent issues, delivered one issue per session.**

- Target repo: [`auto-graph`](https://github.com/tdrml/auto-graph) pinned at `494194d`
  (12.1K LOC production TypeScript + 19.3K LOC tests, 1,122 tests, 4 packages).
- Each issue is a fresh headless agent session in the **same working tree**. State
  accumulates in the code, not in the context window: conventions introduced by
  issue *N* must be **rediscovered from the repository** by issue *N+k*.
- One git commit per issue, so per-issue diffs and the full-epic diff are both exact.
- The agent is never shown the other issues' briefs, the epic plan, or its own
  earlier sessions. This is the realistic issue-queue model, and it is what makes
  omission-class failure (finding 16) reachable.

**Grid:** {haiku-4.5, sonnet-5, opus-5} × {A0, FULL} × n=3 = **18 epic runs = 144
graded issues.** No planning arm (settled by pilots 4–5); this isolates tier ×
enforcement at long horizon.

**Arms** (unchanged from pilots 5–6 except where noted):

| Arm | Adds |
|---|---|
| `A0` | Bare prompt, agent self-reports done. |
| `FULL` | Done-gate (`Stop` hook, max 3 blocks) + schema-forced result contract with one salvage retry + adversarial reviewer with one revision round. **Applied per issue.** |

**Pre-registered change to the gate:** the done-gate now runs `pnpm build && pnpm test`,
not `pnpm test` alone (`arms/stop-gate-v2.sh`). Finding 17a established that vitest
transpiles per-file without typechecking, so the v1 gate could pass a broken build.
v1 is retained unmodified for provenance.

## Why an epic can discriminate where pilot 5's tasks could not

Pilot 5's finding 11 was that **task difficulty, not repetitions, is the binding
constraint on power** — 4 of 6 tasks saturated at 100% and killed the effective
sample. Adding reps cannot fix that; authoring reliably-40–80% tasks is hard.

Horizon is a second lever on the same problem, and it composes:

> If per-issue success is *p*, epic success is ≈ *p*<sup>8</sup>.
> At p=0.95 — a task tier where every single-issue pilot saturates — epic success is
> **66%**. At p=0.85 it is **27%**. At p=0.99, still 92%.

**A sequence of individually-easy issues lands in the discriminating band even when
no single issue would.** This is pre-registered as the design's central bet, and it
is falsifiable: if per-issue rates come back at 0.99+ for every tier, the epic
saturates too and the bet was wrong. That result would itself be publishable — it
would say the compounding intuition is wrong because failures are not independent.

Independence is explicitly **not** assumed. Cascade (issue *N*'s failure causing
*N+k*'s) is a measured quantity here, not a nuisance — see `cascadeDepth` below.

## Metrics (pre-registered; computed from `results/pilot7.jsonl`)

**Per issue:**
1. `strict` = `build ∧ visible-suite ∧ holdout`. Strict from the start (finding 17a).
   The holdout is graded **twice**: once by the compiler and once by vitest. The
   injected holdout file is typechecked in place (`tsc --build` covers `src/**`)
   before its assertions run, because a missing `export type` from a barrel is
   invisible at runtime — and type-level barrel omission is precisely the failure
   class this epic plants. `holdoutPass` requires both.
2. `silent` = `visible ∧ ¬holdout` — the agent believed it was done and the repo agreed.
3. `blocks` — done-gate firings (FULL only), reset per issue.
4. `reviewVerdict`, `revised` — reviewer engagement (FULL only).
5. `testEdits` — test files modified or added.
6. cost, wall-clock, turns.

**Per epic (the new metrics — impossible in a single-task pilot):**
7. **`survival`** — number of consecutive strict-green issues before the first
   strict failure. The headline horizon metric.
8. **`epicStrict`** — build ∧ suite ∧ *every* issue holdout ∧ the integration
   holdout, all evaluated at the end of the epic.
9. **Regression decay** — issues whose holdout was **green at their own boundary and
   red at epic end**. A later issue silently broke an earlier delivery. No
   single-task benchmark can observe this.
10. **Repair** — the converse: holdout red at its boundary, green at epic end.
11. **`cascadeDepth`** — issues after the first failure that fail *because* of it,
    assigned by post-hoc autopsy, not computed. Reported as an autopsy claim.
12. **Integration holdout** — an end-to-end pipeline test that only passes if the
    registration work in issues 4 and 6 was complete, including in **test
    infrastructure** the agent was never told to touch.

**Cost:** $/epic and $/strict-epic per cell; per-issue medians by tier.

## The epic: "Release & packaging phase"

Extends the book pipeline past `FINAL_REVIEW` with a two-stage release phase, plus
one unrelated cross-cutting migration (realistic: epics are not homogeneous).

| # | Issue | Class | Deliberate omission surface |
|---|---|---|---|
| i1 | `release-policy` module: KDP listing validation | new pure module | must export through the `core/index.ts` barrel |
| i2 | `PACKAGE_MANUSCRIPT` work item + `packager` worker type | schema/union wiring | `queue/index.ts` barrel re-export (schema **and** type) |
| i3 | manuscript structure validation | pure module | must reuse the existing `getChapterFilePath` helper and i1's error-shape convention |
| i4 | packager handler + full registration | cross-cutting wiring (10 sites) | integration-test `HANDLER_MAP`; reconcile has **two** switches; worker barrel |
| i5 | extract `launchAgentRun`, migrate 9 handlers, unify on `ulid()` | refactor | 3 handlers use `randomUUID`; the 9th handler is i4's own |
| i6 | `GENERATE_LISTING` stage | convention carry-forward | must repeat every i2/i4 site **and** use i5's helper **and** i1's validator |
| i7 | word-count policy consolidation | cross-cutting migration over existing debt | 4 of the tolerances are English prose inside prompt template strings |
| i8 | wire the phase end-to-end + docs sync | integration + docs | pre-existing README/HLD count drift, pinned exactly in the brief |

Every rule an issue is graded on (error codes, exact counts, tolerances, rounding,
status values) is pinned literally in that issue's brief. Holdouts assert only what
the brief pins. This is a completeness test, not a mind-reading test. The briefs
pin the *required end state behaviorally* and never enumerate the files to edit —
locating the sites is the work under measurement.

**Holdout invariance rule.** An issue's holdout may assert only properties that are
still true at the end of the epic. Issue 8 deliberately revises behavior that issue
4 introduced (packager completion gains a follow-up enqueue), so issue 4's holdout
asserts that reconcile *recognizes and succeeds* a packager run and says nothing
about what else it enqueues. Without this rule the regression-decay metric would
fire on correct work, and decay would be uninterpretable.

**i7 resolves a real latent inconsistency** in the target: the writer gate
(`reconcile.ts`) uses tolerance 0.1 with floor/ceil rounding, the merge gate
(`merge-chapter.ts`) uses 0.2 with floor/floor, and the prompt prose says ±5%
(writer) and ±10% (editor/reviser). The brief pins the resolution; the divergence is
what makes the boundary assertions unambiguous.

## Calibration gate (before any graded run)

1. A **reference implementation** of all 8 issues is built by the author.
2. Every issue holdout must be **red on the pre-issue state and green on the
   reference state**. Any holdout that is green before its issue is rewritten.
3. The integration holdout must be red at every point before i8 and green after.
4. `pnpm build && pnpm test` green on the reference implementation.
5. A **smoke epic** (bare haiku, n=1, journaled as rep 0 and excluded from grid
   analysis) validates mechanics and the per-issue cost model.

Calibration results are journaled to `results/pilot7.jsonl` as `calibration` events
before the grid runs.

## Cost control

- Global study ceiling **$1,000** (raised from $555 on 2026-08-02), of which
  **$256.26** was spent through pilot 6. Runner kill-switch aborts at the ceiling.
- Per-epic cap $150; exceeding it halts that epic and journals a `note`.
- Estimated grid cost $600–700; the smoke run re-estimates before the grid, and reps
  are reduced for the opus cells if the estimate exceeds the remaining budget.

## Validity guards (carried forward, plus new)

- **Autopsy every failure before counting it** (finding 6). Roughly half of one
  pilot's recorded failures were the instrument's own bugs.
- **Plausibility alarms** are journaled per issue — cost < $0.02, wall < 30s,
  turns ≤ 2, zero files changed (finding 17b). They flag for autopsy; they never
  auto-score.
- **Auth-death detection**: a primary invocation returning zero cost with no session
  id invalidates that issue and halts the epic rather than recording a model failure.
  The credentials are verified before the grid starts, not discovered mid-run.
- **Append-only corrections**: invalidated runs stay in the journal marked
  `invalidated` with a reason.
- Both target repos were private during all graded runs and published afterward;
  briefs are synthetic; the epic is authored specifically for this pilot.

## Known limitations, stated in advance

- **One repo, one epic, one author.** Pilot 7 does not fix the single-repo threat
  that pilot 6 inherited; it trades breadth for horizon deliberately.
- **n=3 at the epic level** is 18 epics. Per-issue n is 54 per cell, but issues
  within an epic are *not* independent, so per-issue proportions must not be pooled
  as if they were. Epic-level tests use the epic as the unit.
- The epic is authored by the same person who wrote the harness and the holdouts.
- Issue ordering is fixed, not counterbalanced: order effects and issue difficulty
  are confounded by construction. A later pilot could permute the order.

## Correction issued with this pre-registration

While selecting the target, the published claim that `auto-graph` is a **"79K-LOC"**
repo was found to be wrong. That figure counts generated `dist/*.d.ts` build
artifacts as source. Hand-written TypeScript is **12,094 lines of production code +
19,325 lines of tests = 31,419**; all tracked files total 35,251. `telos`'s published
"20K LOC" is correct (6,655 + 13,294 = 19,949), so the two repos were measured by
**different methods** and were not comparable.

This matters beyond bookkeeping: pilot 6 attributed its task-difficulty pattern to
codebase scale on a stated 20K-vs-79K gap that is really **20K vs 31K**. That
explanation is correspondingly weaker, and the README has been corrected to say so
rather than edited quietly. See finding 18.

---

## Amendment 1 — 2026-08-02, before any graded run

The shared preamble originally asserted "The full suite is green when your session
starts." That is true for issue 1 and false for any issue following a failed
predecessor — which is precisely the cascade condition this pilot exists to measure.
It would have been a constant across all cells, so it threatened no comparison, but
it is a false statement that could cost an agent turns arguing with its own test
output. The clause is removed; the instruction to verify with
`pnpm -s build && pnpm -s test` remains.

No graded run had executed at the time of this amendment (only a one-issue plumbing
test of the runner, journaled at `rep: 0` and excluded from analysis). Recorded here
rather than edited into the design silently, per the study's append-only convention.

## Amendment 2 — 2026-08-02, before any graded run

The calibration gate caught a **specification bug in issue 7's brief**, which is
exactly what it exists to do.

`clampToProjectType` was specified as "`min` is raised to `chapterMin` when below
it, `max` is lowered to `chapterMax` when above it." That rule is silent on a range
lying entirely *outside* the band. The reference implementation followed it
literally and, for a NOVEL project resolving to `{8000, 12000}` against the band
`[3000, 5000]`, returned `{min: 8000, max: 5000}` — a range whose minimum exceeds
its maximum. The holdout author had independently assumed a sane reading and
asserted something else. Neither was wrong; the brief was.

The brief now pins both endpoints explicitly as formulas:

```
min: Math.min(Math.max(range.min, chapterMin), chapterMax)
max: Math.min(Math.max(range.max, chapterMin), chapterMax)
```

so an out-of-band range collapses onto the nearer bound (`{5000, 5000}`) instead of
inverting. The reference and the i7 holdouts were brought into line, and the
degenerate case is now graded explicitly rather than left implicit.

Also in this amendment: issue 6's holdout asserted the marketer prompt matched
`/\b7\b[^\n]{0,40}keywords/`, which requires the digit to precede the noun. The
brief pins that the prompt states the counts, not the sentence shape — "keywords
must contain exactly 7 entries" satisfies it. The assertion is now order-agnostic.
That one was a holdout over-specification, not a brief bug.

No graded run had executed at the time of this amendment. Both problems were found
by replaying the reference implementation commit by commit against the holdouts —
a gate that costs one afternoon and would otherwise have produced a benchmark where
correct implementations fail on issue 7 in every cell of the grid.

## Amendment 3 — 2026-08-02, after the smoke epic, before the grid

The smoke epic (bare haiku, all 8 issues) exposed a **measurement conflation** in the
pre-registered per-issue metric, and one new field is added to resolve it. The
`strict` definition itself is unchanged.

What happened: haiku passed issues 1–4, then on issue 5 — extract a shared launch
helper and migrate nine handlers — produced a **correct production refactor** whose
holdout assertions passed 13/13, while leaving ten TypeScript errors in three
pre-existing test files it had edited. Issues 6 and 7 then failed with **byte-identical
errors, at identical line and column positions, in files they had no reason to touch**.

`tsc --build` is per-package. Once any issue leaves a type error anywhere in a package,
every later issue's holdout in that package fails its typecheck regardless of how good
that issue's own work was. Issues 6 and 7 passed their own assertions 28/28 and 23/23
and were still scored `strict: false`.

That is a true statement about the epic — the repository really is broken, and an
unrepaired build break really is a failure — but pooled as a per-issue proportion it
reads as "haiku failed three issues", which the data contradicts. Haiku did all seven
issues' work correctly and had **one** defect that cascaded into three red issues.

Therefore, recorded from now on:

- `holdoutAssertionsGreen` — the holdout's vitest verdict alone, per issue, and
  `endAssertions` in the epic rollup.
- The analyzer reports **own-work green** alongside **strict**, and lists
  *cascade suspects*: issues whose assertions passed but whose strict verdict is red.
  The gap between the two columns is the measured cost of cascade.

`strict` remains `build ∧ visible ∧ holdout` exactly as pre-registered, and remains
the headline. Nothing is re-scored; a field is added and a second view is reported.
Cascade attribution stays an autopsy claim, not a computed one — the new column
identifies candidates, it does not confirm them.

This is the pilot's first substantive result, and it arrived before a single graded
run: **at epic scale the expensive failure is not doing an issue wrong, it is leaving
the repository broken for everyone downstream.** It is also the sharpest possible
motivation for the FULL arm, whose done-gate runs `build && test` and would have
refused to let issue 5 stop.
