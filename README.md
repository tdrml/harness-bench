# harness-bench

**A calibration study: where does agent-harness engineering actually pay off?**

Thomas Loth · July 2026 · [thomasloth.com](https://thomasloth.com) · MIT

---

## TL;DR

I run autonomous coding-agent fleets in production. Their harness — deterministic done-gates, schema-forced outputs, adversarial review loops, cost routing — visibly earns its keep there: **28.8% of recent dev-class runs (106 of 368) hit at least one deterministic guardrail block**, each a failure that prose instructions had been letting through on multi-hour runs.

So I tried to measure the same layers under controlled conditions: same model, same tasks, harness ablated arm by arm.

**Result: at the scale most coding benchmarks operate — single-session, minutes-long, well-scoped tasks against a well-tested repo — the harness added nothing.** 54 of 54 graded runs succeeded across every arm, both models, and all five task classes, including tasks designed so that only a held-out test suite could catch a wrong fix. Claude Haiku 4.5 with no harness at all matched Claude Sonnet 5 with the full harness, at ~40% of the cost. The harness's only measurable effect at this tier was ~2× cost.

The interesting conclusion is the tension between those two facts: **harness ROI is a function of horizon, not a constant.** Below some task-length/autonomy threshold, frontier models don't need the scaffolding. Production fleets operate far above that threshold, where the same scaffolding blocks failures continuously. Benchmarks that grade harnesses on short tasks are measuring the flat part of the curve.

**Pilot 5 replicated it at n=3 on two repos — and found the sharp edge of planning.** Across 72 runs on 6 new tasks, only one configuration went perfect: **plan + full harness, 18/18**. Bare-with-plan went 14/18, *below* bare-without-plan (16/18), and the autopsy explains why: a plan substitutes for exploration, so when its consistency sweep is incomplete, the executor stops at the checklist instead of discovering the gap. No comparison reaches p<0.05 — see § Pilot 5 for why that honest caveat matters more than the point estimates.

**Pilot 4 then split the harness's value in two.** Giving the same failing executor a written implementation plan — authored by *any* tier, including haiku planning for itself — fixed the spec-misreading failures completely (planned haiku: 17/18 bare vs 1/3 unplanned), but the one failure that survived was the follow-through relapse, and only the enforcement loop closed it reliably. **Plan for the *what*, harness for the *whether*.**

**Pilot 3 found the onset.** At hour-scale, cross-cutting feature builds (a new worker mode wired through five layers; a 17-file refactor; a webhook flow), the top-tier model still didn't need the harness — but the small model did, decisively: **haiku went 1/3 bare and 3/3 with the full harness**, matching sonnet's outcomes at roughly a third of the cost (n=1 per cell; § Pilot 3). The harness acted as a model-tier equalizer exactly where horizon got long.

Three harness failure modes surfaced along the way that I haven't seen documented (§ Findings 2–3, 7), including the adversarial reviewer discovering a real, unplanted prototype-chain bug in the target codebase — and a grading meta-result: **half of the failures my own instrument recorded were the instrument's fault** (§ Finding 6).

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

## Pilot 3 — hour-scale tasks, and the onset of separation

Three cross-cutting feature builds against the same pinned repo, each spanning multiple packages: **L1** add a complete new worker mode end-to-end (prompt module → worker class → entrypoint routing → work-item schema → CDK task definition), **L2** refactor the queue behind a pluggable backend interface and migrate every caller, **L3** extend the webhook handler for `pull_request: review_requested` with a task lookup and enqueue. Per-package held-out acceptance suites, red-on-pristine by construction. Grid: {sonnet, haiku} × {A0, FULL}, n=1 per cell. Runs took 5–17 minutes and $0.39–$4.70 each; these tasks legitimately extend tests, so test edits were recorded rather than failed.

**True results, after autopsy-verified corrections (see Finding 6):**

| | A0 | FULL |
|---|---|---|
| **sonnet** | 3/3 | 3/3 |
| **haiku** | **1/3** | **3/3** |

**5. Separation exists, and it is model-tier × horizon.** Sonnet needed no harness even here. Bare haiku failed two of three — and the failure modes are the production-relevant ones: on L2 it built a *correct* abstraction (held-out suite green) but left 5 repo tests broken mid-migration and declared done — breadth-of-completion failure; on L3 it shipped a 200 where the spec said 202, with its own added tests asserting its own misreading — spec-fidelity failure, invisible to self-validation. With the FULL harness, haiku went 3/3, matching sonnet's outcomes at ~⅓ the cost. Attribution caveats are real at n=1: in L2:haiku:FULL the done-gate never fired and the reviewer verdict didn't parse, so discipline-by-contract vs. variance can't be distinguished from one run.

**6. Grading agents is harder than running them.** Four failures were recorded; **two were my instrument's bugs**, found only by manually autopsying every failure: (a) my L3 holdout set env vars in `beforeEach`, but agents that idiomatically initialize config-dependent services at module scope crash the import before any hook runs; (b) re-scoring from saved diffs silently used stale build output for cross-package imports, because `git diff` cannot carry gitignored `dist/`. Both corrections are append-only events in the journal next to the original records. If a five-task pilot by the person who wrote both the tasks and the grader has a 50% false-failure rate among recorded failures, leaderboard-scale results graded by weaker pipelines deserve deep suspicion — this is the false-*negative* twin of UTBoost's ~20% false-positive finding.

**7. The detection–transport gap.** In L3:haiku:FULL, the adversarial reviewer *caught real spec deviations* and returned `REQUEST_CHANGES` — formatted as markdown prose instead of the required JSON. The runner's parser dropped it, no revision ran, and the pipeline proceeded exactly as if the review had approved. Detection succeeded; the verdict transport failed. This is Finding 2's sharper sibling, and it indicts my own runner: the primary agent's output got a schema-salvage retry, the reviewer's verdict did not. **Every inter-agent handoff needs the same contract enforcement as the final output — a harness is only as strong as its least-enforced edge.** (This exact pattern — schema-force *everything*, with salvage retries — is what my production platform converged on after equivalent incidents.)

---

## Pilot 4 — the planning-tier ablation

Hypothesis under test (raised after pilot 3): *frontier models are only needed to architect/plan/write the issue; given a spec-precision plan, a cheap executor matches frontier execution.* Design: executor = haiku everywhere; a real "tech lead" planner invocation (reads the repo, writes spec-critical details → ordered steps → consistency sweep → acceptance checklist, no code) cached per task × planner tier; tasks L1–L3; n=2. Pre-registered before runs, including the mid-pilot opus extension (journaled before any opus cell ran). Runner debts from pilot 3 paid first: reviewer verdicts now get the same schema-salvage as primary output (Finding 7), and the scorer builds before grading (Finding 6b).

| haiku executor | A0 | FULL |
|---|---|---|
| no plan (pilot 3, n=1) | 1/3 | 3/3 |
| haiku-plan ($0.15–0.22/plan) | 6/6 | — |
| sonnet-plan ($0.98–1.52/plan) | 5/6 | 6/6 |
| opus-plan ($1.49–1.85/plan) | 6/6 | — |

24 runs, $30.18 including all planner invocations. The sole failure: `L2:sonnet-plan:A0` rep 2 — the same mid-migration walk-away as unplanned haiku, *with the consistency sweep spelled out in its instructions*.

**8. Specification and enforcement fix different failure classes.** Planning cured the spec-fidelity failure completely: on the 200-vs-202 task, planned haiku went 6/6 bare across all three planner tiers. It could not reliably cure the follow-through failure: the L2 relapse recurred under a sonnet plan, and in the plan+FULL cells the reviewer issued REQUEST_CHANGES → revision in **both** reps — the enforcement loop doing exactly the work specification couldn't. Reviewer engagement tracked the failure class perfectly (APPROVE on L1/L3, REQUEST_CHANGES on L2, both reps).

**9. Planner tier barely mattered — including the model planning for itself.** haiku-plan 6/6, opus-plan 6/6, sonnet-plan 5/6: decomposition itself is the medicine, not the prestige of the decomposer (opus's 2/2 on the relapse task vs sonnet's 1/2 is a planner-tier hint, not a powered result). The sharpest datum: **haiku-as-planner wrote the spec-critical "202" into its plan four times — the same model that drops it while executing unplanned.** Reading-to-plan and writing-to-implement appear to be different cognitive regimes within one model; separating them is nearly free ($0.15–0.22/plan).

**10. The cheapest reliable stack observed has no frontier model in it:** haiku-plan → haiku executor → deterministic gates + reviewer. ~$0.85/task all-in at hour scale, matching sonnet's outcomes on this task set.

---

## Pilot 5 — powered replication, two repos, and the sharp edge of planning

Pilots 3–4 ran n≤2 on three tasks in one repo. Pilot 5 is the replication: **6 new calibrated tasks across two repos** (telos and [auto-graph](https://github.com/tdrml/auto-graph), a 79K-LOC pipeline pinned at `494194d`), a clean 2×2 of **planning × enforcement**, executor haiku throughout, **n=3** — 72 runs, $63.60 including all six plans ($0.84 total; haiku planned the whole corpus for under a dollar).

Tasks split evenly into two classes. **Breadth**: inject table names into 5 service constructors and migrate every site (tb1); convert `enqueue` to a params object across ~34 call sites (ab1); add a required `locations` field to `ContinuityState` and update every constructor of it (ab2). **Spec**: a `/cancel` webhook command with exact 202/200 responses (ts1); a lock-takeover grace period with exact `:now = epoch − grace` arithmetic (ts2); a strict word-count mode with adversarial tokenization vectors (as1).

| haiku executor | A0 | FULL |
|---|---|---|
| no plan | 16/18 (89%) | 17/18 (94%) |
| haiku-plan | 14/18 (78%) | **18/18 (100%)** |

**11. The honest statistics: nothing here reaches significance.** Two-sided Fisher exact: FULL vs A0 overall p=0.107; plan+FULL vs plan+A0 p=0.104; breadth-only FULL vs A0 p=0.088; plan vs no-plan at A0 p=0.658. Pilot 5 was designed to be the powered replication and **it is not**, for a reason worth publishing: **4 of the 6 tasks saturated at 100% in all four cells** (every spec-class task went 9/9 everywhere), so the effective sample is 2 tasks, not 6. My new spec-class tasks failed to reproduce the difficulty of pilot 4's spec task — the executor simply got them right, planned or not. Powering this design means task authoring that reliably lands in the 40–80% band, and that is harder than adding reps: task difficulty, not run-to-run variance, is the binding constraint on statistical power in agent benchmarks.

**12. Planning substitutes for exploration — which is why an incomplete plan is worse than none.** All 7 failures in the study were breadth-class, from 2 of 6 tasks. The most informative is `tb1:haiku-plan:A0`, which failed twice where the unplanned arm went 3/3. The autopsy: **both arms made the identical production change** — module-scope `const config = getConfig()` in 14 handlers, table names passed to constructors. The difference was the ripple. Moving the config read out of the (test-mocked) service class and into the handler module crosses the mock boundary, so 19 handler test files now execute the real `getConfig()` at import time and die on unset env. **The unplanned run discovered this by running the suite and fixed 20 test files. The planned run fixed 1.** The plan's consistency sweep had eleven checkboxes and looked exhaustive — but enumerated only the core package's test instantiations and never mentioned the handler tests. The executor treated the checklist as the definition of done. A plan is an authority claim about what completeness means; when it is wrong, it is wrong *confidently*, and it displaces the search that would have caught it.

**13. Enforcement is what makes planning safe.** The same task, same plan, with the harness: 3/3. The done-gate does not care what the plan enumerated — it re-runs the suite and blocks the stop, so the blind spot surfaces anyway. This is the first pilot where the deterministic gate visibly fired in production conditions: **6 of 36 FULL runs hit at least one block (14 blocks total), and 3 runs saturated the 3-block bound**; the reviewer returned REQUEST_CHANGES on 10 of 36 and every one of those triggered a revision round. The gate-block rate here (17% of harnessed runs) is the same order as the 28.8% measured on multi-hour production runs, from a clean-room reimplementation of the same idea. Cost of the reliable configuration: **$1.12 per success (plan+FULL) versus $0.83 per success for bare** — a 35% premium for the difference between 89% and 100%, with no frontier model anywhere in the loop. Planning also paid for itself in tokens: planned runs were *cheaper* per run than unplanned ones at both arms ($0.62 vs $0.74 at A0), because the executor spent less time exploring.

*Residual instrument note:* 2 of 36 reviewer verdicts were still `UNPARSEABLE` despite the salvage retry added after Finding 7 — a reminder that inter-agent contracts degrade rather than fail cleanly. Both affected runs passed on their own merits.

*Pilot 3 incident note:* the first L1:sonnet:FULL attempt exhausted the 16 GB host VM (12-worker vitest pool × CDK synth under a concurrent headless agent; no OOM-kill, full thrash). Reruns were memory-capped (worker pools + cgroup MemoryMax). The benchmark's own infrastructure OOM'ing the host is, fittingly, an operational-reality datum.

---

## Where harness value actually lives (the production contrast)

The platform I operate in production runs coding agents for up to four hours per task in isolated containers, across a fleet that has authored 1,000+ merged PRs (~98% merge rate) across ~13 repositories. Its telemetry over a recent window shows **28.8% of dev-class runs (106/368) hitting at least one deterministic guardrail block** — dirty-tree stops, force-push prevention, done-without-PR gates — each one a divergence prose rules had failed to prevent. The same platform needed schema-forced outputs after prose JSON kept breaking, payload offload after context silently dropped, and a render-before-merge gate after reviewer agents approved visually wrong UIs.

Same model family. Same harness patterns. Opposite ROI.

The variable that changed is **horizon**: minutes vs hours, one objective vs a task DAG, fresh checkout vs accumulated state, one agent vs a fleet with coordination surface. The pilots bound the harness-value curve from below; production telemetry bounds it from above. The interesting research question — and the one pilot 3 aims at — is where the knee is.

**Pilot 3 (results above)** found that onset: at hour-scale cross-cutting work, the harness flipped the small model from 1/3 to 3/3 while the frontier model still didn't need it. The remaining open question is where *sonnet's* knee is — plausibly at the multi-hour, multi-task, fleet-coordination scale the production platform operates at, which single-cell benchmarks may never reach economically.

## Threats to validity

- **Underpowered, and pilot 5 says so explicitly.** Pilots 1–4 ran n≤2 per cell. Pilot 5 ran n=3 across 6 tasks and still reached no p<0.05, because 4 tasks saturated at 100% (§ Finding 11). Every effect claimed here is a direction plus a mechanism, not an interval. The mechanisms (§ Findings 12–13) rest on diff-level autopsies, which is the strongest evidence in this study — stronger than its proportions.
- **One author wrote the tasks, the holdouts, and the harness.** Pre-registration and published raw journals mitigate; they don't eliminate.
- **Contamination:** both target repos were private during all graded runs and published afterward; task briefs are synthetic; model training cutoffs predate the repos' existence in public form.
- **Two repos, both mine, both TypeScript/vitest monorepos.** Cross-repo consistency (telos 34/36, auto-graph 31/36) is reassuring but not external validity.
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
node runner/run-pilot3.mjs   # pilot 3 (12 hour-scale runs, ~$24)
node runner/run-pilot4.mjs   # pilot 4 (24 planning-ablation runs, ~$30)
git clone https://github.com/tdrml/auto-graph .pristine-autograph   # second target (pilot 5)
node runner/run-pilot5.mjs   # pilot 5 (72 runs, two repos, ~$64)
```

Runners are sequential, resumable (JSONL journal is the source of truth), and kill-switched on summed API-equivalent cost.

## License

MIT — see [LICENSE](LICENSE). The `telos` target repo is separately MIT-licensed.
