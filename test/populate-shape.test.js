// Tests for lib/populate.js — verify the populate() return shape.
// Regression for the BLOCKED finding: per-account balance reconciliation
// silently produced "missing" for every account because populate() did not
// expose accountIdToActual.
//
// These tests use Node's `--experimental-test-module-mocks` to stub
// @actual-app/api. The populate() function makes many distinct calls
// (createCategoryGroup, createCategory, createPayee, createAccount,
// addTransactions, etc.); we stub each with a no-op that returns a
// predictable id, then assert that the returned shape threads the BW→Actual
// id maps through.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const apiStub = {
  // Phase A: category groups + categories
  createCategoryGroup: mock.fn(async ({ name }) => `grp-${name}`),
  createCategory: mock.fn(async ({ name }) => `cat-${name}`),
  // Phase B: payees
  createPayee: mock.fn(async ({ name }) => `pay-${name}`),
  // Phase B.5: ensure Income
  getCategories: mock.fn(async () => [
    { id: 'income-cat', name: 'Income', is_income: true },
  ]),
  getCategoryGroups: mock.fn(async () => [
    { id: 'income-grp', name: 'Income', is_income: true },
  ]),
  // Phase C: accounts
  createAccount: mock.fn(async ({ name }) => `acct-${name}`),
  // Phase C.5: transfers (called from importTransactions -> ensureTransferPayees)
  getAccounts: mock.fn(async () => [
    { id: 'acct-Checking', name: 'Checking' },
    { id: 'acct-Card A', name: 'Card A' },
  ]),
  // Phase C.5: transfers
  getPayees: mock.fn(async () => []),
  // Phase E: transactions
  addTransactions: mock.fn(async () => 'ok'),
  getTransactions: mock.fn(async () => []),
  getAccountBalance: mock.fn(async () => 0),
  // runImport is the top-level wrapper; runImport(name, fn) just calls fn()
  runImport: mock.fn(async (_name, fn) => { await fn(); }),
  batchBudgetUpdates: mock.fn(async (fn) => { await fn(); }),
  setBudgetAmount: mock.fn(async () => {}),
  getBudgetMonth: mock.fn(async () => ({
    month: '2024-01-01', totalIncome: 0, toBudget: 0, fromLastMonth: 0, totalBudgeted: 0,
  })),
  lib: { send: mock.fn(async () => {}) },
};

mock.module('@actual-app/api', {
  namedExports: apiStub,
});

const { populate } = await import('../lib/populate.js');

const sampleCapture = {
  accounts: { data: [
    { id: 'bw-debit', name: 'Checking', offbudget: false, type: 'checking' },
    { id: 'bw-visa', name: 'Card A', offbudget: false, type: 'creditcard' },
  ] },
  categories: { data: [
    { id: 'bw-rent', name: 'Rent', section_id: 's1', is_income: false },
    { id: 'bw-salary', name: 'Salary', section_id: 's1', is_income: true },
  ] },
  sections: { data: [
    { id: 's1', name: 'Bills', subcategories_order: ['bw-rent', 'bw-salary'] },
  ] },
  payees: { data: [
    { name: 'Landlord' },
  ] },
  transactions: { data: [
    // Empty transaction list keeps the rest of populate quiet.
  ] },
  timeframeCategories: null,
  manifest: null,
};

test('populate() return shape: accountIdToActual is a populated Map', async () => {
  const result = await populate(sampleCapture);
  assert.ok(result, 'populate must return a result');
  assert.ok(result.accountIdToActual instanceof Map, 'accountIdToActual must be a Map');
  assert.equal(result.accountIdToActual.size, 2);
  // Each BW account id must map to an Actual account id (any non-empty string).
  assert.ok(result.accountIdToActual.has('bw-debit'));
  assert.ok(result.accountIdToActual.has('bw-visa'));
  for (const v of result.accountIdToActual.values()) {
    assert.ok(typeof v === 'string' && v.length > 0);
  }
});

test('populate() return shape: categoryIdToActual is a populated Map', async () => {
  // Sanity check: the existing categoryIdToActual exposure still works.
  const result = await populate(sampleCapture);
  assert.ok(result.categoryIdToActual instanceof Map);
  assert.ok(result.categoryIdToActual.has('bw-rent'));
  assert.ok(result.categoryIdToActual.has('bw-salary'));
});

test('populate() return shape: scalar counts still populated', async () => {
  const result = await populate(sampleCapture);
  assert.equal(typeof result.accounts, 'number');
  assert.equal(typeof result.categories, 'number');
  assert.equal(typeof result.payees, 'number');
  assert.equal(typeof result.transactions, 'number');
  assert.equal(typeof result.splits, 'number');
  assert.equal(typeof result.skipIds, 'number');
  assert.equal(result.budgetEntries, 0); // filled in by post-runImport phase
});
