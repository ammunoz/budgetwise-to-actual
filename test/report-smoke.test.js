// Smoke test for the post-import report generation. Loads the real captured
// data from `captured/recon-budget-sample/`, runs each report module
// against injected stubs, composes the artifacts, and writes them to a
// temporary directory so we can eyeball the output.
//
// This does NOT touch a live Actual server — `getMonth` and `getBalance` are
// stubbed with realistic per-month data from the actual ltbBreakdown, so
// the output reflects what a successful run would produce.
//
// Also asserts that `populate()` exposes `accountIdToActual` on its return
// value (regression for the BLOCKED finding where per-account balance
// reconciliation silently produced "missing" for every account).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { migrateSettings } from '../lib/settings-migrate.js';
import { ccNotes } from '../lib/cc-notes.js';
import { runReconReport } from '../lib/recon-report.js';
import { firstActionsChecklist, detectFuzzyPayees, detectIncomeCandidates } from '../lib/first-actions.js';
import { composeMarkdown, writeArtifactRequired, writeArtifact } from '../lib/report-writer.js';

const CAPTURE = resolve(
  process.argv[2]
  || process.env.BW2A_CAPTURE_DIR
  || '../../captured/recon-budget-sample',
);

// Smoke test only runs when a real capture directory is available. Skip
// otherwise so `npm test` succeeds in environments without one.
async function captureAvailable() {
  try {
    await access(join(CAPTURE, 'settings.json'));
    await access(join(CAPTURE, 'ltbBreakdown.json'));
    return true;
  } catch {
    return false;
  }
}

const skip = !(await captureAvailable());

test('report smoke: generates MIGRATION_REPORT.md and FIRST_ACTIONS.md from real capture', { skip }, async () => {
  // Load capture files we need.
  const settings = JSON.parse(await readFile(join(CAPTURE, 'settings.json'), 'utf8'));
  const accounts = JSON.parse(await readFile(join(CAPTURE, 'accounts.json'), 'utf8'));
  const categories = JSON.parse(await readFile(join(CAPTURE, 'categories.json'), 'utf8'));
  const payees = JSON.parse(await readFile(join(CAPTURE, 'payees.json'), 'utf8'));
  const timeframeCategories = JSON.parse(await readFile(join(CAPTURE, 'timeframeCategories.json'), 'utf8'));
  const ltbBreakdown = JSON.parse(await readFile(join(CAPTURE, 'ltbBreakdown.json'), 'utf8'));

  const capture = { settings, accounts, categories, payees, timeframeCategories, ltbBreakdown };

  // Stub the BW->Actual id mapping: in a real run populate() creates this.
  // For the smoke we use a 1:1 mapping from BW id to a synthetic Actual id
  // so we can verify the balance loop doesn't throw.
  const bwIdToActualId = new Map();
  for (const a of accounts.data) bwIdToActualId.set(a.id, `actual-${a.id}`);

  // Stub getBudgetMonth: return BW's own numbers back as Actual would
  // (a best-case scenario). This isn't 100% Accurate since Actual's
  // formulas differ, but it exercises the wiring without an Actual server.
  const getMonth = async (m) => {
    const mmyyyy = `${m.slice(5, 7).padStart(2, '0')}${m.slice(0, 4)}`;
    const ltb = ltbBreakdown[mmyyyy] || {};
    return {
      month: m,
      totalIncome: Math.round(parseFloat(ltb.incomeForMonth || '0') * 100),
      toBudget: Math.round(parseFloat(ltb.leftToBudget || '0') * 100),
      fromLastMonth: Math.round(parseFloat(ltb.fwdFromLastMonth || '0') * 100),
      totalBudgeted: -Math.round(parseFloat(ltb.budgetedForMonth || '0') * 100),
    };
  };

  // Stub getBalance: just return BW's current_bal.
  const getBalance = async (actualAcctId) => {
    const bwId = actualAcctId.replace('actual-', '');
    const a = accounts.data.find((x) => x.id === bwId);
    return Math.round(parseFloat(a?.current_bal || '0') * 100);
  };

  // Settings migration: stub send() to just record calls.
  const sendCalls = [];
  const send = async (name, args) => { sendCalls.push({ name, args }); };
  const settingsResult = await migrateSettings(send, settings);

  // Reconciliation.
  const { markdown: reconMarkdown } = await runReconReport({
    capture,
    getMonth,
    getBalanceForAcctId: getBalance,
    bwIdToActualAcctId: bwIdToActualId,
  });

  // CC notes.
  const ccMd = ccNotes(capture);

  // First actions.
  const fuzzy = detectFuzzyPayees(payees);
  const balanceByCatId = new Map();
  for (const c of categories.data) balanceByCatId.set(c.id, 0);
  const incomeCandidates = detectIncomeCandidates(categories.data, balanceByCatId);
  const firstActionsMd = firstActionsChecklist({
    fuzzyPayees: fuzzy,
    uncategorizedCount: 0,
    incomeCandidates,
    settingsNotMigrated: (settingsResult.failed || []).map((f) => `\`${f.id}\` failed: ${f.error}`)
      .concat((settingsResult.skipped || []).map((s) => `\`${s.bwKey}\` skipped: ${s.reason}`)),
    budgetName: 'SampleBudget',
  });

  // Bundle into MIGRATION_REPORT.md.
  const settingsSection = [
    `**Auto-applied: ${settingsResult.applied.length}**`,
    settingsResult.applied.length > 0
      ? '\n| BW key | Actual pref | Value |\n|---|---|---|\n'
          + settingsResult.applied.map((m) => `| ${m.bwKey} | \`${m.id}\` | \`${m.value}\` |`).join('\n')
      : '_No preferences forwarded._',
    '',
    '## Manual Settings Guide',
    '',
    settingsResult.guideMarkdown || '_(none)_',
  ].join('\n');

  const bundled = composeMarkdown('Migration Report — SampleBudget', [
    { heading: 'Settings migration', body: settingsSection },
    { heading: 'Reconciliation', body: reconMarkdown },
    { heading: 'Credit Card payment mapping', body: ccMd },
    { heading: 'First Actions checklist (excerpt)', body: firstActionsMd },
  ]);

  // Write to a tmpdir; this is the smoke test's "MIGRATION_REPORT.md".
  const tmp = await mkdtemp(join(tmpdir(), 'bw2a-recon-smoke-'));
  try {
    const migrationPath = join(tmp, 'MIGRATION_REPORT.md');
    const firstActionsPath = join(tmp, 'FIRST_ACTIONS.md');
    await writeArtifactRequired(migrationPath, bundled);
    await writeArtifact(firstActionsPath, firstActionsMd + (firstActionsMd.endsWith('\n') ? '' : '\n'));

    const written = await readFile(migrationPath, 'utf8');
    assert.match(written, /^# Migration Report — SampleBudget/);
    assert.match(written, /## Settings migration/);
    assert.match(written, /## Reconciliation/);
    assert.match(written, /## Credit Card payment mapping/);
    assert.match(written, /## First Actions checklist/);
    // Sample data assertions: real capture has mm/dd/yy etc.
    assert.ok(bundled.length > 1000, 'report should be substantial');
    assert.ok(sendCalls.length >= 3, 'settings API should have been called for sample');

    const faWritten = await readFile(firstActionsPath, 'utf8');
    assert.match(faWritten, /^# First Actions Checklist/);
    console.log(`  migration report: ${written.length} bytes, ${written.split('\n').length} lines`);
    console.log(`  first-actions:    ${faWritten.length} bytes, ${faWritten.split('\n').length} lines`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Regression: populate() must expose accountIdToActual so the per-account
// balance reconciliation in runReconReport can resolve BW account ids to
// Actual account ids. Without this, every account shows up as "missing".
// Uses Node's experimental test module mocks so we don't need a live server.
test('populate() exposes accountIdToActual (regression for BLOCKED finding)', { skip }, async () => {
  const apiStub = {
    createCategoryGroup: mock.fn(async ({ name }) => `grp-${name}`),
    createCategory: mock.fn(async ({ name }) => `cat-${name}`),
    createPayee: mock.fn(async ({ name }) => `pay-${name}`),
    getCategories: mock.fn(async () => [{ id: 'income-cat', name: 'Income', is_income: true }]),
    getCategoryGroups: mock.fn(async () => [{ id: 'income-grp', name: 'Income', is_income: true }]),
    createAccount: mock.fn(async ({ name }) => `acct-${name}`),
    getAccounts: mock.fn(async () => []),
    getPayees: mock.fn(async () => []),
    addTransactions: mock.fn(async () => 'ok'),
    getTransactions: mock.fn(async () => []),
    getAccountBalance: mock.fn(async () => 0),
    runImport: mock.fn(async (_name, fn) => { await fn(); }),
    batchBudgetUpdates: mock.fn(async (fn) => { await fn(); }),
    setBudgetAmount: mock.fn(async () => {}),
    getBudgetMonth: mock.fn(async () => ({ month: '2024-01-01', totalIncome: 0, toBudget: 0, fromLastMonth: 0, totalBudgeted: 0 })),
    lib: { send: mock.fn(async () => {}) },
  };
  mock.module('@actual-app/api', { namedExports: apiStub });

  const { populate } = await import('../lib/populate.js');

  const accounts = JSON.parse(await readFile(join(CAPTURE, 'accounts.json'), 'utf8'));
  const categories = JSON.parse(await readFile(join(CAPTURE, 'categories.json'), 'utf8'));
  const sections = JSON.parse(await readFile(join(CAPTURE, 'sections.json'), 'utf8'));
  const payees = JSON.parse(await readFile(join(CAPTURE, 'payees.json'), 'utf8'));

  // Subset of transactions — just enough that populate doesn't error out.
  // For this test we don't care about tx flow, only the return shape.
  const capture = {
    accounts,
    categories,
    sections,
    payees,
    transactions: { data: [] },
    timeframeCategories: null,
    manifest: null,
  };

  const result = await populate(capture);
  assert.ok(result.accountIdToActual instanceof Map, 'populate() must return accountIdToActual as a Map');
  assert.equal(result.accountIdToActual.size, accounts.data.length, 'every BW account must have an Actual mapping');
  for (const bwAcct of accounts.data) {
    assert.ok(result.accountIdToActual.has(bwAcct.id), `BW id ${bwAcct.id} missing from accountIdToActual`);
  }
  // The fix: pass the actual populateResult into runReconReport.
  const { markdown } = await runReconReport({
    capture,
    getMonth: async () => ({ month: '2024-01-01', totalIncome: 0, toBudget: 0, fromLastMonth: 0, totalBudgeted: 0 }),
    getBalanceForAcctId: async (actualAcctId) => {
      // Walk back from actual id to BW id to confirm the mapping is real.
      for (const [bwId, aId] of result.accountIdToActual) {
        if (aId === actualAcctId) {
          const acct = accounts.data.find((a) => a.id === bwId);
          return Math.round(parseFloat(acct?.current_bal || '0') * 100);
        }
      }
      return 0;
    },
    bwIdToActualAcctId: result.accountIdToActual,
  });
  // The per-account balance table should NOT mark any account as missing.
  assert.doesNotMatch(markdown, /_no matching Actual account_/);
});
