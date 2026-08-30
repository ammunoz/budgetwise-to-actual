// Verification checks (pre-flight + post-flight).
import logger from './logger.js';

let failCount = 0;
const pass = (msg) => logger.info(`  ✓ ${msg}`);
const fail = (msg) => { failCount += 1; logger.error(`  ✗ ${msg}`); };

export function reset() { failCount = 0; }
export function failures() { return failCount; }

export function preflight({ capture }) {
  reset();
  logger.section('Pre-flight checks');

  const txns = capture.transactions.data;
  const accounts = capture.accounts.data;
  const categories = capture.categories.data;
  const payees = capture.payees.data;

  // Basic counts
  if (Array.isArray(txns) && txns.length) pass(`${txns.length} transactions loaded`);
  else fail('No transactions loaded');

  if (Array.isArray(accounts) && accounts.length) pass(`${accounts.length} accounts loaded`);
  else fail('No accounts loaded');

  if (Array.isArray(categories) && categories.length) pass(`${categories.length} categories loaded`);
  else fail('No categories loaded');

  if (Array.isArray(payees) && payees.length) pass(`${payees.length} payees loaded`);
  else fail('No payees loaded');

  // Transfer sanity: every tx with transfer_origin_transaction_id set must also have a partner.
  let orphans = 0;
  const ids = new Set(txns.map(t => t.id));
  for (const t of txns) {
    if (t.transfer_origin_transaction_id != null && !ids.has(t.transfer_origin_transaction_id)) orphans++;
    if (t.transfer_target_transaction_id != null && !ids.has(t.transfer_target_transaction_id)) orphans++;
  }
  if (orphans === 0) pass('No orphan transfer halves');
  else fail(`${orphans} orphan transfer halves found`);

  // Splits: parents have child_transactions
  const splitParents = txns.filter(t => Array.isArray(t.child_transactions) && t.child_transactions.length > 0);
  pass(`${splitParents.length} split parents with embedded children`);

  // split parent's amount should match Budgetwise convention (0); Actual will receive Σ signed children.
  // We just confirm Budgetwise shape:
  const nonZeroSplitParents = splitParents.filter(t => parseFloat(t.amount) !== 0).length;
  if (nonZeroSplitParents === 0) pass('All Budgetwise split parents have amount=0 (expected)');
  else logger.warn(`  ! ${nonZeroSplitParents} split parents have non-zero amount in source (unusual)`);

  // Sections present (optional)
  if (capture.sections) {
    const sections = capture.sections.data;
    if (Array.isArray(sections)) pass(`${sections.length} category sections loaded`);
    else logger.warn('  ! sections present but shape unexpected');
  } else {
    logger.warn('  ! no sections file in capture; categories will be created without groups');
  }

  // Transfer ∩ split intersection check (defensive)
  const transferSplitOverlap = txns.filter(t =>
    (t.transfer_origin_transaction_id || t.transfer_target_transaction_id) &&
    Array.isArray(t.child_transactions) && t.child_transactions.length > 0
  );
  if (transferSplitOverlap.length === 0) pass('No transaction is both a transfer and a split parent');
  else logger.warn(`  ! ${transferSplitOverlap.length} transactions are both transfer halves AND split parents`);

  return failCount;
}
