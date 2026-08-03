# harness-bench

**A calibration study: where does agent-harness engineering actually pay off?**

Thomas Loth · July 2026 · [thomasloth.com](https://thomasloth.com) · MIT

---

## TL;DR

I run autonomous coding-agent fleets in production. Their harness — deterministic done-gates, schema-forced outputs, adversarial review loops, cost routing — visibly earns its keep there: **28.8% of recent dev-class runs (106 of 368) hit at least one deterministic guardrail block**, each a failure that prose instructions had been letting through on multi-hour runs.

So I tried to measure the same layers under controlled conditions: same model, same tasks, harness ablated arm by arm.

**Result: at the scale most coding benchmarks operate — single-session, minutes-long, well-scoped tasks against a well-tested repo — the harness added nothing.** 54 of 54 graded runs succeeded across every arm, both models, and all five task classes, including tasks designed so that only a held-out test suite could catch a wrong fix. Claude Haiku 4.5 with no harness at all matched Claude Sonnet 5 with the full harness, at ~40% of the cost. The harness's only measurable effect at this tier was ~2× cost.

The interesting conclusion is the tension between those two facts: **harness ROI is a function of horizon, not a constant.** Below some task-length/autonomy threshold, frontier models don't need the scaffolding. Production fleets operate far above that threshold, where the same scaffolding blocks failures continuously. Benchmarks that grade harnesses on short tasks are measuring the flat part of the curve.

**Pilot 7 moved to epic scale — eight dependent issues delivered one at a time into one accumulating repository — and produced the study's sharpest result.** The harness fixed the single issue where builds break, completely and significantly (9/9 vs 4/9), and **changed end-to-end success not at all: 4/9 epics both arms, identical at every tier.** A different failure mode, untouched by any harness layer, was enough to sink the sequence anyway. **At horizon, reliability is conjunctive** — eliminating your most visible failure mode buys nothing a user experiences while another remains. It also overturned this study's own earlier advice: the cheap-model-plus-scaffolding stack from findings 9–10 delivers **zero** clean epics at any price, while **bare Opus is the cheapest, fastest and most reliable configuration tested** ($26/epic, $39.56/success). § Pilot 7.

**Pilot 6 asked the question the study had been dodging: can a harness buy what a better model buys?** Sometimes, and it depends entirely on *how* the task fails. On a 34-site mechanical migration, both frontier tiers succeeded bare where the cheap model needed the harness — and **bare Opus was the cheapest path to a correct result of any configuration tested** ($2.43/success vs $3.55 for haiku+harness), because it needed a third of the turns. On a task whose failure mode is *omission*, **nothing worked: 0 of 18 runs across all three tiers and both arms, 17 of them silent.** § Pilot 6.

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

Pilots 3–4 ran n≤2 on three tasks in one repo. Pilot 5 is the replication: **6 new calibrated tasks across two repos** (telos and [auto-graph](https://github.com/tdrml/auto-graph), a 31K-LOC pipeline pinned at `494194d` — [corrected, § Finding 18](#18-a-published-size-figure-was-wrong-and-it-weakens-an-earlier-explanation)), a clean 2×2 of **planning × enforcement**, executor haiku throughout, **n=3** — 72 runs, $63.60 including all six plans ($0.84 total; haiku planned the whole corpus for under a dollar).

Tasks split evenly into two classes. **Breadth**: inject table names into 5 service constructors and migrate every site (tb1); convert `enqueue` to a params object across ~34 call sites (ab1); add a required `locations` field to `ContinuityState` and update every constructor of it (ab2). **Spec**: a `/cancel` webhook command with exact 202/200 responses (ts1); a lock-takeover grace period with exact `:now = epoch − grace` arithmetic (ts2); a strict word-count mode with adversarial tokenization vectors (as1).

| haiku executor | A0 | FULL |
|---|---|---|
| no plan | 16/18 (89%) | 17/18 (94%) |
| haiku-plan | 14/18 (78%) | **18/18 (100%)** |

**11. The honest statistics: nothing here reaches significance.** Two-sided Fisher exact: FULL vs A0 overall p=0.107; plan+FULL vs plan+A0 p=0.104; breadth-only FULL vs A0 p=0.088; plan vs no-plan at A0 p=0.658. Pilot 5 was designed to be the powered replication and **it is not**, for a reason worth publishing: **4 of the 6 tasks saturated at 100% in all four cells** (every spec-class task went 9/9 everywhere), so the effective sample is 2 tasks, not 6. My new spec-class tasks failed to reproduce the difficulty of pilot 4's spec task — the executor simply got them right, planned or not. Powering this design means task authoring that reliably lands in the 40–80% band, and that is harder than adding reps: task difficulty, not run-to-run variance, is the binding constraint on statistical power in agent benchmarks.

**12. Planning substitutes for exploration — which is why an incomplete plan is worse than none.** All 7 failures in the study were breadth-class, from 2 of 6 tasks. The most informative is `tb1:haiku-plan:A0`, which failed twice where the unplanned arm went 3/3. The autopsy: **both arms made the identical production change** — module-scope `const config = getConfig()` in 14 handlers, table names passed to constructors. The difference was the ripple. Moving the config read out of the (test-mocked) service class and into the handler module crosses the mock boundary, so 19 handler test files now execute the real `getConfig()` at import time and die on unset env. **The unplanned run discovered this by running the suite and fixed 20 test files. The planned run fixed 1.** The plan's consistency sweep had eleven checkboxes and looked exhaustive — but enumerated only the core package's test instantiations and never mentioned the handler tests. The executor treated the checklist as the definition of done. A plan is an authority claim about what completeness means; when it is wrong, it is wrong *confidently*, and it displaces the search that would have caught it.

**13. Enforcement is what makes planning safe.** The same task, same plan, with the harness: 3/3. The done-gate does not care what the plan enumerated — it re-runs the suite and blocks the stop, so the blind spot surfaces anyway. This is the first pilot where the deterministic gate visibly fired in production conditions: **6 of 36 FULL runs hit at least one block (14 blocks total), and 3 runs saturated the 3-block bound**; the reviewer returned REQUEST_CHANGES on 10 of 36 and every one of those triggered a revision round. The gate-block rate here (17% of harnessed runs) is the same order as the 28.8% measured on multi-hour production runs, from a clean-room reimplementation of the same idea. Cost of the reliable configuration: **$1.12 per success (plan+FULL) versus $0.83 per success for bare** — a 35% premium for the difference between 89% and 100%, with no frontier model anywhere in the loop. Planning also paid for itself in tokens: planned runs were *cheaper* per run than unplanned ones at both arms ($0.62 vs $0.74 at A0), because the executor spent less time exploring.

*Residual instrument note:* 2 of 36 reviewer verdicts were still `UNPARSEABLE` despite the salvage retry added after Finding 7 — a reminder that inter-agent contracts degrade rather than fail cleanly. Both affected runs passed on their own merits.

---

## Pilot 6 — model tier × enforcement

Pilots 4 and 5 used haiku as the executor for all 96 runs; the study's only tier comparison was pilot 3's n=1, and Opus had never written a line of code here. Pilot 6 fixes that: 2 tasks × {haiku, sonnet-5, opus-5} × {A0, FULL} × n=3 = 36 runs, $121.31, no planning arm.

**Getting to two tasks took four discards.** Every telos candidate saturated at the pilot-6 baseline (bare haiku, no plan): tb1 3/3, tb2 3/3, tb3 3/3. Only auto-graph tasks broke the cheap model. I originally attributed this to **codebase scale** — telos 20K LOC / 732 tests versus auto-graph "79K" / 1,122. **That 79K figure was wrong** (§ Finding 18); the comparable numbers are 20K versus 31K, so scale is a much weaker explanation than this section originally claimed and the difference may simply be task authoring. The grid ran on `ab1` (convert `enqueue` to a params object across ~34 call sites) and `ab3` (widen chapter-file zero-padding: 72 literal strings, four duplicated `padStart(2,'0')` sites, a filename regex). Pilot 6's tier result is therefore measured on one repo; that is a real limitation, not a footnote.

Reported as **strict** success — build ∧ visible suite ∧ holdout — for reasons in Finding 17.

| | `ab1` bare | `ab1` +harness | `ab3` bare | `ab3` +harness |
|---|---|---|---|---|
| haiku | 1/3 | 2/3 | 0/3 | 0/3 |
| sonnet | **3/3** | **3/3** | 0/3 | 0/3 |
| opus | **3/3** | **3/3** | 0/3 | 0/3 |

**14. On volume tasks, tier substitutes for harness — and the expensive model is *cheaper*.** Bare haiku got `ab1` right once in three; the harness took it to 2/3; both frontier tiers went 3/3 with no scaffolding at all. The cost table is the part worth pinning up:

| configuration | `ab1` strict | $/success |
|---|---|---|
| haiku bare | 1/3 | $6.20 |
| haiku + full harness | 2/3 | $3.55 |
| sonnet bare | 3/3 | $5.73 |
| **opus bare** | **3/3** | **$2.43** |

Opus was the cheapest *and* the most reliable, because capability shows up as **fewer turns**: median 350s versus haiku's 596s bare and 917s harnessed. Per-token price is not per-task price. This inverts the tempting reading of pilots 3–5 ("scaffold a cheap model") for this class of work: if the task is large and mechanical, buy the better model. Honest caveat: `ab1` is n=3 per cell, and frontier-vs-haiku bare on it is p=0.083 by Fisher — a clean direction, not a significant one.

**15. On omission tasks, nothing substitutes for anything.** `ab3` went **0/18**: every tier, both arms, every rep. **17 of the 18 were silent failures** — the agent finished, the build compiled, the repo's full 1,122-test suite passed, and only the held-out assertions knew. Opus bare failed it identically to haiku bare. This is the study's flattest result and its most useful one: *there is a failure class where model capability and enforcement are both irrelevant.*

**16. Diff review is structurally blind to omission — that's why nothing caught it.** Trace the layers on `ab3`. The compiler sees no error (each missed site still typechecks). The visible suite is green (the agent updated the nine test files to match its own incomplete change). The done-gate only runs tests, so it has nothing to block on. And the adversarial reviewer **approved** these diffs — including for sonnet and opus — because *a diff shows what changed, not what should have changed and didn't.* The three untouched prompt builders never appear in the diff, so there is nothing for a reviewer to react to. Every signal available to the agent and its harness is a presence-signal; the failure is an absence. The only artifact that caught it was an assertion written **before** the work, by someone who had already decided what completeness meant — which is the case for holdout suites, and in production for acceptance criteria fixed at planning time rather than inferred from the implementation.

**17. Two more instrument findings, both caught by plausibility rather than by the scoring boolean.** (a) `success` never included **build**: vitest transpiles per-file and does not typecheck, so an agent can leave `pnpm build` broken and still pass the suite *and* the holdout. Three of 84 runs across pilots 5–6 did exactly that, including one that the done-gate passed and the reviewer approved. The definition was pre-registered and shared with pilot 5, so it was **not** changed mid-grid; `buildGreen` is recorded on every run and strict success is computed retroactively for both pilots (pilot 5: 63/72 strict vs 65 loose). (b) One run came back at $0.16 / 75s / 6 turns with zero files changed — the bench credentials had expired mid-run, and the failure was scored as a *model* failure. It is marked `run-invalidated` in the journal (retained for audit, excluded from analysis) and was re-executed after refreshing auth. Neither problem is visible in a success/failure column; both were found by asking whether a number was *plausible*. A grading pipeline needs its own smoke alarms.

**18. A published size figure was wrong, and it weakens an earlier explanation.** While selecting the pilot-7 target I re-measured the repos and found the **"79K-LOC"** description of `auto-graph` counts generated `dist/*.d.ts` build artifacts as source. Hand-written TypeScript is **12,094 lines of production code + 19,325 lines of tests = 31,419**; all tracked files total 35,251. The `telos` figure ("20K LOC") is correct — 6,655 + 13,294 = 19,949 — which means **the two repos were measured by different methods and were never comparable.** The consequence is not cosmetic: Finding 14's section attributed pilot 6's difficulty pattern to codebase scale on a 20K-vs-79K gap that is actually 20K vs 31K. A 1.6× size difference is a thin explanation for the difference between "saturates at 3/3" and "fails at 0/3", so that attribution is downgraded to a conjecture and the sections above have been amended rather than silently edited. Nothing about the run data changes; only a claim I made *about* the data does. The lesson generalizes past this repo: **a number that never gets re-derived is a number nobody has checked**, and benchmark papers are full of repo-size and task-count figures that no reviewer can reproduce.

*Also noted:* all three `UNPARSEABLE` reviewer verdicts in pilot 6 came from **opus**, none from haiku or sonnet — the strongest model was the most likely to answer a JSON-contract request in prose.

*Pilot 3 incident note:* the first L1:sonnet:FULL attempt exhausted the 16 GB host VM (12-worker vitest pool × CDK synth under a concurrent headless agent; no OOM-kill, full thrash). Reruns were memory-capped (worker pools + cgroup MemoryMax). The benchmark's own infrastructure OOM'ing the host is, fittingly, an operational-reality datum.

---

## Pilot 7 — epic scale: eight dependent issues, one accumulating repository

Every pilot above ran a **single session against a pristine checkout**. The study's own
thesis is that harness ROI grows with horizon, and the production contrast it cites
comes from multi-hour, multi-issue, stateful work. That regime had never been tested.

**Design.** One epic — add a two-stage release phase to the `auto-graph` pipeline —
decomposed into **8 sequentially dependent issues**, delivered one issue per **fresh
headless session into the same accumulating working tree**, one git commit per issue.
The agent never sees the other issues, the epic plan, or its own earlier sessions:
conventions introduced by issue *N* must be **rediscovered from the repository** by
issue *N+k*. Grid: {haiku-4.5, sonnet-5, opus-5} × {A0, FULL} × n=3 = **18 epics, 144
graded issues, $501.29**. Pre-registered in [`PILOT7-PREREGISTRATION.md`](PILOT7-PREREGISTRATION.md),
with four append-only amendments recorded as they happened.

Two grading changes, both pre-registered: the done-gate now runs **`build && test`**,
not `test` alone (finding 17a), and each holdout is graded **twice — by vitest and by
the compiler**, since a missing `export type` from a barrel has no runtime footprint
and barrel omission is exactly the failure class this epic plants.

A **calibration gate** ran before any graded run: a full reference implementation of
all 8 issues, replayed commit by commit, requiring every holdout to be red on the
state before its issue and green after. It caught two defects that would have
invalidated the grid — see finding 22.

| cell | epic strict | integration holdout | median survival /8 | median wall | $/epic | $/strict epic |
|---|---|---|---|---|---|---|
| haiku:A0 | 0/3 | 1/3 | 4 | 71 min | $6.76 | – |
| haiku:FULL | 0/3 | 2/3 | 3 | 106 min | $11.16 | – |
| sonnet:A0 | 2/3 | 2/3 | 6 | 67 min | $31.98 | $47.98 |
| sonnet:FULL | 2/3 | 3/3 | 8 | 111 min | $52.04 | $78.06 |
| **opus:A0** | 2/3 | 3/3 | 8 | **53 min** | **$26.37** | **$39.56** |
| opus:FULL | 2/3 | 3/3 | 8 | 85 min | $38.78 | $58.17 |

`epicStrict` = build ∧ full suite ∧ *every* issue's holdout ∧ the end-to-end
integration holdout, all evaluated after the last issue. `survival` = consecutive
strict-green issues before the first failure.

---

**19. The harness eliminated one failure mode completely and bought nothing end-to-end.**
Epic success is **4/9 harnessed versus 4/9 bare — identical, at every tier** (Fisher
p=1.000 within each tier and pooled). But per issue position the arms are
indistinguishable *everywhere except one*:

| position | what it asks for | bare | harnessed | p (unadjusted) |
|---|---|---|---|---|
| i1–i6 | new modules, wiring, refactor | — | — | 1.000 each |
| **i7** | cross-cutting migration over existing debt | **4/9** | **9/9** | **0.029** |
| i8 | change established terminal behavior | 4/9 | 5/9 | 1.000 |

Issue 7 is where builds break, and the gate runs `build && test`, so it fixed issue 7
outright — and touched nothing else. Issue 8 then failed independently at the same
rate in both arms, which is sufficient to fail the whole epic. Hence identical epic
rates despite a real, large, mechanistically-explained per-issue effect.

> **At horizon, reliability is conjunctive.** Eliminating your most visible failure
> mode buys nothing end-to-end while a second one remains untouched. A harness
> evaluated on the failure it was designed to catch will look excellent and change
> nothing a user experiences.

This is the strongest practical argument in the study for measuring agent reliability
**per sequence, not per task**. Six of eight positions were already saturated; a
single-task benchmark drawing from those six would have concluded the harness does
nothing, and one drawing from i7 would have concluded it is transformative. Both would
be describing the same system.

**20. Honest statistics on that p=0.029: it does not survive correction.** It is the
first sub-0.05 value in seven pilots, which is precisely when to distrust oneself. All
**eight** positions were tested, not just the interesting one. Bonferroni for 8 tests
requires p<0.00625; Holm–Bonferroni stops at the first step. **0.029 survives neither.**
What separates it from noise-mining is that the mechanism was observed independently
and before the test: the gate's blocks fire at i7, the bare i7 failures *are* build
breaks, and **every one of 43 harnessed issues ended with a green build against 7 bare
breaks**. Reported as a direction with a confirmed mechanism; not as a finding.

**21. Tier buys capability; the gate buys repository integrity; neither substitutes for
the other.** Frontier tiers went 4/6 versus haiku's **0/6** (p=0.061 — the largest
effect measured here, and it also misses significance). Haiku produced no clean epic in
six attempts under either arm: **a perfect gate cannot make a model capable.** Bare
sonnet and opus each lost an epic to a *type-only* error the 1,122-test suite could not
see. And **bare opus is the cheapest, fastest, most reliable configuration tested** —
$26.37/epic, 53 minutes, $39.56 per success, roughly half the cost per success of
anything else.

That **contradicts this study's own earlier advice.** Findings 9–10 concluded the
cheapest reliable stack was haiku-plan → haiku → gates+reviewer, with no frontier model
in the loop. At single-task scale that held. **At epic scale it collapses**: the same
cheap-model stack delivers zero clean epics at any price. The horizon jump does not
merely amplify the harness's value — it changes which axis matters.

**22. Agents add reliably and modify unreliably.** Issues 1 and 2 (new module, new
work-item schema) failed **0 times in 15**. Issue 8 — which requires *removing* an
established terminal behavior (`final-review` marking a project `COMPLETE`) and
replacing it with a handoff — failed **8 of 14**, at every tier and in both arms. All
five own-work failures at i8 were the identical three assertions about entering the
release phase; **the documentation assertions in that same holdout passed every time**,
so this is genuine last-mile integration failure, not a stale-README artifact.

This also explains a harness failure mode worth naming: **an adversarial reviewer
prompted to *refute* a diff is structurally biased toward the status quo, which is
backwards on a behavior-removal issue.** On i8 the reviewer demanded that `final-review`
preserve `chapterCount` and `completedAt` — behavior the issue existed to delete —
citing an ambiguous clause in the brief. i8 own-work green was 7/9 bare versus 3/7
harnessed, but that is **p=0.302 and driven mostly by one tier**; published as an
observation with a legible cause, explicitly not as a result. *(An earlier draft of
this section stated it far more strongly from the haiku cell alone; the correction is
journaled in `results/pilot7.jsonl`.)*

**23. Cascade is real, and its measured depth is an artifact of where the break lands.**
Using the decisive test — an issue's build-error set being byte-identical to its
predecessor's — cascade appears 3 times in 18 epics, **always at depth 1**, because the
originating break is at i7 and only i8 follows it. The smoke epic, where the break
landed at i5, cascaded three deep. **These numbers understate cascade**; a pilot that
plants the cross-cutting migration early would measure the real distribution.

Cascade is also why this pilot records `holdoutAssertionsGreen` separately from
`strict`: `tsc --build` is per-package, so one unrepaired type error fails *every* later
holdout in that package regardless of that issue's own work. In the smoke epic bare
haiku scored 4/8 strict while passing **8/8** of its own assertions. Without that
split, "the agent left the repo broken once" reads as "the agent failed four issues."

**24. Four more instrument findings, all caught before or during the grid.**
(a) The **calibration gate** caught a *specification bug in my own brief*:
`clampToProjectType` was under-specified for a range lying entirely outside the target
band, and the reference implementation dutifully returned `{min: 8000, max: 5000}` — a
range whose minimum exceeds its maximum. Unfixed, **every cell of the grid would have
failed issue 7 for correct work**, and I would have published it as a finding about
model capability. It also caught a holdout that graded *phrasing* (requiring the digit
`7` to precede the word "keywords"). An author-written benchmark has two independent
failure modes — the spec can be wrong, and the grader can over-specify — and **a
reference implementation is the only instrument that separates them.**
(b) A `no-files-changed` plausibility alarm on an issue that spent $0.69 over 62 turns
was **the harness's bug, not the model's**: the agent had committed its own work, and
every metric was computed from `git diff HEAD`, which then reports nothing. That
silently zeroed the published diff artifact, the discipline metrics, and the tamper
check — and would have handed the adversarial reviewer an **empty diff**, reintroducing
finding 2 inside my own runner. Everything now diffs against a base SHA captured before
each issue runs. The grid was restarted from zero.
(c) `pnpm -s build` **fails with exit code 1 and prints nothing**; a grader keying on
output text rather than exit status would score every broken build as green.
(d) **Finding 2 recurred at a third scale.** Two of 15 early FULL issues ended with the
reviewer *dead* rather than dissenting (`is_error`, 26 turns against a 25-turn budget,
`stop_reason: tool_use`, no verdict emitted). The budget was **deliberately not raised
mid-grid** — the arms were pre-registered and `FULL` must mean one thing across all 18
epics. The consequence is stated rather than hidden: the arm comparison is
**conservative**, since roughly an eighth of early review stages silently did not run.

*Limitations specific to this pilot:* one epic, one repository, one author; n=3 per
cell; issue ordering is fixed, so order effects and issue difficulty are confounded by
construction; six of eight positions saturated, so the design's power rests on i7 and
i8 alone; and the pre-registered compounding bet (epic success ≈ *p*<sup>8</sup>) was
only half right — per-issue success ran 91–96% at frontier tiers, yet epic success was
44%, because failures concentrate at specific positions rather than distributing
independently.

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
- **Two repos, both mine, both TypeScript/vitest monorepos**, and closer in size than this README originally said (20K vs 31K lines of hand-written TypeScript, not 20K vs 79K — § Finding 18). Cross-repo consistency (telos 34/36, auto-graph 31/36) is reassuring but not external validity.
- **Pilot 7 runs one epic, on one repository, authored by one person**, at n=3 per cell. Six of its eight issue positions saturated, so its design rests on two positions; issue order is fixed, so order effects and issue difficulty are confounded by construction. Its one sub-0.05 value does not survive correction for the eight positions tested (§ Finding 20).
- **Pilot 6 runs on one repo only.** Every telos task authored for it saturated for bare haiku (3/3 three times), so the tier comparison is measured entirely on auto-graph. Its `ab1` cells are n=3, and its headline tier contrast is p=0.083 — a direction, not a result.
- **The production numbers are observational**, from one platform, and not independently auditable in this repo (the platform is company-owned). They motivate the horizon hypothesis; they don't prove it.
- The reviewer/harness implementations are minimal clean-room versions of the production patterns, not the production code.
- **The instrument has been wrong repeatedly, in every pilot that looked for it.** Findings 6, 17 and 24 document a false-failure rate around 50% in one pilot, a success definition that omitted the build, a credential expiry scored as a model failure, and a diff baseline that silently zeroed the published artifacts. Every one was caught by a plausibility check or an autopsy, never by the pass/fail column. Results here should be read as *the output of an instrument that is audited*, not one that is assumed correct.

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
node runner/run-pilot6.mjs   # pilot 6 (36 runs, tier x enforcement, ~$121)
node runner/calibrate-pilot7.mjs  # pilot 7 calibration gate (needs a reference impl)
node runner/run-pilot7.mjs   # pilot 7 (18 epics x 8 issues, ~$501)
node runner/analyze-pilot7.mjs    # pilot 7 tables + significance
```

Pilot 7 differs structurally: it runs **epics**, not tasks. Each epic is one persistent
working tree that eight fresh agent sessions modify in sequence, with a commit per
issue, per-issue scoring at each boundary, and a re-grade of every holdout after the
last issue. `runner/harness-pilot7.service` is the systemd unit used to run the grid
detached under a cgroup memory cap.

Runners are sequential, resumable (JSONL journal is the source of truth), and kill-switched on summed API-equivalent cost.

## License

MIT — see [LICENSE](LICENSE). The `telos` target repo is separately MIT-licensed.
