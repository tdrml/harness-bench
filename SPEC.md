# harness-bench – design spec (v1, 2026-07-31)

**Thesis:** on a fixed model and fixed task set, *harness design* – deterministic gates, schema-forced output, review loops, cost routing – moves agentic-delivery outcomes materially. Ablate the harness layer by layer and quantify each layer's contribution.

**Why this and not another SWE-bench entry:** SWE-bench Verified is saturated (~94%); UTBoost showed ~20% of leaderboard "solved" cases are semantically wrong; a 2026 position paper argues coding benchmarks are misaligned with agentic SE. Nobody is publishing controlled *harness* ablations. This is also exactly the sentence in the Anthropic Agents JD ("novel harness design, improved agent affordances"), and it converts the production 28.8%-hook-block observation into a controlled result.

**Headline artifact:** "Same model, same tasks: harness layers moved completion from A%→B% and cut silent failures C%→D% at E% of the cost." Public repo + paper-style README; optional arXiv cs.SE preprint after results.

---

## Boundary (hard constraint)

**Personal-side only.** Targets are personal repos (`telos`, `auto-graph`); the runner is a fresh, minimal, clean-room script (~a few hundred LOC TS, part of the published repo); harness features under test are generic public patterns (Claude Code hooks, JSON-schema outputs, model routing) implemented from scratch for the benchmark. **No Phoenix code, prompts, infra, accounts, or telemetry.** Runs on personal AWS/Anthropic credentials.

## System under test

Two target repos for a generalization claim, both owned and public(-bound):

- **`telos`** – 20K LOC TS, 732-test suite. Primary target.
- **`auto-graph`** – 79K LOC TS, 1,122 tests. Secondary (subset of tasks) to show effects transfer.

## Task set (~50)

| Class | Source | Ground truth |
|---|---|---|
| Bug-fix (~20) | **Mutation injection**: revert/perturb HEAD logic so N existing tests fail; task = "these tests fail, fix" | Injected-known fix; full suite green |
| Feature (~15) | Reverse-engineered from real merged PR history: reconstruct the issue brief from the pre-state | Held-out acceptance tests derived from the real PR's tests |
| Refactor (~8) | "Extract/consolidate X, behavior-preserving" briefs | Full suite green + no public-API diff |
| Test-writing (~4) | "Cover module Y's untested branches" | Coverage delta + mutation-kill check |
| Docs-sync (~3) | Seeded doc/code drift (the real `infra/` → `packages/cdk/` class of bug) | String-level assertions |

Size-tagged (S/M/L). **Held-out verification tests are never in the agent's context** – they exist on a branch the runner checks out only at scoring time.

## Arms (cumulative ladder, fixed model + prompts otherwise)

- **A0 baseline** – plain prompt, agent self-reports done.
- **A1 + done-gate** – deterministic Stop hook: clean tree, branch pushed, suite ran, lint green.
- **A2 + schema output** – result contract (files touched, tests run, claims) schema-forced, one salvage retry.
- **A3 + review loop** – second-agent adversarial review, one revision round.
- **A4 + risk routing** – task-class-keyed model/effort routing under a per-task $ ceiling (this arm trades the fixed-model constraint for the cost-quality frontier measurement; report separately).
- **FULL** – A1+A2+A3 (A4 reported as its own frontier curve).

Model pinned (single Claude version + date recorded); N=3 runs per task×arm; task order randomized per run.

## Metrics (per arm, medians + bootstrap CIs)

1. **Completion** – acceptance green.
2. **Silent-failure rate** – acceptance green but held-out verification red. *The headline metric.*
3. Rework – revision rounds / re-pushes needed.
4. Guardrail-block incidence – hook fired = a failure prose would have shipped (ties to the production 28.8% figure).
5. Cost – tokens + $ per completed task; wall-clock.
6. Discipline proxies – diff size vs reference, files touched outside declared footprint.

## Runner

Minimal TS script, no platform: per-arm Claude Code CLI headless invocations in a throwaway Docker checkout, per-arm `settings.json`/hooks dir, results to JSONL, one analysis notebook renders the tables/plots. Resumable (JSONL is the journal). Published in the repo.

## Cost & schedule

50 tasks × 5 arms × 3 runs ≈ 750 runs (+A4 subset). At capped $0.50–2.50/run → **~$500–1,500 ceiling; hard per-run cap $3, global kill-switch at $1,500.**
~1 week part-time: D1–2 task extraction + runner, D3–4 grid, D5 analysis + writeup.

## Validity guards

- **Pre-registration:** metrics + arms committed to the public repo *before* the full grid runs (kills the "benchmarked his own harness into winning" critique).
- Publish every run, including failures; scrubbed logs.
- Contamination note: repos were private until 2026-07-31; task briefs are synthetic reconstructions; model cutoff recorded.
- Pilot calibration gate below before any real spend.

## Phase 0 – pilot (approval gate)

5 tasks × 3 arms (A0/A1/FULL) × 1 run ≈ estimated $10–30, **hard pilot ceiling $50** (runner-enforced kill-switch on summed API-equivalent cost; approved 2026-07-31). Validates: task difficulty spread (not all-pass/all-fail), runner mechanics, scoring, per-run cost model. **Full grid only runs after pilot review.**

## Deliverables

1. Public repo `tdrml/harness-bench` – runner, tasks, raw results, paper-style README.
2. Results section reusable verbatim in applications/interviews.
3. Optional: arXiv cs.SE preprint (needs endorser); Terminal-Bench task donations from the task set.
