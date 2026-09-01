// Regression test for dedupTimeframeCategories: the consolidated capture must
// satisfy Budgetwise's own per-month LTB identity (Σ raw budgeted per month
// equals ltbBreakdown[m].budgetedForMonth exactly to the penny).
//
// The oracle is provable from the captured data without any UI checks: BW's
// own per-month total is what ltbBreakdown.budgetedForMonth represents, and
// our consolidation must preserve that total. We use a small hand-built
// fixture (test/fixtures/oracle/) that exercises:
//   - Two dup-groups within one month (cat-a, cat-b)
//   - A trailing $0 echo (cat-a row 3)
//   - A duplicate with two non-zero rows (022021 cat-a: $75 + $75)
// The fixture's ltb.json encodes the SUM totals for each month.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture, unwrap } from '../lib/reader.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function withCapture(name, payload) {
  const dir = resolve(tmpdir(), `bw2a-oracle-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const required = {
    accounts: { data: [] },
    categories: { data: [] },
    transactions: { data: [] },
    ...payload,
  };
  for (const [filename, data] of Object.entries(required)) {
    await writeFile(resolve(dir, `${filename}.json`), JSON.stringify(data));
  }
  try {
    const cap = await loadCapture(dir);
    return unwrap(cap.timeframeCategories);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('oracle: SUM consolidation matches ltb.budgetedForMonth for every month', async () => {
  // Load fixture as if it were a real capture. The fixture has 6 raw rows.
  const tfcFixture = JSON.parse(await (await import('node:fs/promises')).readFile(
    resolve('test/fixtures/oracle/tfc.json'), 'utf8'));
  const ltbFixture = JSON.parse(await (await import('node:fs/promises')).readFile(
    resolve('test/fixtures/oracle/ltb.json'), 'utf8'));

  const out = await withCapture('oracle', {
    timeframeCategories: tfcFixture,
    ltbBreakdown: ltbFixture,
  });

  // After dedup, we should have 3 entries: cat-a 012021, cat-b 012021, cat-a 022021
  assert.equal(out.length, 3, `expected 3 deduped entries, got ${out.length}`);

  // Sum per month from the consolidated output
  const sumByMonth = new Map();
  for (const e of out) {
    if (!e.timeframe) continue;
    sumByMonth.set(e.timeframe, (sumByMonth.get(e.timeframe) || 0) + parseFloat(e.budgeted));
  }

  // Compare against ltb.budgetedForMonth
  for (const [m, expected] of Object.entries(ltbFixture)) {
    const got = sumByMonth.get(m) || 0;
    assert.equal(
      Math.round(got * 100),
      Math.round(parseFloat(expected.budgetedForMonth) * 100),
      `${m}: consolidated sum $${got.toFixed(2)} != ltb budgetedForMonth $${expected.budgetedForMonth}`,
    );
  }
});

test('oracle: SUM consolidation handles CC envelope duplicates (id-dedup)', async () => {
  // The BW API may emit the same CC row twice with different `spent` values.
  // Id-dedup keeps one copy per id; sum then totals what's left.
  const out = await withCapture('oracle-cc', {
    timeframeCategories: { data: [
      { id: 1, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '500.00', spent: '0',       is_cc: true },
      { id: 1, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '500.00', spent: '-500.00', is_cc: true },
    ] },
  });
  assert.equal(out.length, 1);
  // id-dedup keeps one $500.00 row.
  assert.equal(out[0].budgeted, '500.00');
});

test('oracle: SUM consolidation includes all rows for non-CC (no first-wins drop)', async () => {
  // The Category X 122021 case: $230 + $150 → $380. First-wins would drop $150.
  const out = await withCapture('oracle-non-cc', {
    timeframeCategories: { data: [
      { id: 101142, timeframe: '122021', category_id: 'cat-a', budgeted: '230.00', spent: '-115.75', is_cc: false },
      { id: 101143, timeframe: '122021', category_id: 'cat-a', budgeted: '150.00', spent: '-115.75', is_cc: false },
    ] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].budgeted, '380.00');
});
