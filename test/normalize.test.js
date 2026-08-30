// Tests for lib/normalize.js — sign conversion, date parsing, MMYYYY conversion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, signAmount, toISODate, buildTransferSkipSet } from '../lib/normalize.js';

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
