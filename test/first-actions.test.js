// Tests for lib/first-actions.js — checklist composition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFuzzyPayees,
  detectIncomeCandidates,
  countUncategorized,
  firstActionsChecklist,
} from '../lib/first-actions.js';

test('detectFuzzyPayees: substring pair', () => {
  const payees = [
    { name: 'Amazon Marketplace' },
    { name: 'Amazon' },
  ];
  const out = detectFuzzyPayees({ data: payees });
  // "Amazon" < 5 chars → skipped by the heuristic. Use a 5+ char example.
  const big = [
    { name: 'Amazon Marketplace Web' },
    { name: 'Amazon Marketplace' },
  ];
  const out2 = detectFuzzyPayees({ data: big });
  assert.equal(out2.length, 1);
  assert.equal(out2[0].reason, 'substring');
});

test('detectFuzzyPayees: empty or non-array input -> empty', () => {
  assert.deepEqual(detectFuzzyPayees(null), []);
  assert.deepEqual(detectFuzzyPayees({ data: [] }), []);
});

test('detectIncomeCandidates: filters income + non-positive balances', () => {
  const cats = [
    { id: 'c1', name: 'Salary', is_income: true },
    { id: 'c2', name: 'Groceries' },
    { id: 'c3', name: 'Refunds' },
    { id: 'c4', name: 'Rent' },
  ];
  const balanceByCatId = new Map([
    ['c2', -50000],
    ['c3', 2500],
    ['c4', 0],
  ]);
  const out = detectIncomeCandidates(cats, balanceByCatId);
  assert.deepEqual(out.map((c) => c.id), ['c3']);
  assert.equal(out[0].balanceCents, 2500);
});

test('detectIncomeCandidates: sorts by balance desc', () => {
  const cats = [
    { id: 'c1', name: 'Small' },
    { id: 'c2', name: 'Big' },
    { id: 'c3', name: 'Medium' },
  ];
  const balanceByCatId = new Map([
    ['c1', 100],
    ['c2', 50000],
    ['c3', 9999],
  ]);
  const out = detectIncomeCandidates(cats, balanceByCatId);
  assert.deepEqual(out.map((c) => c.id), ['c2', 'c3', 'c1']);
});

test('countUncategorized: sums per-account counts', () => {
  assert.equal(countUncategorized([3, 7, 0, 12]), 22);
  assert.equal(countUncategorized([]), 0);
});

test('firstActionsChecklist: empty inputs -> "no outstanding actions"', () => {
  const md = firstActionsChecklist({});
  assert.match(md, /No outstanding actions detected/);
  assert.match(md, /^# First Actions Checklist/);
});

test('firstActionsChecklist: includes each section when inputs present', () => {
  const md = firstActionsChecklist({
    fuzzyPayees: [{ a: 'Whole Foods', b: 'Wholefoods', reason: 'edit distance 1' }],
    uncategorizedCount: 4,
    incomeCandidates: [{ id: 'x', name: 'Reimbursements', balanceCents: 15000 }],
    settingsNotMigrated: ['Set currency symbol to `$` in Actual → Settings → Preferences → Display'],
    driftCells: 3,
    budgetName: 'My Migrated Budget',
  });
  assert.match(md, /First Actions Checklist — My Migrated Budget/);
  assert.match(md, /Whole Foods.*Wholefoods.*edit distance 1/s);
  assert.match(md, /Uncategorized transactions \(4\)/);
  assert.match(md, /Reimbursements.*150\.00/);
  assert.match(md, /currency symbol to .\$./);
  assert.match(md, /Budget-cell drift/);
  assert.match(md, /MIGRATION_REPORT\.md/);
  assert.match(md, /--fix/);
});

test('firstActionsChecklist: caps long lists at 50 (with …and N more)', () => {
  const fuzzy = Array.from({ length: 75 }, (_, i) => ({
    a: `Vendor ${i}XYZ`,
    b: `Vendor ${i} XYZ`,
    reason: 'substring',
  }));
  const md = firstActionsChecklist({ fuzzyPayees: fuzzy });
  // 50 checkbox lines, plus the "and 25 more" footer.
  const checkboxes = md.match(/^- \[ \] /gm) || [];
  // 50 + the Uncategorized-style others would be more; here just fuzzy is set.
  assert.ok(checkboxes.length >= 50, `expected ≥50 checkbox lines, got ${checkboxes.length}`);
  assert.match(md, /…and 25 more/);
});
