#!/usr/bin/env node
/**
 * harness-bench pilot 7 – analysis.
 *
 * Reads results/pilot7.jsonl and prints the tables the README needs.
 *
 * Unit-of-analysis discipline: the EPIC is the experimental unit. Per-issue
 * proportions are reported because they are informative, but issues within an
 * epic are not independent (issue N's failure can cause N+k's), so they are
 * never pooled into a significance test. Only epic-level 2x2s get a p-value.
 *
 * Usage: node runner/analyze-pilot7.mjs [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const JOURNAL = join(ROOT, 'results', 'pilot7.jsonl');
const EPIC = JSON.parse(readFileSync(join(ROOT, 'tasks-v5', 'epic1', 'epic.json'), 'utf8'));
const ISSUES = EPIC.issues.map((i) => i.id);
const asJson = process.argv.includes('--json');

if (!existsSync(JOURNAL)) {
  console.error(`no journal at ${JOURNAL}`);
  process.exit(2);
}

const recs = readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Append-only invalidation: an `invalidate` event voids that epic's records.
const voided = new Set(recs.filter((r) => r.event === 'invalidate').map((r) => r.epicKey));
const live = recs.filter((r) => !r.invalidated && !voided.has(r.epicKey));
const issueRecs = live.filter((r) => r.event === 'issue' && r.rep !== 0);
const epicRecs = live.filter((r) => r.event === 'epic' && r.rep !== 0);
const invalidated = recs.filter((r) => r.invalidated);
const calibration = recs.filter((r) => r.event === 'calibration');

// --- stats helpers ----------------------------------------------------------
const lnFactCache = [0, 0];
function lnFact(n) {
  if (lnFactCache[n] !== undefined) return lnFactCache[n];
  let v = lnFactCache[lnFactCache.length - 1];
  for (let i = lnFactCache.length; i <= n; i++) {
    v += Math.log(i);
    lnFactCache[i] = v;
  }
  return lnFactCache[n];
}
const lnChoose = (n, k) => (k < 0 || k > n ? -Infinity : lnFact(n) - lnFact(k) - lnFact(n - k));

/** Two-sided Fisher exact test on [[a,b],[c,d]]. */
function fisher(a, b, c, d) {
  const n = a + b + c + d;
  const r1 = a + b;
  const c1 = a + c;
  const lnP = (x) => lnChoose(r1, x) + lnChoose(n - r1, c1 - x) - lnChoose(n, c1);
  const obs = lnP(a);
  let p = 0;
  const lo = Math.max(0, c1 - (n - r1));
  const hi = Math.min(r1, c1);
  for (let x = lo; x <= hi; x++) {
    const l = lnP(x);
    if (l <= obs + 1e-9) p += Math.exp(l);
  }
  return Math.min(1, p);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '–');

// --- assemble per-epic view -------------------------------------------------
const epics = new Map();
for (const r of issueRecs) {
  if (!epics.has(r.epicKey)) epics.set(r.epicKey, { key: r.epicKey, model: r.model, arm: r.arm, rep: r.rep, issues: new Map() });
  epics.get(r.epicKey).issues.set(r.issue, r);
}
for (const r of epicRecs) {
  if (!epics.has(r.epicKey)) epics.set(r.epicKey, { key: r.epicKey, model: r.model, arm: r.arm, rep: r.rep, issues: new Map() });
  Object.assign(epics.get(r.epicKey), { rollup: r });
}

for (const e of epics.values()) {
  const seq = ISSUES.map((id) => e.issues.get(id));
  e.completedIssues = seq.filter(Boolean).length;
  // survival: consecutive strict-green issues from the start
  let s = 0;
  for (const r of seq) {
    if (r?.strict) s++;
    else break;
  }
  e.survival = s;
  e.strictIssues = seq.filter((r) => r?.strict).length;
  e.silentIssues = seq.filter((r) => r?.silent).length;
  e.blocks = sum(seq.filter(Boolean).map((r) => r.blocks ?? 0));
  e.reqChanges = seq.filter((r) => r?.reviewVerdict === 'REQUEST_CHANGES').length;
  e.unparseable = seq.filter((r) => r?.reviewVerdict === 'UNPARSEABLE').length;
  e.cost = sum(seq.filter(Boolean).map((r) => r.costUsd ?? 0));
  e.wall = sum(seq.filter(Boolean).map((r) => r.wallSecTotal ?? 0));
  e.alarms = seq.filter((r) => r?.alarms?.length).map((r) => `${r.issue}:${r.alarms.join('|')}`);
  // regression decay / repair, from the epic-end re-grade
  const end = e.rollup?.endHoldouts ?? {};
  e.decayed = ISSUES.filter((id) => e.issues.get(id)?.holdoutPass === true && end[id] === false);
  e.repaired = ISSUES.filter((id) => e.issues.get(id)?.holdoutPass === false && end[id] === true);
  e.epicStrict = e.rollup?.epicStrict === true;
  e.integrationPass = e.rollup?.integrationPass === true;
}

const cells = [];
for (const model of ['haiku', 'sonnet', 'opus']) {
  for (const arm of ['A0', 'FULL']) {
    const es = [...epics.values()].filter((e) => e.model === model && e.arm === arm);
    if (!es.length) continue;
    cells.push({
      model,
      arm,
      n: es.length,
      epicStrict: es.filter((e) => e.epicStrict).length,
      integration: es.filter((e) => e.integrationPass).length,
      medSurvival: median(es.map((e) => e.survival)),
      issuesStrict: sum(es.map((e) => e.strictIssues)),
      issuesGraded: sum(es.map((e) => e.completedIssues)),
      silent: sum(es.map((e) => e.silentIssues)),
      decayed: sum(es.map((e) => e.decayed.length)),
      repaired: sum(es.map((e) => e.repaired.length)),
      blocks: sum(es.map((e) => e.blocks)),
      reqChanges: sum(es.map((e) => e.reqChanges)),
      unparseable: sum(es.map((e) => e.unparseable)),
      cost: sum(es.map((e) => e.cost)),
      medWallMin: median(es.map((e) => e.wall / 60)),
      epics: es,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ cells: cells.map(({ epics, ...c }) => c), epics: [...epics.values()].map(({ issues, rollup, ...e }) => e) }, null, 2));
  process.exit(0);
}

// --- output -----------------------------------------------------------------
const spend = sum(live.filter((r) => r.event === 'issue').map((r) => r.costUsd ?? 0));
console.log(`\n# harness-bench pilot 7 — epic scale\n`);
console.log(`epics: ${epics.size} · graded issues: ${issueRecs.length} · spend this pilot: $${spend.toFixed(2)}`);
if (invalidated.length) console.log(`invalidated (excluded, retained for audit): ${invalidated.length}`);
if (calibration.length) {
  const bad = calibration.filter((c) => !c.ok);
  console.log(`calibration: ${calibration.length} checks, ${bad.length} failing${bad.length ? ` (${bad.map((b) => b.issue).join(', ')})` : ''}`);
}

console.log(`\n## Epic-level (the experimental unit)\n`);
console.log('| cell | epic strict | integration | median survival /8 | median wall | $/epic | $/strict epic |');
console.log('|---|---|---|---|---|---|---|');
for (const c of cells) {
  const perStrict = c.epicStrict ? `$${(c.cost / c.epicStrict).toFixed(2)}` : '–';
  console.log(
    `| ${c.model}:${c.arm} | ${c.epicStrict}/${c.n} | ${c.integration}/${c.n} | ${c.medSurvival ?? '–'} | ${c.medWallMin ? `${c.medWallMin.toFixed(0)}min` : '–'} | $${(c.cost / c.n).toFixed(2)} | ${perStrict} |`,
  );
}

console.log(`\n## Per-issue (informative only — issues within an epic are NOT independent)\n`);
console.log('| cell | issues strict | silent | decayed | repaired | gate blocks | REQUEST_CHANGES | unparseable |');
console.log('|---|---|---|---|---|---|---|---|');
for (const c of cells) {
  console.log(
    `| ${c.model}:${c.arm} | ${c.issuesStrict}/${c.issuesGraded} (${pct(c.issuesStrict, c.issuesGraded)}) | ${c.silent} | ${c.decayed} | ${c.repaired} | ${c.blocks} | ${c.reqChanges} | ${c.unparseable} |`,
  );
}

console.log(`\n## Per-issue strict rate by position (does difficulty ride the sequence?)\n`);
console.log(`| cell | ${ISSUES.join(' | ')} |`);
console.log(`|---|${ISSUES.map(() => '---').join('|')}|`);
for (const c of cells) {
  const row = ISSUES.map((id) => {
    const rs = c.epics.map((e) => e.issues.get(id)).filter(Boolean);
    return rs.length ? `${rs.filter((r) => r.strict).length}/${rs.length}` : '–';
  });
  console.log(`| ${c.model}:${c.arm} | ${row.join(' | ')} |`);
}

// --- significance, epic level only ------------------------------------------
console.log(`\n## Fisher exact (two-sided), epic as the unit\n`);
const cell = (m, a) => cells.find((c) => c.model === m && c.arm === a);
const contrast = (label, x, y) => {
  if (!x || !y) return;
  const p = fisher(x.epicStrict, x.n - x.epicStrict, y.epicStrict, y.n - y.epicStrict);
  console.log(`- ${label}: ${x.epicStrict}/${x.n} vs ${y.epicStrict}/${y.n} — p=${p.toFixed(3)}`);
};
for (const m of ['haiku', 'sonnet', 'opus']) contrast(`${m}: FULL vs A0`, cell(m, 'FULL'), cell(m, 'A0'));
const pooled = (arm) => {
  const cs = cells.filter((c) => c.arm === arm);
  return { epicStrict: sum(cs.map((c) => c.epicStrict)), n: sum(cs.map((c) => c.n)) };
};
contrast('all tiers: FULL vs A0', pooled('FULL'), pooled('A0'));
const tier = (m) => {
  const cs = cells.filter((c) => c.model === m);
  return { epicStrict: sum(cs.map((c) => c.epicStrict)), n: sum(cs.map((c) => c.n)) };
};
contrast('opus vs haiku (both arms)', tier('opus'), tier('haiku'));
contrast('sonnet vs haiku (both arms)', tier('sonnet'), tier('haiku'));
contrast('opus vs sonnet (both arms)', tier('opus'), tier('sonnet'));

// --- things that need a human ----------------------------------------------
const alarmed = [...epics.values()].filter((e) => e.alarms.length);
if (alarmed.length) {
  console.log(`\n## Plausibility alarms — autopsy before counting these\n`);
  for (const e of alarmed) console.log(`- ${e.key}: ${e.alarms.join(', ')}`);
}
const decayAll = [...epics.values()].filter((e) => e.decayed.length);
if (decayAll.length) {
  console.log(`\n## Regression decay — an issue's holdout went green then red\n`);
  for (const e of decayAll) console.log(`- ${e.key}: ${e.decayed.join(', ')} regressed by epic end`);
}
const repairAll = [...epics.values()].filter((e) => e.repaired.length);
if (repairAll.length) {
  console.log(`\n## Repair — a failed issue was fixed by later work\n`);
  for (const e of repairAll) console.log(`- ${e.key}: ${e.repaired.join(', ')}`);
}
console.log('');
