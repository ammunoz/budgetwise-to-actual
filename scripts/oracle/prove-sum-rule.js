#!/usr/bin/env node
// Oracle: prove that Budgetwise's own per-month LTB math (ltbBreakdown.json)
// is consistent with "sum all rows per (timeframe, category_id) [id-deduped
// for CC]". If all 81 months match to the penny, the SUM rule is ground truth
// and our import must reflect it (not the "lowest-id-wins" we shipped).
//
// Also cross-checks Σ(sum − first-wins) across all duplicate groups against
// the observed LTB gap.
//
// Read-only diagnostic. No file writes. Run with:
//   node scripts/oracle/prove-sum-rule.js /path/to/captured-dir

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const captureDir = resolve(process.argv[2]);

const tfc = JSON.parse(await readFile(resolve(captureDir, 'timeframeCategories.json'), 'utf8'));
const ltb = JSON.parse(await readFile(resolve(captureDir, 'ltbBreakdown.json'), 'utf8'));
const flat = Array.isArray(tfc.data[0]) ? tfc.data.flat() : tfc.data;

console.log('Capture dir:', captureDir);
console.log('Raw tfc entries:', flat.length);
console.log('ltb months:', Object.keys(ltb).length);
console.log();

// ----- Build maps -----
// Per-month, per-(cat|cc) sums: Map<month, Map<key, { sum, rows, firstId, firstBudgeted }>>
const byMonth = new Map();
for (const e of flat) {
  if (!e.timeframe) continue;
  const k = e.is_cc ? `cc:${e.cc_account_id}` : `cat:${e.category_id}`;
  if (!byMonth.has(e.timeframe)) byMonth.set(e.timeframe, new Map());
  const m = byMonth.get(e.timeframe);
  if (!m.has(k)) m.set(k, { sum: 0, sumIdDeduped: 0, seenIds: new Set(), rows: [], firstId: e.id, firstBudgeted: parseFloat(e.budgeted || '0') });
  const agg = m.get(k);
  const budgeted = parseFloat(e.budgeted || '0');
  agg.sum += budgeted;
  agg.rows.push({ id: e.id, budgeted });
  // For CC rows, dedup by id (the BW API may emit the same row twice with
  // different spent values; the budgeted value is what matters and should
  // count once). For non-CC, every row contributes (it's a per-save history).
  if (e.is_cc) {
    if (!agg.seenIds.has(e.id)) {
      agg.sumIdDeduped += budgeted;
      agg.seenIds.add(e.id);
    }
  } else {
    agg.sumIdDeduped += budgeted;
  }
  if (e.id < agg.firstId) agg.firstId = e.id;
}

// ----- Compare each month against ltb[m].budgetedForMonth -----
const months = Object.keys(ltb).sort();
let matches = 0;
let mismatches = 0;
const mismatches_detail = [];

for (const m of months) {
  const expected = parseFloat(ltb[m].budgetedForMonth || '0');
  let total = 0;
  if (byMonth.has(m)) {
    for (const [, agg] of byMonth.get(m)) {
      // For SUM rule: non-CC rows all contribute; CC rows id-deduped
      // The aggregation above splits sumIdDeduped for this exact purpose
      total += agg.sumIdDeduped;
    }
  }
  // round to cents
  const totalCents = Math.round(total * 100);
  const expectedCents = Math.round(expected * 100);
  if (totalCents === expectedCents) {
    matches++;
  } else {
    mismatches++;
    mismatches_detail.push({ month: m, expected: expectedCents / 100, computed: totalCents / 100, diff: (totalCents - expectedCents) / 100 });
  }
}

console.log('=== Oracle 1: SUM rule per month vs ltb.budgetedForMonth ===');
console.log(`  matches:    ${matches} / ${months.length}`);
console.log(`  mismatches: ${mismatches}`);
if (mismatches > 0) {
  console.log('  first 10 mismatches:');
  for (const d of mismatches_detail.slice(0, 10)) {
    console.log(`    ${d.month}: expected=$${d.expected.toFixed(2)}  computed=$${d.computed.toFixed(2)}  diff=$${d.diff.toFixed(2)}`);
  }
}
console.log();

// ----- Cross-check: Σ(sum − first-wins) over all duplicate groups -----
let gapDollars = 0;
const groupCounts = { dupGroups: 0, totalDupRows: 0 };
for (const [, m] of byMonth) {
  for (const [, agg] of m) {
    if (agg.rows.length > 1) {
      // Find first-wins value: row with lowest id
      const sorted = [...agg.rows].sort((a, b) => a.id - b.id);
      const firstWins = sorted[0].budgeted;
      const sum = agg.sum;
      // sum of duplicates (excluding the first) that first-wins drops
      // = sum − firstWins
      gapDollars += (sum - firstWins);
      groupCounts.dupGroups++;
      groupCounts.totalDupRows += agg.rows.length;
    }
  }
}
console.log('=== Oracle 2: Σ(sum − first-wins) across duplicate groups ===');
console.log(`  duplicate (month, category) groups: ${groupCounts.dupGroups}`);
console.log(`  total duplicate rows: ${groupCounts.totalDupRows}`);
console.log(`  cumulative under-budget from first-wins: $${gapDollars.toFixed(2)}`);
console.log(`  observed LTB gap (BW leftToBudget − Actual toBudget): see compare-months.js output`);
console.log(`  diff: (compare against observed gap manually)`);
console.log();

// ----- Final verdict -----
if (mismatches === 0) {
  console.log('VERDICT: SUM rule is proven. Import must sum all rows per (timeframe, category).');
  console.log('         Current "lowest-id-wins" dedup is incorrect.');
} else {
  console.log('VERDICT: SUM rule has mismatches. Either the rule is wrong, or ltb uses different data.');
}
