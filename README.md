# harness-bench

**A calibration study: where does agent-harness engineering actually pay off?**

Thomas Loth · July 2026 · [thomasloth.com](https://thomasloth.com) · MIT

---

## TL;DR

I run autonomous coding-agent fleets in production. Their harness — deterministic done-gates, schema-forced outputs, adversarial review loops, cost routing — visibly earns its keep there: **28.8% of recent dev-class runs (106 of 368) hit at least one deterministic guardrail block**, each a failure that prose instructions had been letting through on multi-hour runs.

So I tried to measure the same layers under controlled conditions: same model, same tasks, harness ablated arm by arm.

**Result: at the scale most coding benchmarks operate — single-session, minutes-long, well-scoped tasks against a well-tested repo — the harness added nothing.** 54 of 54 graded runs succeeded across every arm, both models, and all five task classes, including tasks designed so that only a held-out test suite could catch a wrong fix. Claude Haiku 4.5 with no harness at all matched Claude Sonnet 5 with the full harness, at ~40% of the cost. The harness's only measurable effect at this tier was ~2× cost.

The interesting conclusion is the tension between those two facts: **harness ROI is a function of horizon, not a constant.** Below some task-length/autonomy threshold, frontier models don't need the scaffolding. Production fleets operate far above that threshold, where the same scaffolding blocks failures continuously. Benchmarks that grade harnesses on short tasks are measuring the flat part of the curve.

Two harness failure modes surfaced along the way that I haven't seen documented (§ Findings 2–3), including the adversarial reviewer discovering a real, unplanted prototype-chain bug in the target codebase.

---

## Method

**System under test:** [`telos`](https://github.com/tdrml/telos) — a 20K-LOC TypeScript monorepo (pnpm workspaces, vitest, 732 tests), pinned at `c62bcf6`. Chosen because I own it, it has a serious test suite, and it was private during all graded runs (contamination note below).

**Arms** (cumulative; fixed prompts otherwise):

| Arm | Adds |
|---|---|
| `A0` | Bare prompt. Agent self-reports done. |
| `A1` | Deterministic done-gate: a Claude Code `Stop` hook that blocks the agent from finishing until the full suite is green (max 3 blocks). |
| `FULL` | + schema-forced result contract (one salvage retry) + adversarial reviewer agent with one revision round. |

**Models:** `claude-sonnet-5` (A0/A1/FULL) and `claude-haiku-4-5` (A0/FULL), invoked headless via the Claude Code CLI in throwaway checkouts with an isolated config dir.

**Scoring (three layers, all deterministic):**
1. **Visible suite** — the repo's own 732 tests.
2. **Tamper check** — any modified *or newly added* test file fails the run.
3. **Held-out verification** — assertions the agent never sees, kept outside the working tree and injected only at scoring time. Calibrated before any graded run: green on pristine, red under every planted bug. `success = visible ∧ holdout ∧ ¬tamper`; `silentFailure = visible ∧ (¬holdout ∨ tamper)`.

**Pre-registration:** the design, arms, metrics, and cost caps were committed to this repo (`863f03c`, `6161e2a`) before the corresponding graded runs. One mid-pilot runner patch was made (reviewer turn budget — § Finding 2); it is journaled as a `note` event in `results/pilot2.jsonl` and affected runs stand as recorded.

**Tasks:**

*Pilot 1 (15 runs):* five single-line mutations with the failing tests named in the brief — merge-policy precedence, log-level boundary, HTTP-429 classification, SQS batch slicing, Zod schema strictness.

*Pilot 2 (39 runs):* eight harder tasks in four classes:
- **discovery** — a failing test exists but the brief only says "CI is red";
- **compound** — three coupled bugs across multiple modules per task;
- **behavior-report** — the planted bug leaves all 732 visible tests **green**; the brief is a prose production bug report; only the holdout can grade the fix (poisoned lock-takeover condition, FIFO message-group leakage, invalid-`LOG_LEVEL` fallthrough);
- **feature** — spec-implementation briefs graded by red-on-pristine acceptance holdouts (a CI gate parameter for merge policy; SQS partial-batch-failure surfacing).

A bonus datum: one candidate mutation turned out to be invisible to the *entire* visible suite despite 732 tests — real coverage gaps of the kind behavior-report tasks model exist even in disciplined codebases.

---

## Results

**Pilot 1** — 15/15 success, 0 silent failures, 0 gate blocks, $3.80 API-equivalent, ~32 min. Every diff was the exact minimal root-cause fix.

**Pilot 2** — 39/39 success (one cell, `f2:haiku:FULL`, was not run), 0 silent failures, 0 tamper, 0 gate blocks, $11.12:

| cell | success | silent | total cost | median wall |
|---|---|---|---|---|
| sonnet:A0 | 8/8 | 0 | $2.42 | 83s |
| sonnet:A1 | 8/8 | 0 | $2.08 | 106s |
| sonnet:FULL | 8/8 | 0 | $4.05 | 151s |
| haiku:A0 | 8/8 | 0 | $1.01 | 157s |
| haiku:FULL | 7/7 | 0 | $1.56 | 274s |

By class: discovery 5/5 · compound 10/10 · behavior-report 15/15 · feature 9/9.

Raw per-run records (JSONL journals including per-invocation costs and raw reviewer output) and every agent diff are in [`results/`](results/).

### Findings

**1. No correctness separation at this task scale — the null is the datum.** Both models fixed every planted bug and implemented every feature from prose alone, including green-suite bug reports requiring root-cause reasoning about DynamoDB conditional writes and FIFO message grouping. The done-gate never fired (agents already ran the suite unprompted). The reviewer never caught a defect (there were none to catch). If your tasks look like SWE-bench tasks, a 2026 frontier model does not need your harness — and Haiku at $0.13/task-average is the rational choice.

**2. The silent reviewer no-op — a harness failure mode that looks like working review.** In early FULL runs the adversarial reviewer, told to judge the diff "on its face," chose to read repository files anyway, exhausted its 4-turn budget mid-tool-call, and died emitting *no verdict at all* (`is_error`, `stop_reason: tool_use`) — while the run proceeded and recorded as if review had happened. 5 runs across both pilots were affected before the patch (turn budget 4→20, verdict parsed only from clean results, raw reviewer text journaled). The general lesson for anyone building review layers: **a review stage that can fail without failing the pipeline will, on some fraction of runs, silently not review** — and unless you journal its raw output, you cannot tell those runs from approvals afterward. This is a small-scale controlled reproduction of a failure class I've also had to engineer against in production.

**3. The reviewer found a real bug we didn't plant.** On `b3:haiku:FULL`, the reviewer refused to bless a correct fix, warning that the log-level validation `raw in LOG_LEVEL_ORDER` accepts `LOG_LEVEL=toString` via the prototype chain — `'toString' in {DEBUG:0,...}` is `true` in JavaScript — which makes the min-level comparison `number < function` → `false`, disabling filtering entirely. Verified: this bug is real and exists in the *pristine* target codebase. It was recorded as an unparseable verdict only because the model led with prose instead of the required JSON. In 54 graded runs, the review layer's single deviation was a true positive about a bug nobody knew about.

**4. Cost structure.** FULL ≈ 1.7–2.1× A0 cost at equal correctness. Haiku ≈ sonnet correctness at ~40% cost, ~1.7× wall. At this task tier, harness spend buys audit trail and tamper evidence — legitimate goods! — but not correctness.

---

## Where harness value actually lives (the production contrast)

The platform I operate in production runs coding agents for up to four hours per task in isolated containers, across a fleet that has authored 1,000+ merged PRs (~98% merge rate) across ~13 repositories. Its telemetry over a recent window shows **28.8% of dev-class runs (106/368) hitting at least one deterministic guardrail block** — dirty-tree stops, force-push prevention, done-without-PR gates — each one a divergence prose rules had failed to prevent. The same platform needed schema-forced outputs after prose JSON kept breaking, payload offload after context silently dropped, and a render-before-merge gate after reviewer agents approved visually wrong UIs.

Same model family. Same harness patterns. Opposite ROI.

The variable that changed is **horizon**: minutes vs hours, one objective vs a task DAG, fresh checkout vs accumulated state, one agent vs a fleet with coordination surface. The pilots bound the harness-value curve from below; production telemetry bounds it from above. The interesting research question — and the one pilot 3 aims at — is where the knee is.

**Pilot 3 (pre-registered next step):** hour-scale, cross-cutting feature builds on the same target repo (new worker mode end-to-end, pluggable queue backend, webhook event expansion) under the same arms, hunting the onset of separation.

## Threats to validity

- **n = 1 per cell.** These pilots calibrate difficulty and validate mechanics; they are not powered for small effects. The null here is "no separation visible at n=1 with 100% ceiling," which is a statement about task difficulty, not a precise effect estimate.
- **One author wrote the tasks, the holdouts, and the harness.** Pre-registration and published raw journals mitigate; they don't eliminate.
- **Contamination:** the target repo was private during all graded runs and published afterward; task briefs are synthetic; model training cutoffs predate the repo's existence in public form.
- **The production numbers are observational**, from one platform, and not independently auditable in this repo (the platform is company-owned). They motivate the horizon hypothesis; they don't prove it.
- The reviewer/harness implementations are minimal clean-room versions of the production patterns, not the production code.

## Reproduce

```bash
git clone https://github.com/tdrml/harness-bench && cd harness-bench
git clone https://github.com/tdrml/telos .pristine-telos   # pinned target
cd .pristine-telos && git checkout c62bcf64 && pnpm install --frozen-lockfile && pnpm build && cd ..
mkdir .claude-bench-config && cp ~/.claude/.credentials.json .claude-bench-config/  # isolated auth
node runner/run-pilot.mjs    # pilot 1 (15 runs, ~$4)
node runner/run-pilot2.mjs   # pilot 2 (40 runs, ~$12)
```

Runners are sequential, resumable (JSONL journal is the source of truth), and kill-switched on summed API-equivalent cost.

## License

MIT — see [LICENSE](LICENSE). The `telos` target repo is separately MIT-licensed.
