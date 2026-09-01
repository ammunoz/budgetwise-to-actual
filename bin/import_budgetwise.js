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
] = await Promise.all([
  import('../lib/config.js'),
  import('../lib/logger.js'),
  import('../lib/reader.js'),
  import('../lib/verify.js'),
  import('../lib/populate.js'),
  import('../lib/budget-mgmt.js'),
  import('../lib/budgets.js'),
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

  logger.section('Import result');
  logger.info(`  accounts:        ${result.accounts}`);
  logger.info(`  categories:      ${result.categories}`);
  logger.info(`  payees:          ${result.payees}`);
  logger.info(`  transactions:    ${result.transactions}`);
  logger.info(`  splits:          ${result.splits}`);
  logger.info(`  skipped inflows: ${result.skipIds}`);
  logger.info(`  budget entries:  ${budgetCount}`);

  if (!args.noVerify) {
    await postflight(result, capture);
  } else {
    logger.warn('--no-verify set; skipping post-flight checks');
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

async function postflight(expected, capture) {
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

  let totalTxs = 0;
  let uncategorized = 0;
  for (const a of accounts) {
    const balance = await api.getAccountBalance(a.id);
    const txs = await api.getTransactions(a.id);
    totalTxs += txs.length;
    uncategorized += txs.filter(t => !t.category).length;
    logger.info(`    ${a.name}: balance = $${(balance / 100).toFixed(2)}, ${txs.length} txs`);
  }
  logger.info(`  total transactions: ${totalTxs}`);
  logger.info(`  uncategorized: ${uncategorized} (transactions with no category in source)`);

  if (bad > 0) {
    logger.warn(`Post-flight had ${bad} failures; budget was imported but may need review.`);
  }

  // Per-cell budget validation (the new step)
  if (capture.timeframeCategories && expected.budgetEntries > 0) {
    await validateBudgetsOrExit(capture, expected);
  }
}

async function validateBudgetsOrExit(capture, populateResult) {
  const entries = expectedBudgetEntries(capture, populateResult.categoryIdToActual);
  const actualCats = await api.getCategories();
  const actualCatById = new Map(actualCats.map(c => [c.id, c]));

  logger.section('Budget verification');
  const { checked, drift } = await validateBudgets(entries, {
    // Actual's getBudgetMonth expects 'YYYY-MM', not 'YYYY-MM-DD'.
    getMonth: (m) => api.getBudgetMonth(m.slice(0, 7)),
  });
  logger.info(`  checked: ${checked} (month, category) cells`);
  if (drift.length === 0) {
    logger.info(`  ✓ all cells match Budgetwise capture`);
    return;
  }

  logger.warn(`  ✗ ${drift.length} cell(s) drift from Budgetwise capture`);
  for (const d of drift.slice(0, 50)) {
    const name = actualCatById.get(d.catId)?.name ?? '?';
    logger.warn(`    ${formatDriftCell(d, { catName: name })}`);
  }
  if (drift.length > 50) logger.warn(`    ... and ${drift.length - 50} more`);

  // Decide: --fix / interactive prompt / exit 1
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