#!/usr/bin/env node
/**
 * harness-bench pilot 7 – EPIC-SCALE: horizon x tier x enforcement.
 *
 * Pilots 1-6 all ran single-session, minutes-scale tasks; the study's own
 * thesis ("harness ROI is a function of horizon") was never tested in the
 * regime where production telemetry says the value lives. Pilot 7 moves the
 * horizon: one coherent feature-set decomposed into sequentially dependent
 * issues, implemented one issue at a time in the SAME working tree by a FRESH
 * session each time (state accumulates in code, not context - conventions
 * established by earlier issues must be discovered from the repo, which is
 * where omission-class failures live, per finding 16).
 *
 * Grid: {haiku, sonnet, opus} x {A0, FULL} x n=3 = 18 epic runs.
 * No planning arm (settled, pilots 4-5). Budget ceiling $1,000 (2026-08-02).
 *
 * Grading upgrades over pilot 6 (pre-registered):
 *  - strict success from the start: build AND visible AND holdout, per issue
 *    (finding 17a: vitest does not typecheck);
 *  - the done-gate enforces build && test (stop-gate-v2), same rationale;
 *  - epic-end re-grade: every issue holdout re-run after the last issue, plus
 *    an integration holdout -> measures regression decay (green-at-boundary
 *    vs still-green-at-end), a metric single-task pilots cannot have;
 *  - survival: issues strict-green before first failure; repairs (issue
 *    holdout red at its own boundary, green at epic end);
 *  - plausibility alarms journaled per invocation (finding 17b: the pass/fail
 *    column cannot catch auth expiry or no-op runs).
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG_DIR = join(ROOT, '.claude-bench-config');
const RESULTS = join(ROOT, 'results');
const JOURNAL = join(RESULTS, 'pilot7.jsonl');
const EPIC_DIR = join(ROOT, 'tasks-v5', 'epic1');

const REPOS = {
  autograph: { pristine: join(ROOT, '.pristine-autograph'), vitestArgs: [] },
};
const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' };
const GLOBAL_CEILING_USD = 1000.0; // refreshed 2026-08-02 (was $555)
const PRIOR_SPEND_USD = 256.26; // pilots 1-6
const PER_EPIC_CAP_USD = 150.0; // opus FULL epics are heavy; cap warns + halts epic, not grid
const ISSUE_TIMEOUT_S = 3600;
const MAX_TURNS = 200;
const CONCURRENCY = 2;
const REPS = 3;

const EPIC = JSON.parse(readFileSync(join(EPIC_DIR, 'epic.json'), 'utf8'));
// epic.json: { id, repo, preamble, issues: [{ id, title }], integration: { files: {...} } }
// per-issue dir tasks-v5/epic1/<issueId>/: brief.md, holdout.json, holdout tests

const TIERS = ['haiku', 'sonnet', 'opus'];
const CELLS = [];
for (const model of TIERS) for (const arm of ['A0', 'FULL']) CELLS.push({ model, arm });

process.env.VITEST_MAX_THREADS = '4';
process.env.VITEST_MIN_THREADS = '1';
process.env.VITEST_MAX_FORKS = '4';
process.env.VITEST_MIN_FORKS = '1';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const smoke = argv.includes('--smoke');

mkdirSync(RESULTS, { recursive: true });

// --- journal + resume state -------------------------------------------------
let globalCost = PRIOR_SPEND_USD;
const epicsDone = new Set();
const issuesDone = new Map(); // epicKey -> Set(issueId)
if (existsSync(JOURNAL)) {
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    if (rec.invalidated) continue; // excluded from resume + analysis, retained for audit
    if (rec.event === 'issue') {
      globalCost += rec.costUsd ?? 0;
      if (!issuesDone.has(rec.epicKey)) issuesDone.set(rec.epicKey, new Set());
      issuesDone.get(rec.epicKey).add(rec.issue);
    }
    // A restart marker voids that epic's earlier issue records for resume
    // purposes (their cost still counts - the money was spent).
    if (rec.event === 'restart') issuesDone.get(rec.epicKey)?.clear();
    if (rec.event === 'epic') {
      epicsDone.add(rec.epicKey);
      globalCost += rec.regradeCostUsd ?? 0;
    }
  }
}

const log = (m) => process.stdout.write(`[pilot7] ${new Date().toISOString()} ${m}\n`);
const journal = (rec) => appendFileSync(JOURNAL, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function checkCeiling(context) {
  if (globalCost > GLOBAL_CEILING_USD) {
    journal({ event: 'abort', reason: 'global cost ceiling', context, globalCost: Number(globalCost.toFixed(2)) });
    log(`ABORT: global ceiling ($${globalCost.toFixed(2)}) at ${context}`);
    process.exit(3);
  }
}

function claude(workdir, prompt, modelId, opts = {}) {
  const { maxTurns = MAX_TURNS, timeoutS = ISSUE_TIMEOUT_S, resume = null } = opts;
  const args = ['-p', prompt, '--model', modelId, '--output-format', 'json', '--dangerously-skip-permissions', '--max-turns', String(maxTurns)];
  if (resume) args.push('--resume', resume);
  const t0 = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd: workdir, env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR } });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutS * 1000);
    child.stdout.on('data', (d) => (out += d));
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

// --- workdir lifecycle (persistent across issues; deleted only after rollup) -
function epicWorkdir(cell, rep) {
  return join(ROOT, 'runs', `epic1-${cell.model}-${cell.arm}-r${rep}`);
}

function setupWorkdir(cell, rep) {
  const workdir = epicWorkdir(cell, rep);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  execFileSync('cp', ['-a', `${REPOS[EPIC.repo].pristine}/.`, workdir]);
  if (cell.arm === 'FULL') {
    mkdirSync(join(workdir, '.claude', 'hooks'), { recursive: true });
    cpSync(join(ROOT, 'arms', 'settings-gate.json'), join(workdir, '.claude', 'settings.json'));
    cpSync(join(ROOT, 'arms', 'stop-gate-v2.sh'), join(workdir, '.claude', 'hooks', 'stop-gate.sh'));
    execFileSync('chmod', ['+x', join(workdir, '.claude', 'hooks', 'stop-gate.sh')]);
  }
  // baseline commit + tag so per-issue and full-epic diffs are well-defined
  sh('git add -A && git -c user.email=bench@local -c user.name=bench commit -q --allow-empty -m "pilot7 baseline"', { cwd: workdir });
  sh('git tag -f pilot7-baseline', { cwd: workdir });
  return workdir;
}

function buildIssuePrompt(issue, cell) {
  const brief = readFileSync(join(EPIC_DIR, issue.id, 'brief.md'), 'utf8');
  let p = `${EPIC.preamble}\n\nYour issue for this session:\n\n${brief}`;
  if (cell.arm === 'FULL') {
    p += `\n\nYour FINAL message must be ONLY a raw JSON object (no code fences, no prose), matching:\n{"summary": string, "filesChanged": string[], "testsGreen": boolean}`;
  }
  return p;
}

async function review(workdir, issue, modelId, rec) {
  const brief = readFileSync(join(EPIC_DIR, issue.id, 'brief.md'), 'utf8');
  const diff = sh('git diff HEAD', { cwd: workdir, maxBuffer: 16 * 1024 * 1024 }).slice(0, 100000);
  const status = sh('git status --porcelain', { cwd: workdir }).slice(0, 2000);
  const prompt = `You are an adversarial code reviewer for an autonomous coding agent's work. Attempt to REFUTE that this change correctly and fully accomplishes the issue. Look specifically for: missed sub-requirements (exact names, values, defaults), weakened existing assertions, incomplete wiring or caller migration across layers, divergence from conventions this repository already established for this feature area, and unrelated or excessive changes. You may read repository files to check the diff's claims.

--- ISSUE ---
${brief}

--- CANDIDATE DIFF (this issue only) ---
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
  return verdict;
}

function runHoldout(workdir, holdoutDirEntry) {
  // holdoutDirEntry: { taskDir, map } - inject zz- files, run, remove
  const dests = [];
  for (const [file, destDir] of Object.entries(holdoutDirEntry.map)) {
    // mkdir: the destination package dir may not exist if the agent never
    // created the module. A missing dir must score as a red holdout, not
    // crash the run.
    mkdirSync(join(workdir, destDir), { recursive: true });
    const d = join(workdir, destDir, `zz-${file}`);
    cpSync(join(holdoutDirEntry.taskDir, file), d);
    dests.push(d);
  }
  // Typecheck WITH the holdout in the tree. Each package's tsconfig includes
  // src/**, so `tsc --build` typechecks the injected file - which is the only
  // way to grade a *type*-level export (vitest transpiles without checking, and
  // a missing `export type` from a barrel is invisible at runtime). This is the
  // exact omission class the epic plants; grading it needs the compiler.
  const types = spawnSync('pnpm', ['-s', 'build'], { cwd: workdir, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  const typesGreen = types.status === 0;

  const hold = spawnSync('pnpm', ['-s', 'vitest', ...REPOS[EPIC.repo].vitestArgs, 'run', 'zz-holdout', 'zz-integration'], {
    cwd: workdir,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const d of dests) rmSync(d, { force: true });
  // Restore a clean build tree: stale dist from a holdout build silently broke
  // cross-package imports once already (finding 6b).
  spawnSync('pnpm', ['-s', 'build'], { cwd: workdir, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  return {
    pass: typesGreen && hold.status === 0,
    typesGreen,
    tail: (hold.stdout || '').split('\n').filter((l) => /×|Tests |Test Files|error TS/.test(l)).slice(-10),
    typeTail: typesGreen ? [] : (types.stdout || types.stderr || '').split('\n').filter((l) => /error TS/.test(l)).slice(-10),
  };
}

function issueHoldoutEntry(issueId) {
  const taskDir = join(EPIC_DIR, issueId);
  return { taskDir, map: JSON.parse(readFileSync(join(taskDir, 'holdout.json'), 'utf8')) };
}

function scoreIssue(workdir, issueId, rec) {
  const build = spawnSync('pnpm', ['-s', 'build'], { cwd: workdir, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  rec.buildGreen = build.status === 0;

  const suite = spawnSync('pnpm', ['-s', 'test'], { cwd: workdir, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  rec.visibleGreen = suite.status === 0;

  const changed = sh('git diff --name-only HEAD', { cwd: workdir }).split('\n').filter(Boolean);
  const untracked = sh('git ls-files --others --exclude-standard', { cwd: workdir }).split('\n').filter(Boolean);
  const isTest = (f) => /__tests__\/|\.test\.ts$/.test(f);
  rec.testEdits = [...changed.filter(isTest), ...untracked.filter(isTest)];
  rec.changedFiles = changed.concat(untracked);
  rec.diffstat = sh('git diff --shortstat HEAD', { cwd: workdir }).trim();

  const hold = runHoldout(workdir, issueHoldoutEntry(issueId));
  rec.holdoutPass = hold.pass;
  rec.holdoutTypesGreen = hold.typesGreen;
  rec.holdoutTail = hold.tail;
  if (hold.typeTail?.length) rec.holdoutTypeTail = hold.typeTail;

  rec.strict = rec.buildGreen && rec.visibleGreen && rec.holdoutPass;
  rec.silent = rec.visibleGreen && !rec.holdoutPass;

  const cnt = join(workdir, '.claude', 'gate-blocks.count');
  rec.blocks = existsSync(cnt) ? Number(readFileSync(cnt, 'utf8').trim()) || 0 : 0;
  rmSync(cnt, { force: true }); // per-issue accounting
}

// Plausibility alarms (finding 17b): flag for autopsy, never auto-score.
function plausibility(rec, primary) {
  const alarms = [];
  if (primary.cost < 0.02) alarms.push('cost<0.02');
  if (primary.wallS < 30) alarms.push('wall<30s');
  if ((primary.turns ?? 99) <= 2) alarms.push('turns<=2');
  if ((rec.changedFiles ?? []).length === 0) alarms.push('no-files-changed');
  if (alarms.length) rec.alarms = alarms;
}

async function runEpic(cell, rep) {
  const epicKey = `epic1:${cell.model}:${cell.arm}:${rep}`;
  if (epicsDone.has(epicKey)) {
    log(`skip ${epicKey} (complete)`);
    return;
  }
  checkCeiling(`before ${epicKey}`);
  const modelId = MODELS[cell.model];
  const doneIssues = issuesDone.get(epicKey) ?? new Set();
  let workdir = epicWorkdir(cell, rep);
  if (doneIssues.size > 0 && existsSync(workdir)) {
    log(`=== RESUME ${epicKey} at issue ${doneIssues.size + 1}/${EPIC.issues.length} ===`);
  } else {
    if (doneIssues.size > 0) {
      journal({ event: 'restart', epicKey, note: `workdir lost with ${doneIssues.size} issues journaled; restarting epic from scratch (pre-restart issue records excluded from analysis)` });
      doneIssues.clear();
    }
    log(`=== EPIC ${epicKey} ($${globalCost.toFixed(2)} cumulative) ===`);
    workdir = setupWorkdir(cell, rep);
  }

  let epicCost = 0;
  const t0 = Date.now();
  for (const issue of EPIC.issues) {
    if (doneIssues.has(issue.id)) continue;
    checkCeiling(`before ${epicKey}:${issue.id}`);
    if (epicCost > PER_EPIC_CAP_USD) {
      journal({ event: 'note', epicKey, note: `per-epic cap $${PER_EPIC_CAP_USD} exceeded at ${issue.id}; halting epic` });
      log(`HALT ${epicKey}: per-epic cap at ${issue.id}`);
      break;
    }
    const rec = { event: 'issue', epicKey, epic: 'epic1', issue: issue.id, model: cell.model, arm: cell.arm, rep, costUsd: 0, invocations: [] };
    const t1 = Date.now();
    try {
      const primary = await claude(workdir, buildIssuePrompt(issue, cell), modelId);
      rec.costUsd += primary.cost;
      rec.invocations.push({ role: 'primary', cost: primary.cost, turns: primary.turns, wallS: Math.round(primary.wallS), timedOut: primary.timedOut });

      if (cell.arm === 'FULL') {
        rec.contract = await extractJsonWithSalvage(workdir, primary.text, '{"summary": string, "filesChanged": string[], "testsGreen": boolean}', modelId, rec, 'contract');
        const verdict = await review(workdir, issue, modelId, rec);
        rec.reviewVerdict = verdict?.verdict ?? 'UNPARSEABLE';
        rec.reviewIssues = verdict?.issues ?? [];
        if (rec.reviewVerdict === 'REQUEST_CHANGES' && primary.sessionId) {
          const fb = `An adversarial reviewer examined your change and requests changes:\n${(rec.reviewIssues.length ? rec.reviewIssues : ['(reconsider for missed sub-requirements and incomplete migration)']).map((i) => `- ${i}`).join('\n')}\nAddress each point and keep the full suite green (pnpm -s build && pnpm -s test).`;
          const revision = await claude(workdir, fb, modelId, { resume: primary.sessionId, maxTurns: 80, timeoutS: 1800 });
          rec.costUsd += revision.cost;
          rec.invocations.push({ role: 'revision', cost: revision.cost, turns: revision.turns, wallS: Math.round(revision.wallS) });
          rec.revised = true;
        }
      }

      scoreIssue(workdir, issue.id, rec);
      plausibility(rec, primary);
      // Auth/CLI death signature: invalidate + halt this epic (finding 17b -
      // a credential expiry must never be scored as a model failure).
      if (!primary.ok && primary.cost === 0 && !primary.sessionId) {
        rec.invalidated = true;
        rec.invalidReason = 'primary invocation died with zero cost and no session (auth/CLI failure signature)';
        journal(rec);
        log(`INVALIDATED ${epicKey}:${issue.id} - auth/CLI death; halting epic for manual restart`);
        return; // leave workdir for autopsy; epic resumes after operator fixes auth
      }

      writeFileSync(join(RESULTS, `p7-${epicKey.replace(/:/g, '-')}-${issue.id}.diff`), sh('git diff HEAD', { cwd: workdir, maxBuffer: 32 * 1024 * 1024 }));
      sh(`git add -A && git -c user.email=bench@local -c user.name=bench commit -q --allow-empty -m "agent: ${issue.id}"`, { cwd: workdir });
    } catch (err) {
      rec.error = String(err).slice(0, 500);
    } finally {
      if (!rec.invalidated) {
        rec.wallSecTotal = Math.round((Date.now() - t1) / 1000);
        epicCost += rec.costUsd;
        rec.epicCostAfter = Number(epicCost.toFixed(4));
        rec.globalCostAfter = Number(globalCost.toFixed(4));
        journal(rec);
        log(`${epicKey}:${issue.id}: strict=${rec.strict} build=${rec.buildGreen} visible=${rec.visibleGreen} holdout=${rec.holdoutPass} blocks=${rec.blocks} review=${rec.reviewVerdict ?? '-'} $${rec.costUsd?.toFixed(2)} ${rec.wallSecTotal}s${rec.alarms ? ` ALARMS=${rec.alarms.join(',')}` : ''}`);
      }
    }
  }

  // --- epic-end re-grade: every issue holdout again + integration holdout ----
  const rollup = { event: 'epic', epicKey, epic: 'epic1', model: cell.model, arm: cell.arm, rep, regradeCostUsd: 0 };
  const endBuild = spawnSync('pnpm', ['-s', 'build'], { cwd: workdir, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  rollup.endBuildGreen = endBuild.status === 0;
  const endSuite = spawnSync('pnpm', ['-s', 'test'], { cwd: workdir, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  rollup.endVisibleGreen = endSuite.status === 0;
  rollup.endHoldouts = {};
  for (const issue of EPIC.issues) {
    rollup.endHoldouts[issue.id] = runHoldout(workdir, issueHoldoutEntry(issue.id)).pass;
  }
  const integ = runHoldout(workdir, { taskDir: EPIC_DIR, map: EPIC.integration.files });
  rollup.integrationPass = integ.pass;
  rollup.integrationTail = integ.tail;
  rollup.epicStrict = rollup.endBuildGreen && rollup.endVisibleGreen && rollup.integrationPass && Object.values(rollup.endHoldouts).every(Boolean);
  rollup.wallSecTotal = Math.round((Date.now() - t0) / 1000);
  rollup.epicCostUsd = Number(epicCost.toFixed(4));
  rollup.globalCostAfter = Number(globalCost.toFixed(4));
  writeFileSync(join(RESULTS, `p7-${epicKey.replace(/:/g, '-')}-FULL-EPIC.diff`), sh('git diff pilot7-baseline HEAD', { cwd: workdir, maxBuffer: 64 * 1024 * 1024 }));
  journal(rollup);
  log(`EPIC ${epicKey}: strict=${rollup.epicStrict} integration=${rollup.integrationPass} endHoldouts=${Object.values(rollup.endHoldouts).filter(Boolean).length}/${EPIC.issues.length} $${epicCost.toFixed(2)} ${Math.round(rollup.wallSecTotal / 60)}min`);
  rmSync(workdir, { recursive: true, force: true });
}

// --- main --------------------------------------------------------------------
const modelFilter = flag('--models')?.split(',') ?? null;
const armFilter = flag('--arms')?.split(',') ?? null;
const repsOverride = flag('--reps') ? Number(flag('--reps')) : null;
let grid = [];
for (const cell of CELLS) for (let rep = 1; rep <= (repsOverride ?? REPS); rep++) grid.push([cell, rep]);
if (smoke) grid = [[{ model: 'haiku', arm: 'A0' }, 0]]; // rep 0 = smoke, excluded from grid analysis
if (modelFilter) grid = grid.filter(([c]) => modelFilter.includes(c.model));
if (armFilter) grid = grid.filter(([c]) => armFilter.includes(c.arm));

log(`pilot7 start: ${grid.length} epic runs x ${EPIC.issues.length} issues, concurrency ${CONCURRENCY}, ceiling $${GLOBAL_CEILING_USD} (incl. $${PRIOR_SPEND_USD} prior), resume: ${epicsDone.size} epics + ${[...issuesDone.values()].reduce((a, s) => a + s.size, 0)} issues journaled`);
let idx = 0;
async function workerLoop() {
  while (idx < grid.length) {
    const [cell, rep] = grid[idx++];
    await runEpic(cell, rep);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
journal({ event: 'summary', globalCost: Number(globalCost.toFixed(4)), epicRuns: grid.length });
log(`pilot7 complete. cumulative $${globalCost.toFixed(2)}. journal: ${JOURNAL}`);
