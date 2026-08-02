#!/usr/bin/env node
/**
 * harness-bench pilot 7 – holdout calibration.
 *
 * A holdout only means something if it is RED on the state before its issue and
 * GREEN on the reference state after it. Anything green-before is not measuring
 * that issue; anything red-after is either an over-specified holdout or a broken
 * reference. Both are bugs to fix BEFORE any graded run - this is the gate.
 *
 * Replays the reference implementation commit by commit:
 *   for each issue k: check out ref(k-1) -> holdout k must FAIL
 *                     check out ref(k)   -> holdout k must PASS
 * plus the integration holdout, which must be red at every commit before i8 and
 * green at i8.
 *
 * Grading mirrors the runner exactly: inject the holdout, `pnpm build` (this is
 * what grades type-level exports), then vitest.
 *
 * Usage: node runner/calibrate-pilot7.mjs [--only i3] [--skip-before]
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REF = join(ROOT, '.reference-epic1');
const EPIC_DIR = join(ROOT, 'tasks-v5', 'epic1');
const JOURNAL = join(ROOT, 'results', 'pilot7.jsonl');
const EPIC = JSON.parse(readFileSync(join(EPIC_DIR, 'epic.json'), 'utf8'));

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const skipBefore = argv.includes('--skip-before');

process.env.VITEST_MAX_THREADS = '4';
process.env.VITEST_MIN_THREADS = '1';
process.env.VITEST_MAX_FORKS = '4';
process.env.VITEST_MIN_FORKS = '1';

const log = (m) => process.stdout.write(`[calibrate] ${new Date().toISOString()} ${m}\n`);
const journal = (rec) => appendFileSync(JOURNAL, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: REF, ...opts });

if (!existsSync(REF)) {
  log(`FATAL: reference implementation not found at ${REF}`);
  process.exit(2);
}

// Resolve the reference commit for each issue: `ref: i<N>` commit subjects.
function refCommit(issueId) {
  const out = sh(`git log --format='%H %s' --all`).split('\n').filter(Boolean);
  const hit = out.find((l) => l.replace(/^\S+ /, '').trim() === `ref: ${issueId}`);
  return hit ? hit.split(' ')[0] : null;
}
const BASELINE = sh('git rev-list --max-parents=0 HEAD').trim().split('\n').pop().trim();

function checkout(sha) {
  sh(`git checkout -q --force ${sha}`);
  sh('git clean -qfd -e node_modules -e dist -e "*.tsbuildinfo"');
}

/** Inject a holdout, typecheck + run it, remove it. Mirrors the runner. */
function grade(entry) {
  const dests = [];
  for (const [file, destDir] of Object.entries(entry.map)) {
    mkdirSync(join(REF, destDir), { recursive: true });
    const d = join(REF, destDir, `zz-${file}`);
    cpSync(join(entry.taskDir, file), d);
    dests.push(d);
  }
  const types = spawnSync('pnpm', ['-s', 'build'], { cwd: REF, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  const typesGreen = types.status === 0;
  const hold = spawnSync('pnpm', ['-s', 'vitest', 'run', 'zz-holdout', 'zz-integration'], {
    cwd: REF,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const d of dests) rmSync(d, { force: true });
  spawnSync('pnpm', ['-s', 'build'], { cwd: REF, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  const tail = ((types.stdout || '') + (types.stderr || '') + (hold.stdout || ''))
    .split('\n')
    .filter((l) => /error TS|×|Tests |Test Files|No test files found/.test(l))
    .slice(-8);
  return { pass: typesGreen && hold.status === 0, typesGreen, testsGreen: hold.status === 0, tail };
}

const issueEntry = (id) => ({ taskDir: join(EPIC_DIR, id), map: JSON.parse(readFileSync(join(EPIC_DIR, id, 'holdout.json'), 'utf8')) });
const integrationEntry = () => ({ taskDir: EPIC_DIR, map: EPIC.integration.files });

// --- reference sanity: build + full suite green at the tip -------------------
const issues = EPIC.issues.map((i) => i.id);
const commits = Object.fromEntries(issues.map((id) => [id, refCommit(id)]));
const missing = issues.filter((id) => !commits[id]);
if (missing.length) {
  log(`FATAL: reference commits missing for: ${missing.join(', ')} (expected commit subjects "ref: i1" ... "ref: i8")`);
  process.exit(2);
}

const results = [];
let failures = 0;

log(`reference tip check`);
checkout(commits[issues[issues.length - 1]]);
const tipBuild = spawnSync('pnpm', ['-s', 'build'], { cwd: REF, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
const tipTest = spawnSync('pnpm', ['-s', 'test'], { cwd: REF, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
log(`reference tip: build=${tipBuild.status === 0} suite=${tipTest.status === 0}`);
if (tipBuild.status !== 0 || tipTest.status !== 0) failures++;
results.push({ check: 'reference-tip', buildGreen: tipBuild.status === 0, suiteGreen: tipTest.status === 0 });

// --- per-issue red-before / green-after -------------------------------------
for (let k = 0; k < issues.length; k++) {
  const id = issues[k];
  if (only && only !== id) continue;
  const before = k === 0 ? BASELINE : commits[issues[k - 1]];
  const after = commits[id];
  const entry = issueEntry(id);

  let beforeRes = null;
  if (!skipBefore) {
    checkout(before);
    beforeRes = grade(entry);
    log(`${id} BEFORE (${before.slice(0, 8)}): pass=${beforeRes.pass} (want false)`);
  }

  checkout(after);
  const afterRes = grade(entry);
  log(`${id} AFTER  (${after.slice(0, 8)}): pass=${afterRes.pass} (want true)`);

  const ok = (skipBefore || beforeRes.pass === false) && afterRes.pass === true;
  if (!ok) failures++;
  const rec = {
    event: 'calibration',
    epic: 'epic1',
    issue: id,
    redBefore: beforeRes ? !beforeRes.pass : null,
    greenAfter: afterRes.pass,
    ok,
    beforeDetail: beforeRes ? { typesGreen: beforeRes.typesGreen, testsGreen: beforeRes.testsGreen, tail: beforeRes.tail } : null,
    afterDetail: { typesGreen: afterRes.typesGreen, testsGreen: afterRes.testsGreen, tail: afterRes.tail },
  };
  journal(rec);
  results.push(rec);
  if (!ok) log(`  ^^ CALIBRATION FAILURE for ${id}: ${JSON.stringify(afterRes.tail)}`);
}

// --- integration holdout: red before i8, green at i8 -------------------------
if (!only || only === 'integration') {
  const entry = integrationEntry();
  const beforeI8 = commits[issues[issues.length - 2]];
  let intBefore = null;
  if (!skipBefore) {
    checkout(beforeI8);
    intBefore = grade(entry);
    log(`integration BEFORE i8 (${beforeI8.slice(0, 8)}): pass=${intBefore.pass} (want false)`);
  }
  checkout(commits[issues[issues.length - 1]]);
  const intAfter = grade(entry);
  log(`integration AFTER  i8: pass=${intAfter.pass} (want true)`);
  const ok = (skipBefore || intBefore.pass === false) && intAfter.pass === true;
  if (!ok) failures++;
  const rec = {
    event: 'calibration',
    epic: 'epic1',
    issue: 'integration',
    redBefore: intBefore ? !intBefore.pass : null,
    greenAfter: intAfter.pass,
    ok,
    afterDetail: { typesGreen: intAfter.typesGreen, testsGreen: intAfter.testsGreen, tail: intAfter.tail },
  };
  journal(rec);
  results.push(rec);
  if (!ok) log(`  ^^ CALIBRATION FAILURE for integration: ${JSON.stringify(intAfter.tail)}`);
}

checkout(commits[issues[issues.length - 1]]);
journal({ event: 'calibration-summary', epic: 'epic1', failures, checks: results.length });
log(`calibration complete: ${results.length} checks, ${failures} failing.`);
log(failures ? 'GATE NOT PASSED - fix holdouts or reference before running the grid.' : 'GATE PASSED - holdouts are calibrated.');
process.exit(failures ? 1 : 0);
