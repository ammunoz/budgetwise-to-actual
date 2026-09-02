// Tests for lib/budget-mgmt.js — file-name collision handling for the
// import tool. The current @actual-app/api has no in-place replace, so
// resolveUniqueBudgetName picks the next free counter suffix to avoid
// creating duplicate-looking entries on the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUniqueBudgetName } from '../lib/budget-mgmt.js';

// Pass an explicit file list as the second arg — keeps the test pure
// (no monkey-patching the ESM module).

test('resolveUniqueBudgetName: base name available -> returns base name', async () => {
  const existing = [{ name: 'OtherBudget' }, { name: 'Foo' }];
  assert.equal(await resolveUniqueBudgetName('Budget', existing), 'Budget');
});

test('resolveUniqueBudgetName: base name taken -> appends -2', async () => {
  const existing = [{ name: 'Budget' }];
  assert.equal(await resolveUniqueBudgetName('Budget', existing), 'Budget-2');
});

test('resolveUniqueBudgetName: base + -2 taken -> returns -3', async () => {
  const existing = [{ name: 'Budget' }, { name: 'Budget-2' }];
  assert.equal(await resolveUniqueBudgetName('Budget', existing), 'Budget-3');
});

test('resolveUniqueBudgetName: gaps in counter -> fills first free', async () => {
  // Budget-3 taken but -2 free — should pick -2 (lowest free, not +1 of max).
  const existing = [{ name: 'Budget' }, { name: 'Budget-3' }];
  assert.equal(await resolveUniqueBudgetName('Budget', existing), 'Budget-2');
});

test('resolveUniqueBudgetName: many existing -> walks forward', async () => {
  const existing = [
    { name: 'Budget' }, { name: 'Budget-2' }, { name: 'Budget-3' },
    { name: 'Budget-4' }, { name: 'Budget-5' },
  ];
  assert.equal(await resolveUniqueBudgetName('Budget', existing), 'Budget-6');
});

test('resolveUniqueBudgetName: regex escape — name with regex metacharacters', async () => {
  // "Foo.Bar*" must NOT collide with "FooXBarY" (a separate unrelated name)
  // and the resolver must treat the dot/star as literal.
  const existing = [{ name: 'Foo.Bar*' }];
  assert.equal(await resolveUniqueBudgetName('Foo.Bar*', existing), 'Foo.Bar*-2');
});

test('resolveUniqueBudgetName: prefix collision regex — unrelated names not matched', async () => {
  // 'Budget' should not match 'BudgetPlus' or 'Budgetable'.
  const existing = [
    { name: 'Budget' },
    { name: 'BudgetPlus' },
    { name: 'Budgetable' },
  ];
  assert.equal(await resolveUniqueBudgetName('Budget', existing), 'Budget-2');
});