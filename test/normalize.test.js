// Tests for lib/normalize.js — sign conversion, date parsing, MMYYYY conversion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, signAmount, toISODate, shiftISODateMonths, buildTransferSkipSet } from '../lib/normalize.js';

test('toCents: positive string', () => {
  assert.equal(toCents('198.33'), 19833);
});

test('toCents: negative string', () => {
  assert.equal(toCents('-12.00'), -1200);
});

test('toCents: zero', () => {
  assert.equal(toCents('0'), 0);
  assert.equal(toCents('0.00'), 0);
});

test('toCents: rounds to nearest cent', () => {
  // Math.round in JS rounds half to even for floats (1.005*100 = 100.49999...).
  // This documents the actual behavior — sign of the amount matters for sign flips.
  assert.equal(toCents('1.004'), 100);
  assert.equal(toCents('1.50'), 150);
  assert.equal(toCents('1.51'), 151);
});

test('toCents: numeric input', () => {
  assert.equal(toCents(198.33), 19833);
});

test('toCents: throws on non-numeric', () => {
  assert.throws(() => toCents('abc'), /Non-numeric/);
});

test('signAmount: outflow + positive amount → negative cents', () => {
  assert.equal(signAmount('100.00', 'outflow'), -10000);
});

test('signAmount: inflow + positive amount → positive cents', () => {
  assert.equal(signAmount('100.00', 'inflow'), 10000);
});

test('signAmount: outflow + negative string → positive cents', () => {
  // Edge case: Budgetwise shouldn't give us this, but handle it
  assert.equal(signAmount('-100.00', 'outflow'), 10000);
});

test('signAmount: zero is zero', () => {
  assert.equal(signAmount('0.00', 'outflow'), 0);
  assert.equal(signAmount('0.00', 'inflow'), 0);
});

test('signAmount: real-world Budgetwise values', () => {
  // Honda transaction: outflow $100
  assert.equal(signAmount('100.00', 'outflow'), -10000);
  // Account initial balance as inflow
  assert.equal(signAmount('1000.00', 'inflow'), 100000);
});

test('toISODate: strips time portion', () => {
  assert.equal(toISODate('2026-06-08T12:00:00.000Z'), '2026-06-08');
  assert.equal(toISODate('2026-06-08'), '2026-06-08');
  assert.equal(toISODate('2026-06-08T00:00:00Z'), '2026-06-08');
});

test('toISODate: non-string passthrough', () => {
  assert.equal(toISODate(123), 123);
  assert.equal(toISODate(null), null);
});

test('buildTransferSkipSet: excludes inflow halves', () => {
  const txs = [
    { id: 'a', transfer_origin_transaction_id: 'b' },  // inflow half
    { id: 'b', transfer_target_transaction_id: 'a' },  // outflow half
    { id: 'c', transfer_target_transaction_id: 'd' },
    { id: 'd', transfer_origin_transaction_id: 'c' },
    { id: 'e' },  // ordinary
  ];
  const skip = buildTransferSkipSet(txs);
  assert.deepEqual([...skip].sort(), ['a', 'd']);
});

test('buildTransferSkipSet: handles no transfers', () => {
  const txs = [{ id: 'a' }, { id: 'b' }];
  const skip = buildTransferSkipSet(txs);
  assert.equal(skip.size, 0);
});

test('buildTransferSkipSet: handles empty input', () => {
  assert.equal(buildTransferSkipSet([]).size, 0);
});

// =========================================================================
// shiftISODateMonths — used by populate.js to honor Budgetwise's `ltb_next`
// semantics (income attributed to next month).
// =========================================================================
test('shiftISODateMonths: +1 month within same year', () => {
  assert.equal(shiftISODateMonths('2026-05-22'), '2026-06-22');
});

test('shiftISODateMonths: +1 month across year boundary (Dec → Jan)', () => {
  assert.equal(shiftISODateMonths('2026-12-15'), '2027-01-15');
});

test('shiftISODateMonths: +1 month across year boundary (Jan → Feb, year rollover)', () => {
  // After shifting Jan to Feb, year stays the same — but if shifting back
  // (negative delta), Dec → Nov wraps the year.
  assert.equal(shiftISODateMonths('2027-01-01', -1), '2026-12-01');
});

test('shiftISODateMonths: delta=0 is a no-op', () => {
  assert.equal(shiftISODateMonths('2026-05-22', 0), '2026-05-22');
});

test('shiftISODateMonths: clamps day to last valid day of target month', () => {
  // Without clamping, "2024-05-31" + 1 = "2024-06-31" (invalid). Actual
  // accepts the invalid string but the transaction is silently dropped from
  // every month's `sum-amount`, propagating a missing-income gap through
  // the cumulative carryover chain. See CHANGELOG 0.1.4.
  assert.equal(shiftISODateMonths('2024-05-31', 1), '2024-06-30');
  assert.equal(shiftISODateMonths('2023-03-31', 1), '2023-04-30');
  assert.equal(shiftISODateMonths('2022-03-31', 1), '2022-04-30');
  assert.equal(shiftISODateMonths('2025-01-31', 1), '2025-02-28');
});

test('shiftISODateMonths: day=30 in 30-day months stays 30', () => {
  // Apr/Jun/Sep/Nov have 30 days; May 30 + 1 should land on June 30 (not 31).
  assert.equal(shiftISODateMonths('2024-05-30', 1), '2024-06-30');
  assert.equal(shiftISODateMonths('2024-08-30', 1), '2024-09-30');
});

test('shiftISODateMonths: leap-year Feb 29 clamps correctly', () => {
  // Jan 31 in a leap year + 1 = Feb 29 (not 28).
  assert.equal(shiftISODateMonths('2024-01-31', 1), '2024-02-29');
  // Jan 31 in a non-leap year + 1 = Feb 28.
  assert.equal(shiftISODateMonths('2023-01-31', 1), '2023-02-28');
  // Feb 29 + 12 months in next year (non-leap) = Feb 28.
  assert.equal(shiftISODateMonths('2024-02-29', 12), '2025-02-28');
});

test('shiftISODateMonths: Dec 31 + 1 = Jan 31 (valid rollover, not clamped)', () => {
  // Guards against over-clamping — Jan always has 31 days.
  assert.equal(shiftISODateMonths('2024-12-31', 1), '2025-01-31');
  assert.equal(shiftISODateMonths('2026-12-31', 1), '2027-01-31');
});

test('shiftISODateMonths: day=29 clamps to 28 in non-leap Feb', () => {
  assert.equal(shiftISODateMonths('2023-01-29', 1), '2023-02-28');
  assert.equal(shiftISODateMonths('2023-01-30', 1), '2023-02-28');
});

test('shiftISODateMonths: non-string passthrough', () => {
  assert.equal(shiftISODateMonths(null), null);
  assert.equal(shiftISODateMonths(123), 123);
  assert.equal(shiftISODateMonths('not-a-date'), 'not-a-date');
});
