// Tests for lib/cc-notes.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccNotes, ccPaymentRows } from '../lib/cc-notes.js';

test('ccPaymentRows: sums CC rows by (timeframe, cc_account_id), id-dedup', () => {
  const tfc = {
    data: [
      [
        { id: 1, timeframe: '012024', category_id: 'rent', budgeted: '1000', is_cc: false },
        // CC rows with same id and same budgeted (BW envelope duplicate)
        { id: 50, timeframe: '012024', cc_account_id: 'ccA', budgeted: '300', is_cc: true },
        { id: 50, timeframe: '012024', cc_account_id: 'ccA', budgeted: '300', is_cc: true, spent: '999' },
      ],
      [
        // Different id, same key — additive per BW's SUM rule for non-CC; but
        // the cc branch id-dedupes first so this should NOT add. Wait, the
        // duplicate-CC logic here id-dedupes both branches. Read comment.
        { id: 51, timeframe: '012024', cc_account_id: 'ccA', budgeted: '500', is_cc: true },
      ],
    ],
  };
  const rows = ccPaymentRows(tfc);
  // Two distinct ids → both summed: 300 + 500 = 800
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ccAccountId, 'ccA');
  assert.equal(rows[0].timeFrame, '012024');
  assert.equal(rows[0].budgeted, 800);
});

test('ccPaymentRows: skips CC rows missing cc_account_id or timeframe', () => {
  const tfc = { data: [
    { id: 1, timeframe: '012024', is_cc: true, budgeted: '100' }, // no cc_account_id
    { id: 2, cc_account_id: 'ccA', is_cc: true, budgeted: '100' }, // no timeframe
  ] };
  assert.equal(ccPaymentRows(tfc).length, 0);
});

test('ccPaymentRows: empty/non-array inputs', () => {
  assert.deepEqual(ccPaymentRows(null), []);
  assert.deepEqual(ccPaymentRows({}), []);
});

test('ccNotes: zero CC accounts -> explanatory note, no tables', () => {
  const md = ccNotes({ accounts: { data: [] }, timeframeCategories: null });
  assert.match(md, /No .is_cc. budget rows/);
  assert.doesNotMatch(md, /referenced by CC-style payment rows/);
});

test('ccNotes: surfaces per-account CC budget rows', () => {
  const capture = {
    accounts: { data: [
      { id: 'ccA', name: 'Card A', type: 'creditcard' },
      { id: 'chk', name: 'Checking', type: 'checking' },
    ] },
    timeframeCategories: { data: [
      { id: 1, timeframe: '012024', cc_account_id: 'ccA', budgeted: '300', is_cc: true },
      { id: 2, timeframe: '022024', cc_account_id: 'ccA', budgeted: '250', is_cc: true },
    ] },
  };
  const md = ccNotes(capture);
  assert.match(md, /1 account\(s\) referenced by CC-style payment rows/);
  assert.match(md, /\*\*Card A\*\*/);
  assert.match(md, /Jan 2024/);
  assert.match(md, /\$300\.00/);
  assert.match(md, /Feb 2024/);
  assert.match(md, /\$250\.00/);
  assert.match(md, /Total over 2 months: \*\*\$550\.00\*\*/);
  assert.match(md, /What to expect in Actual/);
});

test('ccNotes: multiple CC accounts get separate tables, credit type labeled', () => {
  const capture = {
    accounts: { data: [
      { id: 'visa', name: 'Card A', type: 'creditcard' },
      { id: 'amex', name: 'Card B', type: 'creditcard' },
      { id: 'loan', name: 'Student Loan', type: 'debtother' },
    ] },
    timeframeCategories: { data: [
      { id: 1, timeframe: '012024', cc_account_id: 'visa', budgeted: '100', is_cc: true },
      { id: 2, timeframe: '012024', cc_account_id: 'amex', budgeted: '200', is_cc: true },
      { id: 3, timeframe: '012024', cc_account_id: 'loan', budgeted: '50', is_cc: true },
    ] },
  };
  const md = ccNotes(capture);
  assert.match(md, /### Card A/);
  assert.match(md, /### Card B/);
  assert.match(md, /### Student Loan/);
  assert.match(md, /\*\*Credit card\*\*/);  // first two are credit cards
  assert.match(md, /_Other type: .debtother._/);  // last is debt type
  assert.match(md, /3 account\(s\) referenced by CC-style payment rows/);
});

test('ccNotes: orphan CC ids (referenced but absent from accounts.json) listed', () => {
  const capture = {
    accounts: { data: [
      { id: 'visa', name: 'Card A', type: 'creditcard' },
    ] },
    timeframeCategories: { data: [
      { id: 1, timeframe: '012024', cc_account_id: 'visa', budgeted: '100', is_cc: true },
      // This account is referenced by an is_cc row but is NOT in accounts.json.
      { id: 2, timeframe: '012024', cc_account_id: 'orphan-uuid-xxx', budgeted: '50', is_cc: true },
    ] },
  };
  const md = ccNotes(capture);
  // The orphan should appear in the table...
  assert.match(md, /orphan-uuid-xxx/);
  // ...and be flagged in the "Unlisted accounts" section.
  assert.match(md, /Unlisted accounts.*referenced but not in accounts\.json/s);
  assert.match(md, /- `orphan-uuid-xxx`/);
});
