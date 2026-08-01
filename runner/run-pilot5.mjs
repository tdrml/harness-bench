#!/usr/bin/env node
/**
 * harness-bench pilot 5 – powered 2x2: planning x enforcement.
 *
 * 6 new calibrated tasks across TWO repos (telos + auto-graph):
 *   breadth-class: tb1 (service table-name injection), ab1 (enqueue signature
 *   migration, ~34 sites), ab2 (ContinuityState.locations end-to-end)
 *   spec-class:    ts1 (/cancel command), ts2 (lock takeover grace), as1
 *   (strict word count)
 * Cells: {no-plan, haiku-plan} x {A0, FULL}. Executor haiku. n=3.
 * 72 runs + 6 cached haiku plans. Concurrency 2 (memory caps make it safe).
 *
 * Design choices vs pilot 4: planner tier FIXED at haiku (pilot 4: tier didn't
 * matter; haiku-plan is the cheapest and boldest claim). Sonnet cells dropped
 * (9/9 across pilots 3-4 - settled). Second repo kills the one-repo threat.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG_DIR = join(ROOT, '.claude-bench-config');
const RESULTS = join(ROOT, 'results');
const PLANS = join(RESULTS, 'plans-v3');
const JOURNAL = join(RESULTS, 'pilot5.jsonl');

const REPOS = {
  telos: { pristine: join(ROOT, '.pristine-telos'), vitestArgs: ['--workspace', 'vitest.workspace.ts'] },
  autograph: { pristine: join(ROOT, '.pristine-autograph'), vitestArgs: [] },
};
const MODELS = { haiku: 'claude-haiku-4-5-20251001' };
const EXECUTOR = 'haiku';
const PLANNER = 'haiku';
const GLOBAL_CEILING_USD = 200.0;
const PRIOR_SPEND_USD = 69.21; // pilots 1-4
const PER_RUN_CAP_USD = 6.0;
const PRIMARY_TIMEOUT_S = 3600;
const MAX_TURNS = 200;
const CONCURRENCY = 2;
const REPS = 3;

const TASKS = [
  { id: 'tb1', repo: 'telos', cls: 'breadth' },
  { id: 'ts1', repo: 'telos', cls: 'spec' },
  { id: 'ts2', repo: 'telos', cls: 'spec' },
  { id: 'ab1', repo: 'autograph', cls: 'breadth' },
  { id: 'ab2', repo: 'autograph', cls: 'breadth' },
  { id: 'as1', repo: 'autograph', cls: 'spec' },
];
const CELLS = [
  { plan: null, arm: 'A0' },
  { plan: null, arm: 'FULL' },
  { plan: PLANNER, arm: 'A0' },
  { plan: PLANNER, arm: 'FULL' },
];

process.env.VITEST_MAX_THREADS = '4';
process.env.VITEST_MIN_THREADS = '1';
process.env.VITEST_MAX_FORKS = '4';
process.env.VITEST_MIN_FORKS = '1';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

mkdirSync(RESULTS, { recursive: true });
mkdirSync(PLANS, { recursive: true });

let globalCost = PRIOR_SPEND_USD;
const done = new Set();
if (existsSync(JOURNAL)) {
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    if (rec.event === 'run') {
      done.add(`${rec.task}:${rec.plan ?? 'none'}:${rec.arm}:${rec.rep}`);
      globalCost += rec.costUsd ?? 0;
    }
    if (rec.event === 'plan') globalCost += rec.costUsd ?? 0;
  }
}

const log = (m) => process.stdout.write(`[pilot5] ${new Date().toISOString()} ${m}\n`);
const journal = (rec) => appendFileSync(JOURNAL, `${JSON.stringify(rec)}\n`);
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function claudeSync(workdir, prompt, modelId, { maxTurns = MAX_TURNS, timeoutS = PRIMARY_TIMEOUT_S, resume = null } = {}) {
  const args = ['-p', prompt, '--model', modelId, '--output-format', 'json', '--dangerously-skip-permissions', '--max-turns', String(maxTurns)];
  if (resume) args.push('--resume', resume);
  const t0 = Date.now();
  const res = spawnSync('claude', args, {
    cwd: workdir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR },
    encoding: 'utf8',
    timeout: timeoutS * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* null */
  }
  const cost = parsed?.total_cost_usd ?? 0;
  globalCost += cost;
  return {
    ok: res.status === 0 && parsed && !parsed.is_error,
    timedOut: res.signal === 'SIGTERM',
    cost,
    turns: parsed?.num_turns ?? null,
    sessionId: parsed?.session_id ?? null,
    text: parsed?.result ?? res.stdout?.slice(0, 2000) ?? '',
    wallS: (Date.now() - t0) / 1000,
  };
}
// concurrency: run claude in a worker-friendly async wrapper (spawnSync blocks
// the loop, so use spawn via a promise for pooled runs)
import { spawn } from 'node:child_process';
function claude(workdir, prompt, modelId, opts = {}) {
  const { maxTurns = MAX_TURNS, timeoutS = PRIMARY_TIMEOUT_S, resume = null } = opts;
  const args = ['-p', prompt, '--model', modelId, '--output-format', 'json', '--dangerously-skip-permissions', '--max-turns', String(maxTurns)];
  if (resume) args.push('--resume', resume);
  const t0 = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn('claude', args, {
      cwd: workdir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR },
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutS * 1000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* null */
      }
      const cost = parsed?.total_cost_usd ?? 0;
      globalCost += cost;
      resolvePromise({
        ok: code === 0 && parsed && !parsed.is_error,
        timedOut,
        cost,
        turns: parsed?.num_turns ?? null,
        sessionId: parsed?.session_id ?? null,
        text: parsed?.result ?? out.slice(0, 2000) ?? '',
        wallS: (Date.now() - t0) / 1000,
      });
    });
  });
}

function checkCeiling(context) {
  if (globalCost > GLOBAL_CEILING_USD) {
    journal({ event: 'abort', reason: 'global cost ceiling', context, globalCost });
    log(`ABORT: ceiling ($${globalCost.toFixed(2)}) at ${context}`);
    process.exit(3);
  }
}

function extractJson(text) {
  if (!text) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = tryParse(fence[1].trim());
    if (f) return f;
  }
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return tryParse(text.slice(start, i + 1));
      }
    }
  }
  return null;
}

async function extractJsonWithSalvage(workdir, rawText, schemaDesc, modelId, rec, role) {
  const obj = extractJson(rawText);
  if (obj) return obj;
  const salvage = await claude(workdir, `Convert the following into ONLY a valid JSON object matching ${schemaDesc} - no other text, no code fences:\n\n${(rawText || '').slice(0, 4000)}`, modelId, { maxTurns: 1, timeoutS: 120 });
  rec.costUsd += salvage.cost;
  rec.invocations.push({ role: `${role}-salvage`, cost: salvage.cost });
  return extractJson(salvage.text);
}

// --- planner (sequential, before the pool starts) ---------------------------
function getPlanSync(task) {
  const planFile = join(PLANS, `${task.id}-${PLANNER}.md`);
  if (existsSync(planFile)) return readFileSync(planFile, 'utf8');
  log(`planning ${task.id} with ${PLANNER}`);
  const workdir = join(ROOT, 'runs', `plan-${task.id}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  execFileSync('cp', ['-a', `${REPOS[task.repo].pristine}/.`, workdir]);
  const brief = readFileSync(join(ROOT, 'tasks-v3', task.id, 'brief.md'), 'utf8');
  const prompt = `You are the tech lead for this TypeScript monorepo (current directory). A junior engineer will implement the feature below in a single session. Your job is to write the implementation plan that makes their success inevitable. Read whatever repository code you need first.

--- FEATURE BRIEF ---
${brief}

Write the plan as markdown with exactly these sections:
1. **Spec-critical details** - every exact value the brief pins down (status codes, names, counts, defaults, error types, precedence orders), each on its own line. Missing one of these is how implementations fail.
2. **Ordered steps** - file-by-file: which file, what changes, following which existing pattern in this repo (name the pattern file).
3. **Consistency sweep** - every caller/test/count-assertion the change ripples into, as a checklist.
4. **Acceptance checklist** - how the engineer verifies each requirement before declaring done (commands included).

Do NOT write the implementation code itself. Plan only. Your final message must be ONLY the plan markdown.`;
  const r = claudeSync(workdir, prompt, MODELS[PLANNER], { maxTurns: 60, timeoutS: 1800 });
  rmSync(workdir, { recursive: true, force: true });
  if (!r.ok || !r.text || r.text.length < 400) {
    journal({ event: 'plan', task: task.id, planner: PLANNER, costUsd: r.cost, ok: false });
    throw new Error(`planner failed for ${task.id}`);
  }
  writeFileSync(planFile, r.text);
  journal({ event: 'plan', task: task.id, planner: PLANNER, costUsd: r.cost, turns: r.turns, wallS: Math.round(r.wallS), chars: r.text.length });
  checkCeiling(`after plan ${task.id}`);
  return r.text;
}

function setupWorkdir(task, cell, rep) {
  const workdir = join(ROOT, 'runs', `${task.id}-${cell.plan ?? 'none'}-${cell.arm}-r${rep}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  execFileSync('cp', ['-a', `${REPOS[task.repo].pristine}/.`, workdir]);
  if (cell.arm !== 'A0') {
    mkdirSync(join(workdir, '.claude', 'hooks'), { recursive: true });
    cpSync(join(ROOT, 'arms', 'settings-gate.json'), join(workdir, '.claude', 'settings.json'));
    cpSync(join(ROOT, 'arms', 'stop-gate.sh'), join(workdir, '.claude', 'hooks', 'stop-gate.sh'));
    execFileSync('chmod', ['+x', join(workdir, '.claude', 'hooks', 'stop-gate.sh')]);
  }
  return workdir;
}

function buildPrompt(task, cell) {
  let p = readFileSync(join(ROOT, 'tasks-v3', task.id, 'brief.md'), 'utf8');
  if (cell.plan) {
    const plan = readFileSync(join(PLANS, `${task.id}-${PLANNER}.md`), 'utf8');
    p += `\n\n## Implementation plan from your tech lead\n\nFollow this plan; it encodes the spec-critical details and the consistency sweep. If the plan and the brief ever disagree, the brief wins.\n\n${plan}`;
  }
  if (cell.arm === 'FULL') {
    p += `\n\nYour FINAL message must be ONLY a raw JSON object (no code fences, no prose), matching:\n{"summary": string, "filesChanged": string[], "testsGreen": boolean}`;
  }
  return p;
}

async function review(workdir, task, modelId, rec) {
  const brief = readFileSync(join(ROOT, 'tasks-v3', task.id, 'brief.md'), 'utf8');
  const diff = sh('git diff HEAD', { cwd: workdir, maxBuffer: 16 * 1024 * 1024 }).slice(0, 100000);
  const status = sh('git status --porcelain', { cwd: workdir }).slice(0, 2000);
  const prompt = `You are an adversarial code reviewer for an autonomous coding agent's work. Attempt to REFUTE that this change correctly and fully accomplishes the task. Look specifically for: missed sub-requirements (exact status codes, names, defaults), weakened existing assertions, incomplete wiring or caller migration across layers, and unrelated or excessive changes. You may read repository files to check the diff's claims.

--- TASK ---
${brief}

--- CANDIDATE DIFF ---
${diff || '(empty diff - the agent changed nothing)'}

--- UNTRACKED/STATUS ---
${status || '(clean)'}

Your FINAL message must be ONLY a raw JSON object on one line - no code fences, no other text:
{"verdict": "APPROVE" | "REQUEST_CHANGES", "issues": string[]}`;
  const r = await claude(workdir, prompt, modelId, { maxTurns: 25, timeoutS: 900 });
  rec.costUsd += r.cost;
  rec.invocations.push({ role: 'reviewer', cost: r.cost, wallS: Math.round(r.wallS) });
  rec.rawReview = (r.text || '').slice(0, 3000);
  const verdict = await extractJsonWithSalvage(workdir, r.ok ? r.text : '', '{"verdict": "APPROVE"|"REQUEST_CHANGES", "issues": string[]}', modelId, rec, 'reviewer');
  return { sessionRef: r, verdict };
}

function score(workdir, task, rec) {
  const build = spawnSync('pnpm', ['-s', 'build'], { cwd: workdir, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  rec.buildGreen = build.status === 0;

  const suite = spawnSync('pnpm', ['-s', 'test'], { cwd: workdir, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  const visibleGreen = suite.status === 0;

  const changed = sh('git diff --name-only HEAD', { cwd: workdir }).split('\n').filter(Boolean);
  const untracked = sh('git ls-files --others --exclude-standard', { cwd: workdir }).split('\n').filter(Boolean);
  const isTest = (f) => /__tests__\/|\.test\.ts$/.test(f);
  const testEdits = [...changed.filter(isTest), ...untracked.filter(isTest)];

  const taskDir = join(ROOT, 'tasks-v3', task.id);
  const map = JSON.parse(readFileSync(join(taskDir, 'holdout.json'), 'utf8'));
  const dests = [];
  for (const [file, destDir] of Object.entries(map)) {
    const d = join(workdir, destDir, `zz-${file}`);
    cpSync(join(taskDir, file), d);
    dests.push(d);
  }
  const hold = spawnSync('pnpm', ['-s', 'vitest', ...REPOS[task.repo].vitestArgs, 'run', 'zz-holdout'], {
    cwd: workdir,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const d of dests) rmSync(d, { force: true });
  const holdoutPass = hold.status === 0;
  const holdoutTail = (hold.stdout || '').split('\n').filter((l) => /×|Tests |Test Files/.test(l)).slice(-10);

  let blocks = 0;
  const cnt = join(workdir, '.claude', 'gate-blocks.count');
  if (existsSync(cnt)) blocks = Number(readFileSync(cnt, 'utf8').trim()) || 0;

  return {
    visibleGreen,
    holdoutPass,
    holdoutTail,
    testEdits,
    success: visibleGreen && holdoutPass,
    silentFailure: visibleGreen && !holdoutPass,
    blocks,
    changedFiles: changed,
    diffstat: sh('git diff --shortstat HEAD', { cwd: workdir }).trim(),
  };
}

async function runOne(task, cell, rep) {
  const key = `${task.id}:${cell.plan ?? 'none'}:${cell.arm}:${rep}`;
  if (done.has(key)) {
    log(`skip ${key}`);
    return;
  }
  checkCeiling(`before ${key}`);
  log(`=== RUN ${key} ($${globalCost.toFixed(2)} cumulative) ===`);
  const t0 = Date.now();
  const modelId = MODELS[EXECUTOR];
  const workdir = setupWorkdir(task, cell, rep);
  const rec = { event: 'run', task: task.id, repo: task.repo, cls: task.cls, executor: EXECUTOR, plan: cell.plan, arm: cell.arm, rep, costUsd: 0, invocations: [] };

  try {
    const primary = await claude(workdir, buildPrompt(task, cell), modelId);
    rec.costUsd += primary.cost;
    rec.invocations.push({ role: 'primary', cost: primary.cost, turns: primary.turns, wallS: Math.round(primary.wallS), timedOut: primary.timedOut });
    checkCeiling(`after primary ${key}`);
    if (rec.costUsd > PER_RUN_CAP_USD) rec.perRunCapExceeded = true;

    if (cell.arm === 'FULL') {
      rec.contract = await extractJsonWithSalvage(workdir, primary.text, '{"summary": string, "filesChanged": string[], "testsGreen": boolean}', modelId, rec, 'contract');
      const rev = await review(workdir, task, modelId, rec);
      rec.reviewVerdict = rev.verdict?.verdict ?? 'UNPARSEABLE';
      rec.reviewIssues = rev.verdict?.issues ?? [];
      checkCeiling(`after review ${key}`);
      if (rec.reviewVerdict === 'REQUEST_CHANGES' && primary.sessionId) {
        const fb = `An adversarial reviewer examined your change and requests changes:\n${(rec.reviewIssues.length ? rec.reviewIssues : ['(reconsider for missed sub-requirements and incomplete migration)']).map((i) => `- ${i}`).join('\n')}\nAddress each point and keep the full suite green (pnpm -s build && pnpm -s test).`;
        const revision = await claude(workdir, fb, modelId, { resume: primary.sessionId, maxTurns: 80, timeoutS: 1800 });
        rec.costUsd += revision.cost;
        rec.invocations.push({ role: 'revision', cost: revision.cost, turns: revision.turns, wallS: Math.round(revision.wallS) });
        rec.revised = true;
      }
    }

    Object.assign(rec, score(workdir, task, rec));
    writeFileSync(join(RESULTS, `p5-${key.replace(/:/g, '-')}.diff`), sh('git diff HEAD', { cwd: workdir, maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    rec.error = String(err).slice(0, 500);
  } finally {
    rec.wallSecTotal = Math.round((Date.now() - t0) / 1000);
    rec.globalCostAfter = Number(globalCost.toFixed(4));
    journal(rec);
    rmSync(workdir, { recursive: true, force: true });
    log(`${key}: success=${rec.success} visible=${rec.visibleGreen} holdout=${rec.holdoutPass} blocks=${rec.blocks} review=${rec.reviewVerdict ?? '-'} $${rec.costUsd?.toFixed(2)} ${rec.wallSecTotal}s`);
  }
}

// --- main: pre-generate plans, then pooled grid -----------------------------
const grid = [];
for (const task of TASKS) for (const cell of CELLS) for (let rep = 1; rep <= REPS; rep++) grid.push([task, cell, rep]);
const selected = only ? grid.filter(([t, c, r]) => `${t.id}:${c.plan ?? 'none'}:${c.arm}:${r}` === only) : grid;
log(`pilot5 start: ${selected.length} runs, concurrency ${CONCURRENCY}, ceiling $${GLOBAL_CEILING_USD} (incl. $${PRIOR_SPEND_USD} prior), resume-skip ${done.size}`);
for (const task of TASKS) {
  if (selected.some(([t, c]) => t.id === task.id && c.plan)) getPlanSync(task);
}
let idx = 0;
async function workerLoop() {
  while (idx < selected.length) {
    const [task, cell, rep] = selected[idx++];
    await runOne(task, cell, rep);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
journal({ event: 'summary', globalCost: Number(globalCost.toFixed(4)), runs: selected.length });
log(`pilot5 complete. cumulative $${globalCost.toFixed(2)}. journal: ${JOURNAL}`);
