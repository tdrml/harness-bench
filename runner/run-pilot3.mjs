#!/usr/bin/env node
/**
 * harness-bench pilot 3 – hour-scale feature builds, hunting the separation onset.
 *
 * 3 cross-cutting tasks (L1 new-worker-mode, L2 queue abstraction, L3 webhook
 * expansion) x {sonnet, haiku} x {A0, FULL} = 12 runs.
 *
 * vs pilot 2: tasks may legitimately edit tests (count assertions), so tamper
 * is RECORDED but not failed; holdouts are per-package files; bigger budgets.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PRISTINE = join(ROOT, '.pristine-telos');
const CONFIG_DIR = join(ROOT, '.claude-bench-config');
const RESULTS = join(ROOT, 'results');
const JOURNAL = join(RESULTS, 'pilot3.jsonl');
const PINNED_SHA = 'c62bcf6420c24c7e43c078d72aade6afcf25a765';

const MODELS = { sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' };
const GLOBAL_CEILING_USD = 200.0; // shared pilot-phase ceiling (approved 2026-07-31)
const PRIOR_SPEND_USD = 14.92; // pilots 1+2, counted against the same ceiling
const PER_RUN_CAP_USD = 10.0;
const PRIMARY_TIMEOUT_S = 3600;
const MAX_TURNS = 200;

const TASKS = ['L1', 'L2', 'L3'];
const CELLS = [
  ['sonnet', 'A0'],
  ['sonnet', 'FULL'],
  ['haiku', 'A0'],
  ['haiku', 'FULL'],
];
// dest dir per holdout filename suffix
const HOLDOUT_DEST = {
  'holdout.core.test.ts': 'packages/core/__tests__',
  'holdout.worker.test.ts': 'packages/worker/__tests__',
  'holdout.cdk.test.ts': 'packages/cdk/__tests__',
  'holdout.lambdas.test.ts': 'packages/lambdas/__tests__',
};

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

mkdirSync(RESULTS, { recursive: true });

let globalCost = PRIOR_SPEND_USD;
const done = new Set();
if (existsSync(JOURNAL)) {
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    if (rec.event === 'run') {
      done.add(`${rec.task}:${rec.model}:${rec.arm}`);
      globalCost += rec.costUsd ?? 0;
    }
  }
}

const log = (m) => process.stdout.write(`[pilot3] ${new Date().toISOString()} ${m}\n`);
const journal = (rec) => appendFileSync(JOURNAL, `${JSON.stringify(rec)}\n`);
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function claude(workdir, prompt, modelId, { maxTurns = MAX_TURNS, timeoutS = PRIMARY_TIMEOUT_S, resume = null } = {}) {
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

function checkCeiling(context) {
  if (globalCost > GLOBAL_CEILING_USD) {
    journal({ event: 'abort', reason: 'global cost ceiling', context, globalCost });
    log(`ABORT: ceiling ($${globalCost.toFixed(2)} > $${GLOBAL_CEILING_USD}) at ${context}`);
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

function setupWorkdir(task, model, arm) {
  const workdir = join(ROOT, 'runs', `${task}-${model}-${arm}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  execFileSync('cp', ['-a', `${PRISTINE}/.`, workdir]);
  if (arm !== 'A0') {
    mkdirSync(join(workdir, '.claude', 'hooks'), { recursive: true });
    cpSync(join(ROOT, 'arms', 'settings-gate.json'), join(workdir, '.claude', 'settings.json'));
    cpSync(join(ROOT, 'arms', 'stop-gate.sh'), join(workdir, '.claude', 'hooks', 'stop-gate.sh'));
    execFileSync('chmod', ['+x', join(workdir, '.claude', 'hooks', 'stop-gate.sh')]);
  }
  return workdir;
}

function buildPrompt(task, arm) {
  let p = readFileSync(join(ROOT, 'tasks-v2', task, 'brief.md'), 'utf8');
  if (arm === 'FULL') {
    p += `\nYour FINAL message must be ONLY a raw JSON object (no code fences, no prose), matching:\n{"summary": string, "filesChanged": string[], "testsGreen": boolean}`;
  }
  return p;
}

function review(workdir, task, modelId) {
  const brief = readFileSync(join(ROOT, 'tasks-v2', task, 'brief.md'), 'utf8');
  const diff = sh('git diff HEAD', { cwd: workdir, maxBuffer: 16 * 1024 * 1024 }).slice(0, 100000);
  const status = sh('git status --porcelain', { cwd: workdir }).slice(0, 2000);
  const prompt = `You are an adversarial code reviewer for an autonomous coding agent's work. Attempt to REFUTE that this change correctly and fully accomplishes the task. Look specifically for: missed sub-requirements, weakened existing assertions, incomplete wiring across layers, missed edge cases, and unrelated or excessive changes. You may read repository files to check the diff's claims.

--- TASK ---
${brief}

--- CANDIDATE DIFF ---
${diff || '(empty diff - the agent changed nothing)'}

--- UNTRACKED/STATUS ---
${status || '(clean)'}

Your FINAL message must be ONLY a raw JSON object on one line - no code fences, no other text:
{"verdict": "APPROVE" | "REQUEST_CHANGES", "issues": string[]}`;
  const r = claude(workdir, prompt, modelId, { maxTurns: 25, timeoutS: 900 });
  const verdict = r.ok ? extractJson(r.text) : null;
  return { ...r, verdict };
}

function score(workdir, task) {
  const suite = spawnSync('pnpm', ['-s', 'test'], { cwd: workdir, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  const visibleGreen = suite.status === 0;

  const changed = sh('git diff --name-only HEAD', { cwd: workdir }).split('\n').filter(Boolean);
  const untracked = sh('git ls-files --others --exclude-standard', { cwd: workdir }).split('\n').filter(Boolean);
  const isTest = (f) => /__tests__\/|\.test\.ts$/.test(f);
  const testEdits = [...changed.filter(isTest), ...untracked.filter(isTest)];

  const dests = [];
  const taskDir = join(ROOT, 'tasks-v2', task);
  for (const f of readdirSync(taskDir)) {
    const destDir = HOLDOUT_DEST[f];
    if (!destDir) continue;
    const d = join(workdir, destDir, `zz-${f}`);
    cpSync(join(taskDir, f), d);
    dests.push(d);
  }
  const hold = spawnSync('pnpm', ['-s', 'vitest', '--workspace', 'vitest.workspace.ts', 'run', 'zz-holdout'], {
    cwd: workdir,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const d of dests) rmSync(d, { force: true });
  const holdoutPass = hold.status === 0;
  const holdoutTail = (hold.stdout || '').split('\n').filter((l) => /×|Tests |Test Files/.test(l)).slice(-12);

  let blocks = 0;
  const cnt = join(workdir, '.claude', 'gate-blocks.count');
  if (existsSync(cnt)) blocks = Number(readFileSync(cnt, 'utf8').trim()) || 0;

  // longform tasks legitimately edit tests: record, don't fail
  const success = visibleGreen && holdoutPass;
  const silentFailure = visibleGreen && !holdoutPass;

  return {
    visibleGreen,
    holdoutPass,
    holdoutTail,
    testEdits,
    success,
    silentFailure,
    blocks,
    changedFiles: changed,
    untrackedFiles: untracked,
    diffstat: sh('git diff --shortstat HEAD', { cwd: workdir }).trim(),
  };
}

function runOne(task, model, arm) {
  const key = `${task}:${model}:${arm}`;
  if (done.has(key)) {
    log(`skip ${key}`);
    return;
  }
  checkCeiling(`before ${key}`);
  log(`=== RUN ${key} ($${globalCost.toFixed(2)} spent incl. prior pilots) ===`);
  const t0 = Date.now();
  const modelId = MODELS[model];
  const workdir = setupWorkdir(task, model, arm);
  const rec = { event: 'run', task, cls: 'longform', model, arm, modelId, pinnedSha: PINNED_SHA, costUsd: 0, invocations: [] };

  try {
    const primary = claude(workdir, buildPrompt(task, arm), modelId);
    rec.costUsd += primary.cost;
    rec.invocations.push({ role: 'primary', cost: primary.cost, turns: primary.turns, wallS: Math.round(primary.wallS), timedOut: primary.timedOut });
    checkCeiling(`after primary ${key}`);
    if (rec.costUsd > PER_RUN_CAP_USD) rec.perRunCapExceeded = true;

    if (arm === 'FULL') {
      rec.contract = (() => {
        const c = extractJson(primary.text);
        return c && typeof c.summary === 'string' ? c : null;
      })();
      const rev = review(workdir, task, modelId);
      rec.costUsd += rev.cost;
      rec.invocations.push({ role: 'reviewer', cost: rev.cost, wallS: Math.round(rev.wallS) });
      rec.rawReview = (rev.text || '').slice(0, 3000);
      rec.reviewVerdict = rev.verdict?.verdict ?? 'UNPARSEABLE';
      rec.reviewIssues = rev.verdict?.issues ?? [];
      checkCeiling(`after review ${key}`);
      if (rec.reviewVerdict === 'REQUEST_CHANGES' && primary.sessionId) {
        const fb = `An adversarial reviewer examined your change and requests changes:\n${(rec.reviewIssues.length ? rec.reviewIssues : ['(reconsider for missed sub-requirements and edge cases)']).map((i) => `- ${i}`).join('\n')}\nAddress each point and keep the full suite green (pnpm -s test).`;
        const revision = claude(workdir, fb, modelId, { resume: primary.sessionId, maxTurns: 80, timeoutS: 1800 });
        rec.costUsd += revision.cost;
        rec.invocations.push({ role: 'revision', cost: revision.cost, turns: revision.turns, wallS: Math.round(revision.wallS) });
        rec.revised = true;
      }
    }

    Object.assign(rec, score(workdir, task));
    writeFileSync(join(RESULTS, `p3-${task}-${model}-${arm}.diff`), sh('git diff HEAD', { cwd: workdir, maxBuffer: 32 * 1024 * 1024 }));
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

const grid = [];
for (const task of TASKS) for (const [model, arm] of CELLS) grid.push([task, model, arm]);
const selected = only ? grid.filter(([t, m, a]) => `${t}:${m}:${a}` === only) : grid;
log(`pilot3 start: ${selected.length} runs, ceiling $${GLOBAL_CEILING_USD} (incl. $${PRIOR_SPEND_USD} prior), resume-skip ${done.size}`);
for (const [task, model, arm] of selected) runOne(task, model, arm);
journal({ event: 'summary', globalCost: Number(globalCost.toFixed(4)), runs: selected.length });
log(`pilot3 complete. cumulative $${globalCost.toFixed(2)}. journal: ${JOURNAL}`);
