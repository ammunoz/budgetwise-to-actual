// Tests for lib/recon-report.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareLtbMonths,
  compareAccountBalances,
  reconMarkdown,
  runReconReport,
} from '../lib/recon-report.js';

const LTB_SAMPLE = {
  '012024': {
    incomeForMonth: '1000.00',
    leftToBudget: '200.00',
    fwdFromLastMonth: '50.00',
    budgetedForMonth: '800.00',
    budgetedAhead: '0',
    globalLeftToBudget: '0',
    totalRemaining: '0',
  },
  '022024': {
    incomeForMonth: '1500.50',
    leftToBudget: '0.00',
    fwdFromLastMonth: '200.00',
    budgetedForMonth: '1500.50',
    budgetedAhead: '0',
    globalLeftToBudget: '0',
    totalRemaining: '0',
  },
};

test('compareLtbMonths: matching values -> 0 deltas, 2/2 clean', async () => {
  // 1000.00 income -> 100000 cents; leftToBudget 200 -> 20000 cents
  const getMonth = async (m) => ({
    month: m,
    totalIncome: m === '2024-01-01' ? 100000 : 150050,
    toBudget: m === '2024-01-01' ? 20000 : 0,
    fromLastMonth: m === '2024-01-01' ? 5000 : 20000,
    totalBudgeted: m === '2024-01-01' ? -80000 : -150050,
  });
  const out = await compareLtbMonths(LTB_SAMPLE, getMonth);
  assert.equal(out.summary.monthsChecked, 2);
  assert.equal(out.summary.monthsClean, 2);
  assert.equal(out.summary.maxAbsDelta, 0);
});

test('compareLtbMonths: detects drift in income column', async () => {
  const getMonth = async (m) => ({
    month: m,
    totalIncome: m === '2024-01-01' ? 95000 : 150050, // -$50 in Jan
    toBudget: m === '2024-01-01' ? 20000 : 0,
    fromLastMonth: m === '2024-01-01' ? 5000 : 20000,
    totalBudgeted: m === '2024-01-01' ? -80000 : -150050,
  });
  const out = await compareLtbMonths(LTB_SAMPLE, getMonth);
  assert.equal(out.summary.monthsClean, 1);
  assert.ok(out.summary.maxAbsDelta >= 5000, 'expected delta >= $50 worth of cents');
  const jan = out.rows.find((r) => r.mmyyyy === '012024');
  assert.equal(jan.deltas.income, -5000);
});

test('compareLtbMonths: rejects errors from getMonth per-month', async () => {
  const getMonth = async (m) => {
    if (m === '2024-01-01') throw new Error('db locked');
    return {
      month: m,
      totalIncome: 150050,
      toBudget: 0,
      fromLastMonth: 20000,
      totalBudgeted: -150050,
    };
  };
  const out = await compareLtbMonths(LTB_SAMPLE, getMonth);
  assert.equal(out.summary.monthsClean, 1);
  const jan = out.rows.find((r) => r.mmyyyy === '012024');
  assert.match(jan.deltas.error, /db locked/);
});

test('compareAccountBalances: missing Actual id flagged', async () => {
  const accounts = [
    { id: 'bw1', name: 'Checking', current_bal: '100.50' },
    { id: 'bw2', name: 'Card A', current_bal: '0.00' },
  ];
  const idMap = new Map([['bw1', 'actual1']]); // bw2 missing
  const getBal = async (id) => (id === 'actual1' ? 10050 : 0);
  const out = await compareAccountBalances(accounts, idMap, getBal);
  assert.equal(out.length, 2);
  assert.equal(out[0].bwCents, 10050);
  assert.equal(out[0].actualCents, 10050);
  assert.equal(out[0].deltaCents, 0);
  assert.equal(out[1].missing, true);
});

test('compareAccountBalances: skips null/undefined entries, processes valid ones', async () => {
  // Defensive: null/undefined entries (defensive against malformed capture)
  // are skipped silently rather than causing a crash.
  const out = await compareAccountBalances(
    [null, undefined, { id: 'x', name: 'X', current_bal: '5.00' }],
    new Map([['x', 'a']]),
    async () => 500,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'X');
  assert.equal(out[0].bwCents, 500);
  assert.equal(out[0].actualCents, 500);
});

test('reconMarkdown: renders month table and account table', () => {
  const md = reconMarkdown({
    ltb: {
      rows: [
        { month: '2024-01-01', mmyyyy: '012024',
          bw: { income: 100000, ltb: 20000, fwd: 5000, budgeted: 80000 },
          actual: { income: 100000, ltb: 20000, fwd: 5000, budgeted: -80000 },
          deltas: { income: 0, ltb: 0, fwd: 0, budgeted: 0 } },
      ],
      summary: { monthsChecked: 1, monthsClean: 1, maxAbsDelta: 0 },
    },
    balances: [
      { name: 'Checking', bwCents: 10000, actualCents: 10000, deltaCents: 0 },
    ],
  });
  assert.match(md, /Reconciliation Report/);
  assert.match(md, /Per-account balances/);
  assert.match(md, /Per-month LTB comparison/);
  assert.match(md, /Checking/);
  assert.match(md, /Jan 2024/);
});

test('reconMarkdown: missing capture surface empty-state copy', () => {
  const md = reconMarkdown({ ltb: { rows: [], summary: { monthsChecked: 0, monthsClean: 0, maxAbsDelta: 0 } } });
  assert.match(md, /No LTB data/);
});

test('runReconReport: end-to-end with injected callers', async () => {
  const capture = {
    accounts: { data: [{ id: 'a1', name: 'Checking', current_bal: '123.45' }] },
    ltbBreakdown: LTB_SAMPLE,
  };
  const idMap = new Map([['a1', 'aa1']]);
  const getMonth = async (_m) => ({
    month: _m,
    totalIncome: 100000,
    toBudget: 0,
    fromLastMonth: 0,
    totalBudgeted: -100000,
  });
  const getBalance = async (id) => (id === 'aa1' ? 12345 : 0);
  const out = await runReconReport({ capture, getMonth, getBalanceForAcctId: getBalance, bwIdToActualAcctId: idMap });
  assert.equal(out.ltb.rows.length, 2);
  assert.equal(out.balances.length, 1);
  assert.match(out.markdown, /Reconciliation Report/);
});
