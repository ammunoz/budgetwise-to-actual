#!/usr/bin/env node
// Populate Actual Budget from captured Budgetwise JSON.
// Usage:
//   node bin/import_budgetwise.js                         # uses env defaults
//   node bin/import_budgetwise.js --capture ../captured/budgetwise-test
//   node bin/import_budgetwise.js --name "Budgetwise-Migration-Budget"
//   node bin/import_budgetwise.js --keep-failed           # skip auto-wipe
//   node bin/import_budgetwise.js --no-verify             # skip post-flight checks
//   node bin/import_budgetwise.js --fix                   # if drift detected, write expected values
//   node bin/import_budgetwise.js --help                  # show usage

// Args parsing BEFORE any imports so `--help` works without .env.
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (args.verbose) {
  const { setLevel } = await import('../lib/logger.js');
  setLevel('debug');
}

// Dynamic imports so config validation only runs when the script runs
// (not for --help, which exits above).
const [
  { config },
  { logger },
  { loadCapture },
  { preflight, failures: prefFailures },
  { populate },
  { checkCollision, findByName, resolveUniqueBudgetName },
  { expectedBudgetEntries, validateBudgets, fixDrift, formatDriftCell },
  { migrateSettings },
  { runReconReport },
  { ccNotes },
  {
    detectFuzzyPayees,
    detectIncomeCandidates,
    firstActionsChecklist,
  },
  { writeArtifact, writeArtifactRequired, composeMarkdown, reportPaths },
] = await Promise.all([
  import('../lib/config.js'),
  import('../lib/logger.js'),
  import('../lib/reader.js'),
  import('../lib/verify.js'),
  import('../lib/populate.js'),
  import('../lib/budget-mgmt.js'),
  import('../lib/budgets.js'),
  import('../lib/settings-migrate.js'),
  import('../lib/recon-report.js'),
  import('../lib/cc-notes.js'),
  import('../lib/first-actions.js'),
  import('../lib/report-writer.js'),
]);
const { resolve } = await import('node:path');
const fs = await import('node:fs');
const readline = await import('node:readline');
const api = await import('@actual-app/api');

function printUsage() {
  console.log(`Usage: node bin/import_budgetwise.js [options]

Populates Actual Budget from captured Budgetwise JSON.
Each run creates a new file in Actual (runImport is always additive).
To avoid duplicate-name files, --name gets a counter suffix if the
exact name already exists: 'Budget' → 'Budget-2' → 'Budget-3' …
To re-run with the exact same name, delete the prior file in
Actual → Settings → Files first.

Options:
  --capture <dir>      Capture directory (default: ../captured/recon-budget).
  --name <name>        Budget file name in Actual
                       (default: 'Budgetwise-Migration-Budget'). If taken,
                       a counter suffix is appended automatically.
  --no-verify          Skip post-flight verification queries.
  --fix                If budget drift is detected, write the expected values
                       non-interactively (use with care — trusts the capture).
  --verbose            Debug-level logging.
  --help, -h           Show this help.

Notes:
  - Payee dedup runs on the capture: exact-name duplicates collapsed, then
    case-insensitive + apostrophe-normalized variants merged. Substring /
    edit-distance candidates are logged as warnings but NOT auto-merged.
  - Budget row consolidation runs on the capture: duplicate (timeframe,
    category_id) rows collapse to one row per key with \`budgeted\` set to
    the SUM of all contributing rows (matches Budgetwise's own per-month
    math in ltbBreakdown.budgetedForMonth). CC rows are id-deduped before
    summing (the BW API may emit the same CC row twice with different
    \`spent\` values; the \`budgeted\` value is identical and counts once).
  - The setBudgetAmount API silently no-ops inside runImport, so budget
    amounts are written in a separate post-import pass.
  - After the budget pass, the tool re-reads Actual's budget cells and
    compares them against the deduped capture. Drift triggers a TTY prompt
    (fix / keep anyway / fail); in non-TTY environments it logs and exits 1.
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capture') out.capture = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--keep-failed') out.keepFailed = true;
    else if (a === '--no-verify') out.noVerify = true;
    else if (a === '--fix') out.fix = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const REQUESTED_NAME = args.name || 'Budgetwise-Migration-Budget';
const CAPTURE_DIR = args.capture
  ? resolve(args.capture)
  : resolve('../captured/recon-budget');

let BUDGET_NAME = REQUESTED_NAME;

async function main() {
  ensureDataDir();

  logger.section('Loading capture');
  const capture = await loadCapture(CAPTURE_DIR);
  if (capture.manifest) {
    logger.info(`  capture from: ${capture.manifest.capturedAt}`);
    logger.info(`  budget id:    ${capture.manifest.budgetId}`);
  } else {
    logger.warn('  no manifest.json found in capture (proceeding anyway)');
  }

  preflight({ capture });
  if (prefFailures() > 0) {
    throw new Error(`${prefFailures()} preflight check(s) failed; aborting`);
  }

  logger.section('Connecting to Actual');
  await api.init({
    serverURL: config.actual.serverURL,
    password: config.actual.password,
    dataDir: config.actual.dataDir,
  });
  logger.info(`  server: ${config.actual.serverURL}`);

  // Resolve to a unique name so re-running with the same --name doesn't
  // silently leave a duplicate on the server. @actual-app/api has no
  // in-place replace; runImport always adds a new file.
  BUDGET_NAME = await resolveUniqueBudgetName(REQUESTED_NAME);
  if (BUDGET_NAME !== REQUESTED_NAME) {
    logger.info(`  name "${REQUESTED_NAME}" already exists; using "${BUDGET_NAME}" instead`);
  }
  await checkCollision(BUDGET_NAME);

  logger.section(`Creating + populating "${BUDGET_NAME}"`);
  let result;
  try {
    await api.runImport(BUDGET_NAME, async () => {
      result = await populate(capture);
    });
  } catch (e) {
    logger.error(`Import failed: ${e.message}`);
    logger.error('runImport aborted (changes rolled back).');
    throw e;
  }

  let budgetCount = 0;
  if (capture.timeframeCategories) {
    logger.section('Writing budget amounts');
    budgetCount = await writeBudgetsAfterImport(capture, result);
    result.budgetEntries = budgetCount;

    logger.info('  syncing to server...');
    try {
      await api.sync();
      logger.info('  ✓ sync complete');
    } catch (e) {
      logger.warn(`  sync error (continuing): ${e.message}`);
    }
  }

  // Settings migration runs after runImport (synced prefs are per-file and
  // scoped to the active budget; setting them inside runImport's transaction
  // was tested and produced no-op behavior on @actual-app/api 25.x).
  // Failures here don't abort the import — the report captures them.
  let settingsResult = null;
  if (capture.settings) {
    logger.section('Settings migration');
    try {
      const send = (name, args) => api.lib.send(name, args);
      settingsResult = await migrateSettings(send, capture.settings);
    } catch (e) {
      logger.warn(`  settings migration error: ${e.message}`);
      settingsResult = { applied: [], failed: [], skipped: [], unrecognized: [], guideMarkdown: '' };
    }
  }

  logger.section('Import result');
  logger.info(`  accounts:        ${result.accounts}`);
  logger.info(`  categories:      ${result.categories}`);
  logger.info(`  payees:          ${result.payees}`);
  logger.info(`  transactions:    ${result.transactions}`);
  logger.info(`  splits:          ${result.splits}`);
  logger.info(`  skipped inflows: ${result.skipIds}`);
  logger.info(`  budget entries:  ${budgetCount}`);

  if (!args.noVerify) {
    const postflightData = await postflight(result, capture, result);
    // Drift detection runs BEFORE report writing so the report can include
    // the drift count in the first-actions checklist. The action decision
    // (fix / keep / fail) runs after — by then we already have a written
    // record regardless of which path the user picks.
    let driftResult = null;
    if (capture.timeframeCategories && result.budgetEntries > 0) {
      driftResult = await detectBudgetDrift(capture, result);
      postflightData.driftCells = driftResult.drift.length;
      postflightData.driftList = driftResult.drift;
    }
    await runPostImportReports({
      capture,
      captureDir: CAPTURE_DIR,
      settingsResult,
      populateResult: result,
      postflightData,
      budgetName: BUDGET_NAME,
    });
    if (driftResult && driftResult.drift.length > 0) {
      await applyDriftDecision(capture, result, driftResult);
    }
  } else {
    logger.warn('--no-verify set; skipping post-flight checks');
    // Still write the lighter reports on `--no-verify` — they only need
    // Actual account/category queries, which are cheap. Drift detection
    // is intentionally skipped under --no-verify to honor that flag.
    const postflightData = await lightCollect(capture);
    await runPostImportReports({
      capture,
      captureDir: CAPTURE_DIR,
      settingsResult,
      populateResult: result,
      postflightData,
      budgetName: BUDGET_NAME,
    });
  }

  await api.shutdown();
  logger.section('Done');
  logger.info(`Open Actual at ${config.actual.serverURL} and select "${BUDGET_NAME}".`);
}

function ensureDataDir() {
  const d = config.actual.dataDir;
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
  }
}

async function writeBudgetsAfterImport(capture, populateResult) {
  const categoryIdToActual = populateResult.categoryIdToActual;
  const actualCats = await api.getCategories();
  const actualCatIds = new Set(actualCats.map(c => c.id));

  const entries = expectedBudgetEntries(capture, categoryIdToActual);

  let count = 0;
  let missing = 0;
  await api.batchBudgetUpdates(async () => {
    for (const e of entries) {
      if (!actualCatIds.has(e.catId)) { missing++; continue; }
      await api.setBudgetAmount(e.month, e.catId, e.cents);
      count++;
    }
  });
  logger.info(`  Wrote ${count} budget entries (${missing} missing categories/budgets skipped)`);
  return count;
}

async function postflight(expected, capture, populateResult) {
  logger.section('Post-flight verification');

  // Light checks (counts)
  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  const groups = await api.getCategoryGroups();
  const payees = await api.getPayees();

  let ok = 0;
  let bad = 0;
  const check = (cond, msg) => cond ? (ok++, logger.info(`  ✓ ${msg}`)) : (bad++, logger.error(`  ✗ ${msg}`));

  check(accounts.length === expected.accounts, `accounts: got ${accounts.length}, expected ${expected.accounts}`);
  check(categories.length >= expected.categories, `categories: got ${categories.length}, expected >=${expected.categories}`);
  check(groups.length > 0, `category groups present (${groups.length})`);
  check(payees.length >= expected.payees, `payees: got ${payees.length}, expected >=${expected.payees}`);

  // Per-account balances + uncategorized txs — also cached for the report step.
  const balancesByAccountName = new Map();
  const uncategorizedPerAccount = [];
  const categoryBalanceCentsByName = new Map();
  let totalTxs = 0;
  let uncategorized = 0;
  for (const a of accounts) {
    const balance = await api.getAccountBalance(a.id);
    const txs = await api.getTransactions(a.id);
    totalTxs += txs.length;
    const uncat = txs.filter(t => !t.category).length;
    uncategorized += uncat;
    uncategorizedPerAccount.push(uncat);
    balancesByAccountName.set(a.name, balance);
    // Sum per-category totals across this account's txs (used by income
    // candidate detection).
    for (const t of txs) {
      if (t.category) {
        categoryBalanceCentsByName.set(
          t.category,
          (categoryBalanceCentsByName.get(t.category) || 0) + (t.amount || 0),
        );
      }
    }
    logger.info(`    ${a.name}: balance = $${(balance / 100).toFixed(2)}, ${txs.length} txs`);
  }
  logger.info(`  total transactions: ${totalTxs}`);
  logger.info(`  uncategorized: ${uncategorized} (transactions with no category in source)`);

  if (bad > 0) {
    logger.warn(`Post-flight had ${bad} failures; budget was imported but may need review.`);
  }

  return {
    uncategorizedCount: uncategorized,
    uncategorizedPerAccount,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    categories,
    balancesByAccountName,
    categoryBalanceCentsByName,
  };
}

// Light collector used by `--no-verify` so reports still get the data they
// need (uncategorized count, account list, category balances) without running
// the heavy per-cell budget drift detection.
async function lightCollect(capture) {
  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  const balancesByAccountName = new Map();
  const uncategorizedPerAccount = [];
  const categoryBalanceCentsByName = new Map();
  let uncategorized = 0;
  for (const a of accounts) {
    const balance = await api.getAccountBalance(a.id);
    const txs = await api.getTransactions(a.id);
    balancesByAccountName.set(a.name, balance);
    const uncat = txs.filter((t) => !t.category).length;
    uncategorized += uncat;
    uncategorizedPerAccount.push(uncat);
    for (const t of txs) {
      if (t.category) {
        categoryBalanceCentsByName.set(
          t.category,
          (categoryBalanceCentsByName.get(t.category) || 0) + (t.amount || 0),
        );
      }
    }
  }
  return {
    uncategorizedCount: uncategorized,
    uncategorizedPerAccount,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    categories,
    balancesByAccountName,
    categoryBalanceCentsByName,
  };
}

async function runPostImportReports({
  capture,
  captureDir,
  settingsResult,
  populateResult,
  postflightData,
  budgetName,
}) {
  logger.section('Writing reports');

  const pathSet = reportPaths(captureDir, budgetName);

  // ---- Reconciliation ----
  let reconMarkdown = '';
  try {
    const { markdown } = await runReconReport({
      capture,
      getMonth: (m) => api.getBudgetMonth(m.slice(0, 7)),
      getBalanceForAcctId: (actualAcctId) => api.getAccountBalance(actualAcctId),
      bwIdToActualAcctId: populateResult.accountIdToActual || new Map(),
    });
    reconMarkdown = markdown;
    logger.info(`  reconciliation: ${reconMarkdown.split('\n').length} line(s)`);
  } catch (e) {
    logger.warn(`  reconciliation report failed: ${e.message}`);
    reconMarkdown = `# Reconciliation Report\n\n_Reconciliation failed: ${e.message}_\n`;
  }

  // ---- Credit Card payment notes ----
  let ccMarkdown = '# Credit Card Payment Migration Notes\n\n_Could not generate._\n';
  try {
    ccMarkdown = ccNotes(capture);
  } catch (e) {
    logger.warn(`  cc-notes failed: ${e.message}`);
  }

  // ---- First Actions ----
  let firstActionsMd = '';
  try {
    const fuzzy = detectFuzzyPayees(capture.payees);
    const balanceByCatId = new Map(postflightData?.categoryBalanceCentsByName || []);
    const incomeCandidates = detectIncomeCandidates(postflightData?.categories || [], balanceByCatId);
    const settingsLines = [];
    if (settingsResult) {
      for (const f of settingsResult.failed) {
        settingsLines.push(`Review \`${f.id}\` (set to \`${f.value}\`) — API call failed: ${f.error}`);
      }
      for (const s of settingsResult.skipped || []) {
        settingsLines.push(`Set \`${s.bwKey}\` (currently unsupported by \`@actual-app/api\`): ${s.reason}`);
      }
      for (const k of settingsResult.unrecognized || []) {
        settingsLines.push(`Unknown Budgetwise setting: \`${k}\``);
      }
    }
    firstActionsMd = firstActionsChecklist({
      fuzzyPayees: fuzzy,
      uncategorizedCount: postflightData?.uncategorizedCount || 0,
      incomeCandidates,
      settingsNotMigrated: settingsLines,
      driftCells: postflightData?.driftCells || 0,
      budgetName,
    });
  } catch (e) {
    logger.warn(`  first-actions failed: ${e.message}`);
    firstActionsMd = firstActionsChecklist({ budgetName });
  }

  // ---- Bundle into MIGRATION_REPORT.md ----
  const settingsSection = settingsResult
    ? [
        `**Auto-applied via \`preferences/save\`: ${settingsResult.applied.length}**`,
        settingsResult.applied.length > 0
          ? '\n| BW key | Actual pref | Value |\n|---|---|---|\n'
              + settingsResult.applied.map((m) => `| ${m.bwKey} | \`${m.id}\` | \`${m.value}\` |`).join('\n')
            : '_No preferences forwarded automatically._',
        ...(settingsResult.failed.length > 0
          ? ['', '## Failed API calls', '', ...settingsResult.failed.map((f) => `- \`${f.id}\`: ${f.error}`)]
          : []),
        ...((settingsResult.skipped || []).length > 0
          ? ['', '## Skipped (no mapping)', '', ...settingsResult.skipped.map((s) => `- \`${s.bwKey}\`: ${s.reason}`)]
          : []),
        ...((settingsResult.unrecognized || []).length > 0
          ? ['', '## Unrecognized keys', '', ...settingsResult.unrecognized.map((k) => `- \`${k}\``)]
          : []),
        '', '---', '', '## Manual Settings Guide', '', settingsResult.guideMarkdown || '_(no guide)_',
      ].join('\n')
    : '_No Budgetwise settings captured._';

  const bundled = composeMarkdown(`Migration Report — ${budgetName}`, [
    { heading: 'Settings migration', body: settingsSection },
    { heading: 'Reconciliation', body: reconMarkdown },
    { heading: 'Credit Card payment mapping', body: ccMarkdown },
    { heading: 'First Actions checklist (excerpt)', body: firstActionsMd },
  ]);

  try {
    await writeArtifactRequired(pathSet.migrationReport, bundled);
  } catch (e) {
    logger.error(`Could not write MIGRATION_REPORT.md to ${pathSet.migrationReport}: ${e.message}`);
    throw e;
  }

  // Standalone FIRST_ACTIONS.md (best-effort).
  await writeArtifact(pathSet.firstActions, firstActionsMd + (firstActionsMd.endsWith('\n') ? '' : '\n'));
}

async function detectBudgetDrift(capture, populateResult) {
  const entries = expectedBudgetEntries(capture, populateResult.categoryIdToActual);
  logger.section('Budget verification');
  const result = await validateBudgets(entries, {
    // Actual's getBudgetMonth expects 'YYYY-MM', not 'YYYY-MM-DD'.
    getMonth: (m) => api.getBudgetMonth(m.slice(0, 7)),
  });
  logger.info(`  checked: ${result.checked} (month, category) cells`);
  if (result.drift.length === 0) {
    logger.info(`  ✓ all cells match Budgetwise capture`);
    return result;
  }
  const actualCats = await api.getCategories();
  const actualCatById = new Map(actualCats.map(c => [c.id, c]));
  logger.warn(`  ✗ ${result.drift.length} cell(s) drift from Budgetwise capture`);
  for (const d of result.drift.slice(0, 50)) {
    const name = actualCatById.get(d.catId)?.name ?? '?';
    logger.warn(`    ${formatDriftCell(d, { catName: name })}`);
  }
  if (result.drift.length > 50) logger.warn(`    ... and ${result.drift.length - 50} more`);
  return result;
}

// Takes the drift result already computed by detectBudgetDrift and applies
// the user-facing decision (auto-fix, prompt, or exit). Reports have
// already been written by the time this is called.
async function applyDriftDecision(capture, populateResult, driftResult) {
  const drift = driftResult.drift;
  if (drift.length === 0) return;

  if (args.fix) {
    logger.info('  --fix set; rewriting drifted cells...');
    await api.batchBudgetUpdates(async () => {
      await fixDrift(drift, { setBudget: api.setBudgetAmount });
    });
    logger.info('  ✓ fix applied');
    return;
  }

  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY) {
    logger.error('Drift detected and no --fix flag; non-interactive mode → exiting 1.');
    logger.error('Re-run with --fix to rewrite the cells, or delete the budget file in Actual UI and re-run.');
    process.exit(1);
  }

  const choice = await prompt('Drift detected. (f)ix, (k)eep anyway, (F)ail? ');
  if (choice === 'f' || choice === 'fix') {
    logger.info('  rewriting drifted cells...');
    await api.batchBudgetUpdates(async () => {
      await fixDrift(drift, { setBudget: api.setBudgetAmount });
    });
    logger.info('  ✓ fix applied');
  } else if (choice === 'F' || choice === 'fail') {
    logger.error('User chose fail; exiting 1.');
    process.exit(1);
  } else {
    logger.warn('User chose keep anyway; drift will persist.');
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

main().catch((e) => {
  // Dynamic-import logger so we can log the error even when logger import failed.
  import('../lib/logger.js').then(({ logger: log }) => {
    log.error(e.stack || e.message);
    process.exit(1);
  }).catch(() => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
});