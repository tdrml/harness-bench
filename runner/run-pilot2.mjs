#!/usr/bin/env node
/**
 * harness-bench pilot 2 – recalibration grid.
 *
 * 8 tasks (1 discovery, 2 compound, 3 behavior-report, 2 feature)
 *  x sonnet-5 {A0, A1, FULL} + haiku-4.5 {A0, FULL}  = 40 runs.
 *
 * v1.1 runner changes vs run-pilot.mjs:
 *  - model axis; briefs read from tasks-v2/<id>/brief.md
 *  - per-task holdout files layered on the shared v1 holdout
 *  - tamper check includes ADDED (untracked) test files
 *  - reviewer verdict: robust parse (direct → fence → brace) + raw text journaled
 *  - ceiling $200 (approved 2026-07-31), per-run cap $6
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PRISTINE = join(ROOT, '.pristine-telos');
const CONFIG_DIR = join(ROOT, '.claude-bench-config');
const RESULTS = join(ROOT, 'results');
const JOURNAL = join(RESULTS, 'pilot2.jsonl');
const PINNED_SHA = 'c62bcf6420c24c7e43c078d72aade6afcf25a765';

const MODELS = { sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' };
const GLOBAL_CEILING_USD = 200.0; // raised from $50, approved 2026-07-31
const PER_RUN_CAP_USD = 6.0;
const PRIMARY_TIMEOUT_S = 1500;
const MAX_TURNS = 80;

const TASKS = [
  { id: 'd2', cls: 'discovery', mutation: true },
  { id: 'c1', cls: 'compound', mutation: true },
  { id: 'c2', cls: 'compound', mutation: true },
  { id: 'b1', cls: 'report', mutation: true },
  { id: 'b2', cls: 'report', mutation: true },
  { id: 'b3', cls: 'report', mutation: true },
  { id: 'f1', cls: 'feature', mutation: false },
  { id: 'f2', cls: 'feature', mutation: false },
];
const CELLS = [
  ['sonnet', 'A0'],
  ['sonnet', 'A1'],
  ['sonnet', 'FULL'],
  ['haiku', 'A0'],
  ['haiku', 'FULL'],
];

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

mkdirSync(RESULTS, { recursive: true });

let globalCost = 0;
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

const log = (m) => process.stdout.write(`[pilot2] ${new Date().toISOString()} ${m}\n`);
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

// robust JSON extraction: direct → fenced → first-balanced-brace
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
  const workdir = join(ROOT, 'runs', `${task.id}-${model}-${arm}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  execFileSync('cp', ['-a', `${PRISTINE}/.`, workdir]);
  if (task.mutation) {
    execFileSync('git', ['apply', join(ROOT, 'tasks-v2', task.id, 'mutation.patch')], { cwd: workdir });
    execFileSync('git', ['-c', 'user.name=telos-ci', '-c', 'user.email=ci@telos.local', 'commit', '-aqm', 'chore: sync generated sources'], { cwd: workdir });
  }
  if (arm !== 'A0') {
    mkdirSync(join(workdir, '.claude', 'hooks'), { recursive: true });
    cpSync(join(ROOT, 'arms', 'settings-gate.json'), join(workdir, '.claude', 'settings.json'));
    cpSync(join(ROOT, 'arms', 'stop-gate.sh'), join(workdir, '.claude', 'hooks', 'stop-gate.sh'));
    execFileSync('chmod', ['+x', join(workdir, '.claude', 'hooks', 'stop-gate.sh')]);
  }
  return workdir;
}

function buildPrompt(task, arm) {
  let p = readFileSync(join(ROOT, 'tasks-v2', task.id, 'brief.md'), 'utf8');
  if (arm === 'FULL') {
    p += `\nYour FINAL message must be ONLY a raw JSON object (no code fences, no prose), matching:\n{"rootCause": string, "filesChanged": string[], "testsGreen": boolean}`;
  }
  return p;
}

function review(workdir, task, modelId) {
  const brief = readFileSync(join(ROOT, 'tasks-v2', task.id, 'brief.md'), 'utf8');
  const diff = sh('git diff HEAD', { cwd: workdir, maxBuffer: 8 * 1024 * 1024 }).slice(0, 60000);
  const status = sh('git status --porcelain', { cwd: workdir }).slice(0, 2000);
  const prompt = `You are an adversarial code reviewer for an autonomous coding agent's work. Attempt to REFUTE that this change correctly and fully accomplishes the task. Look specifically for: symptom-masking instead of root-cause fixes, modifications or additions to test files, missed edge cases, incomplete coverage of multi-part tasks, and unrelated or excessive changes. Do not run commands; judge the diff on its face.

--- TASK ---
${brief}

--- CANDIDATE DIFF (vs the commit the task started from) ---
${diff || '(empty diff - the agent changed nothing)'}

--- UNTRACKED/STATUS ---
${status || '(clean)'}

You may read repository files to check the diff's claims. Your FINAL message must be ONLY a raw JSON object on one line - no code fences, no other text:
{"verdict": "APPROVE" | "REQUEST_CHANGES", "issues": string[]}`;
  // maxTurns 4 → 20 (mid-pilot patch, journaled as a note event): reviewers
  // legitimately Read files before judging and were dying on the turn cap
  // with stop_reason=tool_use and no verdict at all.
  const r = claude(workdir, prompt, modelId, { maxTurns: 20, timeoutS: 600 });
  const verdict = r.ok ? extractJson(r.text) : null;
  return { ...r, verdict };
}

function score(workdir, task) {
  const suite = spawnSync('pnpm', ['-s', 'test'], { cwd: workdir, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const visibleGreen = suite.status === 0;

  // tamper: modified OR newly added test files
  const changed = sh('git diff --name-only HEAD', { cwd: workdir }).split('\n').filter(Boolean);
  const untracked = sh('git ls-files --others --exclude-standard', { cwd: workdir }).split('\n').filter(Boolean);
  const isTest = (f) => /__tests__\/|\.test\.ts$/.test(f);
  const tamper = [...changed.filter(isTest), ...untracked.filter(isTest)];

  const dests = [];
  const shared = join(workdir, 'packages/core/__tests__/holdout.bench.test.ts');
  cpSync(join(ROOT, 'tasks', 'holdout.bench.test.ts'), shared);
  dests.push(shared);
  const own = join(ROOT, 'tasks-v2', task.id, 'holdout.test.ts');
  if (existsSync(own)) {
    const d = join(workdir, 'packages/core/__tests__/holdout.own.test.ts');
    cpSync(own, d);
    dests.push(d);
  }
  const hold = spawnSync(
    'pnpm',
    ['-s', 'vitest', '--workspace', 'vitest.workspace.ts', 'run', 'packages/core/__tests__/holdout.bench.test.ts', 'packages/core/__tests__/holdout.own.test.ts'],
    { cwd: workdir, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const d of dests) rmSync(d, { force: true });
  const holdoutPass = hold.status === 0;

  let blocks = 0;
  const cnt = join(workdir, '.claude', 'gate-blocks.count');
  if (existsSync(cnt)) blocks = Number(readFileSync(cnt, 'utf8').trim()) || 0;

  // class-aware outcome:
  //  mutation classes (discovery/compound/report): success = visibleGreen && holdout && !tamper
  //  feature: success = holdout (visible suite must also stay green) && !tamper
  const success = visibleGreen && holdoutPass && tamper.length === 0;
  // silent failure: the agent finished with a green visible suite but the holdout/tamper says otherwise
  const silentFailure = visibleGreen && (!holdoutPass || tamper.length > 0);

  return {
    visibleGreen,
    holdoutPass,
    tamper,
    success,
    silentFailure,
    blocks,
    changedFiles: changed,
    diffstat: sh('git diff --shortstat HEAD', { cwd: workdir }).trim(),
  };
}

function runOne(task, model, arm) {
  const key = `${task.id}:${model}:${arm}`;
  if (done.has(key)) {
    log(`skip ${key}`);
    return;
  }
  checkCeiling(`before ${key}`);
  log(`=== RUN ${key} ($${globalCost.toFixed(2)} spent) ===`);
  const t0 = Date.now();
  const modelId = MODELS[model];
  const workdir = setupWorkdir(task, model, arm);
  const rec = { event: 'run', task: task.id, cls: task.cls, model, arm, modelId, pinnedSha: PINNED_SHA, costUsd: 0, invocations: [] };

  try {
    const primary = claude(workdir, buildPrompt(task, arm), modelId);
    rec.costUsd += primary.cost;
    rec.invocations.push({ role: 'primary', cost: primary.cost, turns: primary.turns, wallS: Math.round(primary.wallS), timedOut: primary.timedOut });
    checkCeiling(`after primary ${key}`);
    if (rec.costUsd > PER_RUN_CAP_USD) rec.perRunCapExceeded = true;

    if (arm === 'FULL') {
      rec.contract = (() => {
        const c = extractJson(primary.text);
        return c && typeof c.rootCause === 'string' ? c : null;
      })();
      const rev = review(workdir, task, modelId);
      rec.costUsd += rev.cost;
      rec.invocations.push({ role: 'reviewer', cost: rev.cost, wallS: Math.round(rev.wallS) });
      rec.rawReview = (rev.text || '').slice(0, 3000);
      rec.reviewVerdict = rev.verdict?.verdict ?? 'UNPARSEABLE';
      rec.reviewIssues = rev.verdict?.issues ?? [];
      checkCeiling(`after review ${key}`);
      if (rec.reviewVerdict === 'REQUEST_CHANGES' && primary.sessionId) {
        const fb = `An adversarial reviewer examined your change and requests changes:\n${(rec.reviewIssues.length ? rec.reviewIssues : ['(reconsider for symptom-masking, missed parts, and edge cases)']).map((i) => `- ${i}`).join('\n')}\nAddress each point, keep the full suite green (pnpm -s test), and do not add or modify test files.`;
        const revision = claude(workdir, fb, modelId, { resume: primary.sessionId, maxTurns: 40 });
        rec.costUsd += revision.cost;
        rec.invocations.push({ role: 'revision', cost: revision.cost, turns: revision.turns, wallS: Math.round(revision.wallS) });
        rec.revised = true;
      }
    }

    Object.assign(rec, score(workdir, task));
    writeFileSync(join(RESULTS, `p2-${task.id}-${model}-${arm}.diff`), sh('git diff HEAD', { cwd: workdir, maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    rec.error = String(err).slice(0, 500);
  } finally {
    rec.wallSecTotal = Math.round((Date.now() - t0) / 1000);
    rec.globalCostAfter = Number(globalCost.toFixed(4));
    journal(rec);
    rmSync(workdir, { recursive: true, force: true });
    log(`${key}: success=${rec.success} visible=${rec.visibleGreen} holdout=${rec.holdoutPass} silent=${rec.silentFailure} blocks=${rec.blocks} review=${rec.reviewVerdict ?? '-'} $${rec.costUsd?.toFixed(2)} ${rec.wallSecTotal}s`);
  }
}

const grid = [];
for (const task of TASKS) for (const [model, arm] of CELLS) grid.push([task, model, arm]);
const selected = only ? grid.filter(([t, m, a]) => `${t.id}:${m}:${a}` === only) : grid;
log(`pilot2 start: ${selected.length} runs, ceiling $${GLOBAL_CEILING_USD}, resume-skip ${done.size}`);
for (const [task, model, arm] of selected) runOne(task, model, arm);
journal({ event: 'summary', globalCost: Number(globalCost.toFixed(4)), runs: selected.length });
log(`pilot2 complete. total $${globalCost.toFixed(2)}. journal: ${JOURNAL}`);
