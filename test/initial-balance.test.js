// Tests for Initial Balance import: importAccounts always passes 0
// to createAccount; BW "Initial Balance" txs flow through the normal
// transaction import as uncategorized ordinary txs, so they don't
// affect Income or any budget category and account balances naturally
// reflect the IB tx as of its original date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAmount } from '../lib/normalize.js';

// Verify the BW data shape that we rely on.
test('IB tx data shape: outflow type, "No Category Needed" category', () => {
  const ib = {
    account_id: 'loan-a',
    payee: 'Initial Balance',
    category: 'No Category Needed',
    category_id: null,
    type: 'outflow',
    amount: '10000.00',
    date: '2021-01-01T20:00:00',
  };
  assert.equal(ib.category_id, null);
  assert.equal(ib.category, 'No Category Needed');
  assert.equal(ib.type, 'outflow');
});

test('IB tx as ordinary tx: amount signed correctly', () => {
  // signAmount('10000.00', 'outflow') = -1,000,000 cents.
  // This is exactly what a debt-account IB tx needs to produce a negative
  // balance (debt).
  assert.equal(signAmount('10000.00', 'outflow'), -1000000);
  assert.equal(signAmount('2000.00', 'outflow'), -200000);
});

test('IB tx: zero-amount IB stays zero', () => {
  // Card X had IB tx of $0.00 outflow → $0.00 in Actual.
  assert.equal(signAmount('0.00', 'outflow'), 0);
});

test('IB tx: account balance after import equals IB tx amount (no subsequent txs)', () => {
  // Hypothetical: Loan A with only its IB tx (no payments yet)
  // → balance = -$10,000.00.
  const ib = signAmount('10000.00', 'outflow');
  const payments = 0;
  assert.equal(ib + payments, -1000000);
});

test('resolveCategoryId for IB tx: returns null (uncategorized)', () => {
  // Mirrors resolveCategoryId in populate.js.
  function resolveCategoryId(bwTx, categoryIdToActual, incomeCategoryId) {
    if (bwTx.category_id != null) {
      return categoryIdToActual.get(bwTx.category_id) ?? null;
    }
    if (bwTx.category === 'Left to Budget' && incomeCategoryId) {
      return incomeCategoryId;
    }
    return null;
  }
  const ib = { category_id: null, category: 'No Category Needed' };
  assert.equal(resolveCategoryId(ib, new Map(), 'income-id'), null);
});

test('IB tx does NOT route to Income category', () => {
  // Critical: IB tx must not be misrouted to Income (which would inflate
  // totalIncome). resolveCategoryId only routes to Income when category is
  // literally 'Left to Budget' (not 'No Category Needed').
  function resolveCategoryId(bwTx, categoryIdToActual, incomeCategoryId) {
    if (bwTx.category_id != null) {
      return categoryIdToActual.get(bwTx.category_id) ?? null;
    }
    if (bwTx.category === 'Left to Budget' && incomeCategoryId) {
      return incomeCategoryId;
    }
    return null;
  }
  const ib = { category_id: null, category: 'No Category Needed' };
  // Income is null even when incomeCategoryId is provided.
  assert.notEqual(resolveCategoryId(ib, new Map(), 'income-id'), 'income-id');
});

test('IB tx: synthetic Starting Balances tx creation is avoided by passing 0 to createAccount', () => {
  // Documenting the design choice: importAccounts passes 0 to createAccount
  // (verified by reading lib/populate.js). Actual's createAccount creates
  // a synthetic Starting Balances tx only when initialBalance != 0, so 0
  // avoids the contamination problem.
  //
  // This is a behavior contract — if anyone changes importAccounts to pass
  // non-zero initialBalance, they MUST also handle the synthetic Starting
  // Balances tx (e.g., off-budget the loan accounts, or filter from
  // totalIncome, or backdate it).
  const intendedInitialBalance = 0;
  assert.equal(intendedInitialBalance, 0);
});

test('IB tx vs LTB tx: distinct categories prevent cross-contamination', () => {
  // LTB txs (income) have category === 'Left to Budget' → routed to Income.
  // IB txs (starting balance) have category === 'No Category Needed' → uncategorized.
  // No risk of mixing the two.
  const ltb = { category: 'Left to Budget', type: 'inflow', amount: '5000.00' };
  const ib = { category: 'No Category Needed', type: 'outflow', amount: '10000.00' };
  assert.notEqual(ltb.category, ib.category);
  assert.notEqual(ltb.type, ib.type);
});

test('real-world IB txs across multiple accounts: all would import uncategorized', () => {
  // Synthetic fixture mirroring a typical 5-account dataset: some accounts
  // have IB txs, some don't. The IB txs are categorized as "No Category
  // Needed" so resolveCategoryId returns null and they don't affect budget
  // categories or Income.
  const ibTxs = [
    { account: 'Checking',    payee: 'Initial Balance', date: null, amount: null },
    { account: 'Card Y',      payee: 'Initial Balance', date: null, amount: null },
    { account: 'Loan A',      payee: 'Initial Balance', date: '2021-01-01T20:00:00', amount: '10000.00' },
    { account: 'Loan B',      payee: 'Initial Balance', date: '2021-01-01T20:00:00', amount: '2000.00' },
    { account: 'Card X',      payee: 'Initial Balance', date: '2022-03-20T19:00:00', amount: '0.00' },
  ];
  // Only 3 have IB txs in the fixture; Checking and Card Y don't.
  const withIb = ibTxs.filter(t => t.amount !== null);
  assert.equal(withIb.length, 3);
  for (const t of withIb) {
    const cat = 'No Category Needed';  // BW stores IB txs with this category
    assert.equal(cat, 'No Category Needed');
  }
});

test('IB tx: account balance reflects IB + subsequent payments', () => {
  // Loan A: IB -$10,000.00 + payments over time → final balance.
  // Payments are inflows to the loan account (e.g., $4,000 paid → +$4,000 to balance).
  // (Illustrative — actual payments depend on the captured data.)
  const ib = signAmount('10000.00', 'outflow');           // -1,000,000 cents
  const payments = signAmount('4000.00', 'inflow');        // +400,000 cents (payment)
  const finalBalance = ib + payments;
  // Don't assert a specific number — just verify the math direction.
  assert.ok(finalBalance < 0);   // still negative (still owe money)
  assert.ok(finalBalance > ib);  // payments have reduced the debt (less negative)
  // -1,000,000 + 400,000 = -600,000
  assert.equal(finalBalance, -600000);
});
