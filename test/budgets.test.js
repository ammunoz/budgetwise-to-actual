// Tests for lib/budgets.js — the single source of truth for per-cell
// budget expectations and verification. Both the import writer and any
// post-import validation consume these functions, so they cannot diverge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedBudgetEntries, validateBudgets, fixDrift, formatDriftCell } from '../lib/budgets.js';

const catIdMap = new Map([
  ['bw-rent', 'actual-rent'],
  ['bw-groceries', 'actual-groceries'],
  ['bw-tfsa', 'actual-tfsa'],
]);

function capture(entries) {
  // mimic loadCapture's output for timeframeCategories after dedup
  return { timeframeCategories: { data: entries } };
}

test('expectedBudgetEntries: basic case', () => {
  const out = expectedBudgetEntries(capture([
    { id: 1, timeframe: '012021', category_id: 'bw-rent', budgeted: '1750.00', is_cc: false, spent: '0' },
    { id: 2, timeframe: '012021', category_id: 'bw-groceries', budgeted: '167.56', is_cc: false, spent: '0' },
  ]), catIdMap);
  assert.equal(out.length, 2);
  assert.deepEqual(out, [
    { month: '2021-01-01', catId: 'actual-rent', cents: 175000 },
    { month: '2021-01-01', catId: 'actual-groceries', cents: 16756 },
  ]);
});

test('expectedBudgetEntries: skips CC entries', () => {
  const out = expectedBudgetEntries(capture([
    { id: 1, timeframe: '012021', category_id: 'bw-rent', budgeted: '1750.00', is_cc: false },
    { id: 2, timeframe: '012021', category_id: null, cc_account_id: 'cc1', budgeted: '500.00', is_cc: true },
  ]), catIdMap);
  assert.equal(out.length, 1);
  assert.equal(out[0].catId, 'actual-rent');
});

test('expectedBudgetEntries: skips entries without category_id', () => {
  const out = expectedBudgetEntries(capture([
    { id: 1, timeframe: '012021', category_id: null, budgeted: '500.00', is_cc: false },
    { id: 2, timeframe: '012021', category_id: 'bw-rent', budgeted: '1750.00', is_cc: false },
  ]), catIdMap);
  assert.equal(out.length, 1);
  assert.equal(out[0].catId, 'actual-rent');
});

test('expectedBudgetEntries: skips entries with category_id not in mapping', () => {
  const out = expectedBudgetEntries(capture([
    { id: 1, timeframe: '012021', category_id: 'bw-rent', budgeted: '1750.00', is_cc: false },
    { id: 2, timeframe: '012021', category_id: 'bw-deleted-cat', budgeted: '500.00', is_cc: false },
  ]), catIdMap);
  assert.equal(out.length, 1);
  assert.equal(out[0].catId, 'actual-rent');
});

test('expectedBudgetEntries: skips malformed timeframes', () => {
  const out = expectedBudgetEntries(capture([
    { id: 1, timeframe: '012021', category_id: 'bw-rent', budgeted: '1750.00', is_cc: false },
    { id: 2, timeframe: 'bad',     category_id: 'bw-rent', budgeted: '999.00', is_cc: false },
    { id: 3, timeframe: '',        category_id: 'bw-rent', budgeted: '999.00', is_cc: false },
  ]), catIdMap);
  assert.equal(out.length, 1);
});

test('expectedBudgetEntries: rounds to nearest cent', () => {
  // expectedBudgetEntries assumes dedup has already happened (lib/reader.js
  // dedupTimeframeCategories runs first). One entry per (month, cat).
  const out = expectedBudgetEntries(capture([
    { id: 1, timeframe: '012021', category_id: 'bw-rent', budgeted: '100.005', is_cc: false },
    { id: 2, timeframe: '012021', category_id: 'bw-rent', budgeted: '100.004', is_cc: false },
  ]), catIdMap);
  // The dedup is NOT done by expectedBudgetEntries — both rows survive here.
  // Verify the rounding of each: 100.005 → 10001 (JS Math.round half-up),
  // 100.004 → 10000.
  assert.equal(out.length, 2);
  const cents = out.map(e => e.cents).sort();
  assert.deepEqual(cents, [10000, 10001]);
});

test('expectedBudgetEntries: handles nested group envelope', () => {
  // The raw Budgetwise response can be {data: [[...],[...]]}. expectedBudgetEntries
  // should flatten transparently and treat it the same as a flat array.
  const wrapped = { timeframeCategories: { data: [
    [
      { id: 1, timeframe: '012021', category_id: 'bw-rent', budgeted: '1750.00', is_cc: false },
    ],
    [
      { id: 2, timeframe: '012021', category_id: null, cc_account_id: 'cc1', budgeted: '500.00', is_cc: true },
    ],
  ] } };
  const out = expectedBudgetEntries(wrapped, catIdMap);
  assert.equal(out.length, 1);
  assert.equal(out[0].catId, 'actual-rent');
});

test('validateBudgets: matching entries → no drift', async () => {
  const entries = [
    { month: '2021-01-01', catId: 'actual-rent', cents: 175000 },
    { month: '2021-01-01', catId: 'actual-groceries', cents: 16756 },
  ];
  const getMonth = async (m) => ({
    categoryGroups: [
      { categories: [
        { id: 'actual-rent', budgeted: 175000 },
        { id: 'actual-groceries', budgeted: 16756 },
      ] },
    ],
  });
  const { checked, drift } = await validateBudgets(entries, { getMonth });
  assert.equal(checked, 2);
  assert.equal(drift.length, 0);
});

test('validateBudgets: detects drift', async () => {
  const entries = [
    { month: '2021-01-01', catId: 'actual-rent', cents: 175000 },
    { month: '2021-01-01', catId: 'actual-groceries', cents: 16756 },
  ];
  const getMonth = async (m) => ({
    categoryGroups: [
      { categories: [
        { id: 'actual-rent', budgeted: 0 },         // drift: Actual has $0
        { id: 'actual-groceries', budgeted: 16756 },
      ] },
    ],
  });
  const { checked, drift } = await validateBudgets(entries, { getMonth });
  assert.equal(checked, 2);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].catId, 'actual-rent');
  assert.equal(drift[0].expected, 175000);
  assert.equal(drift[0].actual, 0);
});

test('validateBudgets: months filter limits the sweep', async () => {
  const entries = [
    { month: '2021-01-01', catId: 'actual-rent', cents: 175000 },
    { month: '2021-02-01', catId: 'actual-rent', cents: 175000 },
  ];
  const calls = [];
  const getMonth = async (m) => {
    calls.push(m);
    return { categoryGroups: [{ categories: [{ id: 'actual-rent', budgeted: 175000 }] }] };
  };
  const { checked } = await validateBudgets(entries, { months: ['2021-01'], getMonth });
  assert.equal(checked, 1);
  assert.deepEqual(calls, ['2021-01-01']);
});

test('validateBudgets: cats filter limits the sweep', async () => {
  const entries = [
    { month: '2021-01-01', catId: 'actual-rent', cents: 175000 },
    { month: '2021-01-01', catId: 'actual-groceries', cents: 16756 },
  ];
  const getMonth = async (m) => ({
    categoryGroups: [{ categories: [
      { id: 'actual-rent', budgeted: 175000 },
      { id: 'actual-groceries', budgeted: 16756 },
    ] }],
  });
  const { checked } = await validateBudgets(entries, {
    cats: new Set(['actual-rent']),
    getMonth,
  });
  assert.equal(checked, 1);
});

test('fixDrift: calls setBudget for each drifted cell', async () => {
  const drift = [
    { month: '2021-01-01', catId: 'actual-rent', expected: 175000, actual: 0 },
    { month: '2021-01-01', catId: 'actual-groceries', expected: 16756, actual: 100 },
  ];
  const calls = [];
  const { fixed, unfixable } = await fixDrift(drift, {
    setBudget: async (month, catId, cents) => {
      calls.push({ month, catId, cents });
    },
  });
  assert.equal(fixed.length, 2);
  assert.equal(unfixable.length, 0);
  assert.deepEqual(calls, [
    { month: '2021-01-01', catId: 'actual-rent', cents: 175000 },
    { month: '2021-01-01', catId: 'actual-groceries', cents: 16756 },
  ]);
});

test('fixDrift: catches setBudget failures', async () => {
  const drift = [
    { month: '2021-01-01', catId: 'actual-rent', expected: 175000, actual: 0 },
    { month: '2021-01-01', catId: 'actual-broken', expected: 100, actual: 0 },
  ];
  const { fixed, unfixable } = await fixDrift(drift, {
    setBudget: async (month, catId, cents) => {
      if (catId === 'actual-broken') throw new Error('boom');
    },
  });
  assert.equal(fixed.length, 1);
  assert.equal(unfixable.length, 1);
  assert.match(unfixable[0].error, /boom/);
});

test('formatDriftCell: human-readable', () => {
  const s = formatDriftCell({
    month: '2021-01-01',
    catId: 'actual-rent',
    expected: 175000,
    actual: 0,
  }, { catName: 'Rent' });
  // Formatted with padded columns — strip the padding for regex match.
  assert.match(s, /2021-01-01/);
  assert.match(s, /Rent/);
  assert.match(s.replace(/\s+/g, ''), /\$1750\.00/);
  assert.match(s.replace(/\s+/g, ''), /\$0\.00/);
});