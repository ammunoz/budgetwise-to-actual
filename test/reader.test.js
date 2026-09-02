// Tests for lib/reader.js payee dedup logic.
//
// We exercise dedupPayees directly (it's not exported, so we re-implement
// the smallest possible test surface by going through loadCapture).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture, unwrap } from '../lib/reader.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
// (unwrap is re-used below for tfc dedup tests)

async function withCapture(name, captureData) {
  const dir = resolve(tmpdir(), `bw2a-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  // loadCapture requires accounts, categories, transactions. Fill in defaults
  // for any that the test doesn't provide.
  const required = {
    accounts: { data: [] },
    categories: { data: [] },
    transactions: { data: [] },
    ...captureData,
  };
  for (const [filename, data] of Object.entries(required)) {
    await writeFile(resolve(dir, `${filename}.json`), JSON.stringify(data));
  }
  try {
    const cap = await loadCapture(dir);
    return unwrap(cap.payees);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('dedup: no duplicates — pass-through', async () => {
  const out = await withCapture('pass', {
    payees: { data: [
      { id: '1', name: 'Amazon' },
      { id: '2', name: 'Costco' },
    ] },
    transactions: { data: [] },
  });
  assert.equal(out.length, 2);
});

test('dedup: exact-name duplicates collapsed', async () => {
  const out = await withCapture('exact', {
    payees: { data: [
      { id: '1', name: 'Square One Insurance' },
      { id: '2', name: 'Square One Insurance' },
      { id: '3', name: 'Square One Insurance' },
      { id: '4', name: 'Costco' },
    ] },
    transactions: { data: [] },
  });
  // 3 duplicates collapsed to 1
  assert.equal(out.length, 2);
  assert.ok(out.some(p => p.name === 'Square One Insurance'));
  assert.ok(out.some(p => p.name === 'Costco'));
});

test('dedup: case-insensitive merges pick variant with most transaction usage', async () => {
  const out = await withCapture('case', {
    payees: { data: [
      { id: 'a', name: 'McDonald\'s' },
      { id: 'b', name: 'mcdonalds' },
      { id: 'c', name: 'Wendy\'s' },
      { id: 'd', name: 'wendys' },
    ] },
    transactions: { data: [
      { payee: 'McDonald\'s' },
      { payee: 'McDonald\'s' },
      { payee: 'McDonald\'s' },
      // mcdonalds: 0 transactions
      { payee: 'Wendy\'s' },
      // wendys: 0 transactions
    ] },
  });
  assert.equal(out.length, 2);
  assert.ok(out.some(p => p.name === 'McDonald\'s'));
  assert.ok(out.some(p => p.name === 'Wendy\'s'));
});

test('dedup: no fuzzy candidates to merge — substring pairs preserved', async () => {
  // 'Big White' and 'Big White Ski Resort' are different vendors — don't merge.
  const out = await withCapture('fuzzy', {
    payees: { data: [
      { id: 'a', name: 'Big White' },
      { id: 'b', name: 'Big White Ski Resort' },
      { id: 'c', name: 'impar' },
      { id: 'd', name: 'impark' },
    ] },
    transactions: { data: [] },
  });
  // No case overlap, no edits ≤ 2 with same first char — both pairs preserved.
  assert.equal(out.length, 4);
});

test('dedup: respects first-seen order on usage tie', async () => {
  const out = await withCapture('tie', {
    payees: { data: [
      { id: 'first', name: 'Twice' },       // seen first
      { id: 'second', name: 'TWICE' },     // same usage, same case-fold
    ] },
    transactions: { data: [
      { payee: 'Twice' },
      { payee: 'TWICE' },
    ] },
  });
  // Tie → first-seen wins (deterministic)
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Twice');
});

// =========================================================================
// Budget row consolidation (dedupTimeframeCategories)
// =========================================================================
// Budgetwise's `/timeframe_categories` endpoint returns one row per save —
// re-saving an unchanged budget creates a new row with the same category,
// month, and a fresh id. The import must consolidate these rows so that
// setBudgetAmount's last-write-wins behavior doesn't overwrite the real
// budgeted value with whatever the last row happens to be (often a trailing
// $0 echo, silently zeroing out budgets).
//
// The consolidation rule is SUM per (timeframe, category_id), with id-dedup
// applied to CC rows first (the BW API may emit the same CC row twice in the
// envelope with different `spent` values; the `budgeted` value is identical
// and should count once). Verified via an oracle script that matches the
// capture's ltbBreakdown.budgetedForMonth totals for 81/81 months.

async function withTfc(name, timeframeCategories) {
  const dir = resolve(tmpdir(), `bw2a-test-tfc-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const required = {
    accounts: { data: [] },
    categories: { data: [] },
    transactions: { data: [] },
    timeframeCategories,
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

test('tfc dedup: no duplicates — passthrough', async () => {
  const out = await withTfc('passthrough', { data: [
    { id: 1, timeframe: '012021', category_id: 'c1', budgeted: '10.00', spent: '0', is_cc: false },
    { id: 2, timeframe: '012021', category_id: 'c2', budgeted: '20.00', spent: '0', is_cc: false },
  ] });
  assert.equal(out.length, 2);
});

test('tfc dedup: $X + $0 trailing — sums to $X', async () => {
  // Real-world pattern: Budgetwise echoes the row with $0 when only `spent` changes.
  // SUM of $X + $0 + $0 = $X (same as first-wins in this pattern).
  const out = await withTfc('echo', { data: [
    { id: 95194, timeframe: '042021', category_id: 'c1', budgeted: '10.00', spent: '-10.00', is_cc: false },
    { id: 96048, timeframe: '042021', category_id: 'c1', budgeted: '0.00',  spent: '-10.00', is_cc: false },
    { id: 96049, timeframe: '042021', category_id: 'c1', budgeted: '0.00',  spent: '-10.00', is_cc: false },
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 95194);
  assert.equal(out[0].budgeted, '10.00');
});

test('tfc dedup: $230 + $150 — sums to $380', async () => {
  // The distinguishing case for the SUM rule. Real-world: Category X 122021.
  // First-wins ($230) and last-wins ($150) would both drop real money;
  // SUM captures the full $380 that Budgetwise's ltbBreakdown expects.
  const out = await withTfc('edit', { data: [
    { id: 101142, timeframe: '122021', category_id: 'cat-a', budgeted: '230.00', spent: '-115.75', is_cc: false },
    { id: 101143, timeframe: '122021', category_id: 'cat-a', budgeted: '150.00', spent: '-115.75', is_cc: false },
  ] });
  assert.equal(out.length, 1);
  // First-seen metadata wins; budgeted is the sum.
  assert.equal(out[0].id, 101142);
  assert.equal(out[0].budgeted, '380.00');
  assert.equal(out[0].spent, '-115.75');
});

test('tfc dedup: is_cc rows summed with cc_account_id key', async () => {
  // CC rows have category_id === null; key on cc_account_id to consolidate them.
  // SUM of $500 + $0 = $500 for cc1; $300 for cc2.
  const out = await withTfc('cc', { data: [
    { id: 100, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '500.00', is_cc: true },
    { id: 101, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '0.00',   is_cc: true },
    { id: 200, timeframe: '012021', cc_account_id: 'cc2', category_id: null, budgeted: '300.00', is_cc: true },
  ] });
  assert.equal(out.length, 2);
  const cc1 = out.find(e => e.cc_account_id === 'cc1');
  assert.equal(cc1.id, 100);
  assert.equal(cc1.budgeted, '500.00');
  const cc2 = out.find(e => e.cc_account_id === 'cc2');
  assert.equal(cc2.budgeted, '300.00');
});

test('tfc dedup: CC rows id-deduped before sum (envelope duplicates)', async () => {
  // The BW API may emit the same CC row twice with different `spent` values
  // (e.g., a "before spend" snapshot and an "after spend" snapshot). The
  // `budgeted` value is identical and should count once. Without id-dedup,
  // SUM would double-count these rows.
  const out = await withTfc('cc-id-dedup', { data: [
    { id: 100, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '500.00', spent: '0',      is_cc: true },
    { id: 100, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '500.00', spent: '-500.00', is_cc: true },
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].budgeted, '500.00');
});

test('tfc dedup: SUM is order-invariant', async () => {
  // SUM doesn't depend on row order, so reversed input gives the same result.
  const out = await withTfc('order', { data: [
    { id: 101143, timeframe: '122021', category_id: 'cat-a', budgeted: '150.00', spent: '-115.75', is_cc: false },
    { id: 101142, timeframe: '122021', category_id: 'cat-a', budgeted: '230.00', spent: '-115.75', is_cc: false },
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].budgeted, '380.00');
  // First-seen metadata still wins (id 101143 in this input order), but
  // budgeted is invariant.
});

test('tfc dedup: nested group envelope ({data: [[...],[...]]}) flattens before dedup', async () => {
  // The actual Budgetwise response wraps entries in 2 groups (non-CC and CC).
  // Both layers must be flattened so a cat entry and a cc entry with the
  // same numeric id (across groups) don't collide on the id-based winner test.
  const out = await withTfc('envelope', { data: [
    [
      { id: 1, timeframe: '012021', category_id: 'c1', budgeted: '10.00', is_cc: false },
      { id: 2, timeframe: '012021', category_id: 'c1', budgeted: '0.00',  is_cc: false },
    ],
    [
      { id: 1, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '500.00', is_cc: true },
      { id: 2, timeframe: '012021', cc_account_id: 'cc1', category_id: null, budgeted: '0.00',   is_cc: true },
    ],
  ] });
  assert.equal(out.length, 2);
  const cat = out.find(e => e.category_id === 'c1');
  const cc = out.find(e => e.cc_account_id === 'cc1');
  assert.equal(cat.budgeted, '10.00');
  assert.equal(cc.budgeted, '500.00');
});
