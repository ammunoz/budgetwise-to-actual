#!/usr/bin/env node
// Capture all Budgetwise data into a directory of JSON files.
// Usage:
//   node bin/export_budgetwise.js                 # uses BUDGETWISE_BUDGET_ID from .env
//   node bin/export_budgetwise.js --budget Test   # resolves "Test" to a UUID
//   node bin/export_budgetwise.js --budget <uuid>
//   node bin/export_budgetwise.js --out ../captured/budgetwise-export
//   node bin/export_budgetwise.js --verbose
//   node bin/export_budgetwise.js --help

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

const [{ config }, { logger }, { captureAll, resolveBudget }] = await Promise.all([
  import('../lib/config.js'),
  import('../lib/logger.js'),
  import('../lib/express-client.js'),
]);
const { resolve } = await import('node:path');
const { existsSync } = await import('node:fs');

function printUsage() {
  console.log(`Usage: node bin/export_budgetwise.js [options]

Captures all Budgetwise data for one budget into a directory of JSON files.

Options:
  --budget <name|id>   Budget to export. Name resolves via /api/budgets.
                       Defaults to BUDGETWISE_BUDGET_ID from .env.
  --out <dir>          Output directory. Defaults to ../captured/budgetwise-<name>.
  --force              Overwrite existing manifest.json without warning.
  --verbose            Debug-level logging.
  --help               Show this help.

This is read-only — only POSTs are to /api/sessions (login).
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--budget') out.budget = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const { email, password, budgetId } = config.budgetwise;

  let chosenId = budgetId;
  let chosenName = args.budget;

  if (args.budget) {
    logger.info(`Resolving budget "${args.budget}"…`);
    const { token } = await listBudgets(email, password);
    const resolved = await resolveBudget(token, args.budget);
    if (!resolved) {
      throw new Error(`No budget found matching "${args.budget}"`);
    }
    chosenId = resolved.id;
    chosenName = resolved.name;
    logger.info(`  -> ${resolved.name} (${resolved.id})`);
  }

  const outDir = args.out
    ? resolve(args.out)
    : resolve(`../captured/budgetwise-${(chosenName || 'default').toLowerCase().replace(/\s+/g, '-')}`);

  if (existsSync(outDir + '/manifest.json') && !args.force) {
    logger.warn(`${outDir}/manifest.json already exists; will overwrite`);
  }

  logger.section(`Capturing budget "${chosenName || chosenId}"`);
  logger.info(`  output: ${outDir}`);

  const { summary } = await captureAll({
    email, password, budgetId: chosenId, outDir,
  });

  logger.section('Summary');
  for (const [k, v] of Object.entries(summary)) {
    logger.info(`  ${k}: ${v.ok ? (v.count ?? 'ok') : `FAIL (${v.error})`}`);
  }
}

async function listBudgets(email, password) {
  // Re-export the helper from express-client.js so the resolved name lookup
  // goes through the same module.
  const { listBudgets: listBudgetsFn } = await import('../lib/express-client.js');
  return listBudgetsFn(email, password);
}

main().catch((e) => {
  import('../lib/logger.js').then(({ logger: log }) => {
    log.error(e.stack || e.message);
    process.exit(1);
  }).catch(() => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
});
