#!/usr/bin/env node
// Populate Actual Budget from captured Budgetwise JSON.
// Usage:
//   node bin/import_budgetwise.js                         # uses env defaults
//   node bin/import_budgetwise.js --capture ../captured/budgetwise-test
//   node bin/import_budgetwise.js --name "Budgetwise-Migration-SampleBudget"
//   node bin/import_budgetwise.js --keep-failed           # skip auto-wipe
//   node bin/import_budgetwise.js --no-verify             # skip post-flight checks
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
  { checkCollision, findByName },
] = await Promise.all([
  import('../lib/config.js'),
  import('../lib/logger.js'),
  import('../lib/reader.js'),
  import('../lib/verify.js'),
  import('../lib/populate.js'),
  import('../lib/budget-mgmt.js'),
]);
const { resolve } = await import('node:path');
const fs = await import('node:fs');
const api = await import('@actual-app/api');

function printUsage() {
  console.log(`Usage: node bin/import_budgetwise.js [options]

Populates Actual Budget from captured Budgetwise JSON.
Creates a new file via runImport; does NOT touch any existing file of the
same name (delete manually via Actual → Settings → Files if you want to
re-run from scratch).

Options:
  --capture <dir>      Capture directory (default: ../captured/recon-budget).
  --name <name>        Budget file name in Actual
                       (default: 'Budgetwise-Migration-Budget').
  --no-verify          Skip post-flight verification queries.
  --verbose            Debug-level logging.
  --help, -h           Show this help.

Notes:
  - Each run creates a NEW file in Actual. To re-run cleanly, delete the
    prior file via the Actual UI first.
  - Payee dedup runs on the capture: exact-name duplicates collapsed, then
    case-insensitive + apostrophe-normalized variants merged. Substring /
    edit-distance candidates are logged as warnings but NOT auto-merged.
  - The setBudgetAmount API silently no-ops inside runImport, so budget
    amounts are written in a separate post-import pass.
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
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const BUDGET_NAME = args.name || 'Budgetwise-Migration-Budget';
const CAPTURE_DIR = args.capture
  ? resolve(args.capture)
  : resolve('../captured/recon-budget');

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
    await postflight(result);
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
  const { unwrap } = await import('../lib/reader.js');
  const tfc = unwrap(capture.timeframeCategories);
  if (!Array.isArray(tfc) || tfc.length === 0) return 0;

  const flat = tfc.flat();
  const categoryIdToActual = populateResult.categoryIdToActual;

  const actualCats = await api.getCategories();
  const actualCatIds = new Set(actualCats.map(c => c.id));

  let count = 0;
  let ccSkipped = 0;
  let missing = 0;
  await api.batchBudgetUpdates(async () => {
    for (const entry of flat) {
      if (entry.is_cc) { ccSkipped++; continue; }
      if (!entry.category_id) { missing++; continue; }
      const catId = categoryIdToActual.get(entry.category_id);
      if (!catId || !actualCatIds.has(catId)) { missing++; continue; }
      const tf = entry.timeframe;
      if (!tf || tf.length !== 6) continue;
      const mm = tf.slice(0, 2);
      const yyyy = tf.slice(2, 6);
      const month = `${yyyy}-${mm}-01`;
      const cents = Math.round(parseFloat(entry.budgeted || '0') * 100);
      await api.setBudgetAmount(month, catId, cents);
      count++;
    }
  });
  logger.info(`  Wrote ${count} budget entries (${ccSkipped} CC rows skipped, ${missing} missing categories/budgets)`);
  return count;
}

async function postflight(expected) {
  logger.section('Post-flight verification');
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

  if (expected.budgetEntries > 0) {
    const months = await api.getBudgetMonths();
    if (months.length > 0) {
      const month = Array.isArray(months) ? months[months.length - 1] : months;
      const monthStr = typeof month === 'string' ? month : month.month;
      const bm = await api.getBudgetMonth(monthStr);
      const cats = (bm.categoryGroups || []).flatMap(g => g.categories);
      const withBudget = cats.filter(c => c.budgeted && c.budgeted !== 0);
      const totalBudgeted = cats.reduce((s, c) => s + (c.budgeted || 0), 0);
      logger.info(`  latest budget month (${bm.month}): ${withBudget.length}/${cats.length} categories with budget, total = $${(totalBudgeted/100).toFixed(2)}`);
    }
  }

  if (bad > 0) {
    logger.warn(`Post-flight had ${bad} failures; budget was imported but may need review.`);
  }
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
