// populate.js — the function passed to runImport.
//
// Builds the Actual Budget tree from Budgetwise captured JSON.
// Uses `api.runImport('Budgetwise-Migration-...', populate)`, which:
//   - creates a fresh budget file with that name on the server
//   - opens it locally
//   - calls populate() to mutate it
//   - on success, persists; on throw, aborts/rolls back

import * as api from '@actual-app/api';
import { randomUUID } from 'node:crypto';
import { unwrap } from './reader.js';
import { signAmount, toISODate, effectiveDate } from './normalize.js';
import logger from './logger.js';

// =========================================================================
// PHASE A — Category groups + categories
// =========================================================================
//
// Categories within each section are created in the order they appear in
// `subcategories_order` (Budgetwise's per-section ordering). Categories not
// in the order array (defensive — shouldn't happen with valid data) are
// appended at the end of the section.
async function importCategoryGroups(sections, categories) {
  const sectionIdToActual = new Map();
  for (const s of sections) {
    const created = await api.createCategoryGroup({ name: s.name });
    sectionIdToActual.set(s.id, created);
  }

  // Group categories by section, preserving Budgetwise's subcategories_order.
  const bySection = new Map(); // sectionId → ordered list of category records
  const orderById = new Map(); // sectionId → Set<categoryId> in order
  for (const s of sections) {
    orderById.set(s.id, new Set(s.subcategories_order || []));
    bySection.set(s.id, []);
  }
  const orphans = []; // categories with no section_id
  for (const c of categories) {
    if (!c.section_id || !bySection.has(c.section_id)) {
      orphans.push(c);
      continue;
    }
    bySection.get(c.section_id).push(c);
  }

  const categoryIdToActual = new Map();
  for (const [sectionId, catsInSection] of bySection) {
    const orderSet = orderById.get(sectionId);
    // First: categories in subcategories_order, in that order.
    // Then: any categories for this section that weren't in the order array.
    const ordered = catsInSection.filter(c => orderSet.has(c.id));
    const unordered = catsInSection.filter(c => !orderSet.has(c.id));
    // Build final sequence by following the order list, then append unordered.
    const orderedIds = (sections.find(s => s.id === sectionId)?.subcategories_order) || [];
    const byId = new Map(catsInSection.map(c => [c.id, c]));
    const seen = new Set();
    const final = [];
    for (const cid of orderedIds) {
      const c = byId.get(cid);
      if (c && !seen.has(c.id)) { final.push(c); seen.add(c.id); }
    }
    for (const c of unordered) {
      if (!seen.has(c.id)) { final.push(c); seen.add(c.id); }
    }

    for (const c of final) {
      const isIncome = c.is_income === true;
      const created = await api.createCategory({
        name: c.name,
        is_income: isIncome,
        group_id: sectionIdToActual.get(sectionId),
      });
      categoryIdToActual.set(c.id, created);
    }
  }
  // Any categories with missing/foreign section_id (shouldn't happen, but be safe).
  for (const c of orphans) {
    const isIncome = c.is_income === true;
    const created = await api.createCategory({ name: c.name, is_income: isIncome });
    categoryIdToActual.set(c.id, created);
    logger.warn(`  category "${c.name}" had no valid section; created without group`);
  }

  logger.info(`  ${sectionIdToActual.size} category groups, ${categoryIdToActual.size} categories`);
  return { sectionIdToActual, categoryIdToActual };
}

// =========================================================================
// PHASE B — Payees
// =========================================================================
async function importPayees(payees) {
  const payeeNameToActual = new Map();
  for (const p of payees) {
    const created = await api.createPayee({ name: p.name });
    payeeNameToActual.set(p.name, created);
  }
  logger.info(`  ${payeeNameToActual.size} payees`);
  return payeeNameToActual;
}

// =========================================================================
// PHASE B.5 — Income category
// =========================================================================
// Actual auto-creates an "Income" pseudo-category (with `is_income: true`)
// in a default "Income" group. We need to find that category so we can
// route Budgetwise "Left to Budget" inflows to it (otherwise Actual sees
// zero income and "toBudget" goes negative for every month).
async function ensureIncomeCategory() {
  const existing = await api.getCategories();
  const income = existing.find(c => c.is_income && c.name.toLowerCase() === 'income');
  if (income) {
    logger.info(`  using existing Income category (${income.id})`);
    return income.id;
  }
  // Create the Income group + category if it doesn't exist
  let incomeGroup = (await api.getCategoryGroups()).find(g => g.is_income);
  if (!incomeGroup) {
    incomeGroup = await api.createCategoryGroup({ name: 'Income', is_income: true });
  }
  const created = await api.createCategory({
    name: 'Income',
    is_income: true,
    group_id: incomeGroup.id,
  });
  logger.info(`  created Income category (${created})`);
  return created;
}

// =========================================================================
// PHASE C.5 — Transfer payees (one per account)
// =========================================================================
// When we import an outflow half of a transfer pair, Actual needs to know
// that the transaction is a transfer so it can auto-create the matching
// inflow half. This is signaled via the payee's `transfer_acct` field.
//
// Actual auto-creates transfer payees on demand when it sees a transaction
// with `transfer_acct` payee — but ONLY when the runTransfers pass has a
// payee set. To be safe, we find (or create) transfer payees here.
//
// Returns: Map<Actual accountId, transfer payeeId>
async function ensureTransferPayees(accountIdToActual) {
  // Try to discover existing transfer payees (Actual may have auto-created some)
  const allPayees = await api.getPayees();
  const transferPayeeByAccount = new Map();
  for (const p of allPayees) {
    if (p.transfer_acct) transferPayeeByAccount.set(p.transfer_acct, p.id);
  }
  // Create any missing
  for (const [, acctId] of accountIdToActual) {
    if (!transferPayeeByAccount.has(acctId)) {
      // Transfer payees need a name. Actual doesn't show this in UI by default;
      // it's only used internally for the transfer linkage. Use the account name.
      const acct = (await api.getAccounts()).find(a => a.id === acctId);
      const name = acct ? `Transfer: ${acct.name}` : `Transfer: ${acctId.slice(0, 8)}`;
      const created = await api.createPayee({ name, transfer_acct: acctId });
      transferPayeeByAccount.set(acctId, created);
    }
  }
  return transferPayeeByAccount;
}

// =========================================================================
// PHASE C — Accounts
// =========================================================================
//
// Initial balance: we DON'T pass an initialBalance to createAccount. Instead,
// the "Initial Balance" txs in transactions.json are imported as ordinary
// transactions at their original dates (uncategorized), which produces the
// correct account balances naturally.
//
// Why not use `createAccount(name, initialBalance)`? Because Actual
// automatically creates a synthetic "Starting Balances" transaction dated
// at the import time whenever initialBalance is non-zero, and that
// transaction is categorized in the Income group, contaminating the
// current month's `totalIncome`. For accounts whose IB tx is dated years
// before the import (e.g. student loans from 2021-01-01), this would
// otherwise drop a multi-thousand-dollar phantom income entry into the
// current month's budget.
//
// Initial balance = 0 (which is the default), so no synthetic tx is created
// and the IB tx from transactions.json carries the balance forward.
async function importAccounts(accounts) {
  const accountIdToActual = new Map();
  for (const a of accounts) {
    // For Actual: checking/savings/credit/etc are NOT set via createAccount (no type field);
    // we use just name + offbudget. Actual figures it out.
    const created = await api.createAccount(
      { name: a.name, offbudget: a.offbudget === true || a.off_budget === true },
      0,
    );
    accountIdToActual.set(a.id, created);
  }
  logger.info(`  ${accountIdToActual.size} accounts (initial balances via IB txs at their original dates)`);
  return accountIdToActual;
}

// =========================================================================
// PHASE D — Transfer payees
// =========================================================================
// =========================================================================
// PHASE E — Transactions
// =========================================================================
//
// Build the global skip-set of inflow transfer halves (Actual will auto-create
// them via runTransfers: true). Outflow halves get imported with their transfer
// payee, signaling Actual to create the matching inflow half.
//
// Budgetwise only stores the partner transaction id (transfer_target_transaction_id),
// not the destination account id. We resolve the destination account by looking
// up the partner tx's account_id.
function planTransfers(transactions) {
  const skipIds = new Set();
  const txById = new Map();
  for (const tx of transactions) txById.set(tx.id, tx);
  const outflowDestAccountById = new Map(); // Budgetwise id → destination Budgetwise accountId
  for (const tx of transactions) {
    if (tx.transfer_origin_transaction_id != null) {
      skipIds.add(tx.id);
    }
    if (tx.transfer_target_transaction_id != null) {
      const partner = txById.get(tx.transfer_target_transaction_id);
      if (partner && partner.account_id) {
        outflowDestAccountById.set(tx.id, partner.account_id);
      }
    }
  }
  return { skipIds, outflowDestAccountById };
}

// Build a single Actual transaction object from a Budgetwise tx (ordinary OR split parent).
// `subtransactions` is built separately and merged by buildParentsAndChildren.
//
// Actual's transaction fields (per @actual-app/api schema):
//   date: 'YYYY-MM-DD' string (required)
//   amount: integer cents (negative for outflow, positive for inflow)
//   payee: payee id (string)  -- NOT payee_id
//   category: category id (string)  -- NOT category_id
//   notes: string  -- NOT memo
//   cleared: boolean
//
// Special-case: Budgetwise's "Left to Budget" pseudo-category (category_id is
// null but category NAME is "Left to Budget") receives ~181 inflow txs that
// represent income entering the budget. Without routing these to Actual's
// Income category, Actual sees zero income and "toBudget" goes massively
// negative for every month.
function resolveCategoryId(bwTx, categoryIdToActual, incomeCategoryId) {
  if (bwTx.category_id != null) {
    return categoryIdToActual.get(bwTx.category_id) ?? null;
  }
  if (bwTx.category === 'Left to Budget' && incomeCategoryId) {
    return incomeCategoryId;
  }
  return null;
}

function buildActualTx(bwTx, accountIdToActual, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById) {
  const isInitialBalance = bwTx.payee === 'Initial Balance';
  let payeeId = null;
  if (!isInitialBalance) {
    // Transfer outflow → use the transfer payee for the destination account
    const destBwAcctId = outflowDestAccountById.get(bwTx.id);
    if (destBwAcctId) {
      const destActualId = accountIdToActual?.get(destBwAcctId);
      if (destActualId) {
        payeeId = transferPayeeByAccount.get(destActualId) ?? null;
      }
    }
    if (!payeeId && bwTx.payee && payeeNameToActual.has(bwTx.payee)) {
      payeeId = payeeNameToActual.get(bwTx.payee);
    }
  }
  return {
    // Budgetwise's `ltb_next` flag means "this income counts toward NEXT
    // month's budget". Shift the date forward by one month so Actual's
    // `incomeAvailable` (cumulative) matches BW's per-month `incomeForMonth`.
    // See scripts/oracle/prove-income-rule.js — without this shift, BW
    // shows 012021 income = $4974.77 but Actual would show it in 122020.
    date: effectiveDate(bwTx.date, bwTx.ltb_next),
    amount: signAmount(bwTx.amount, bwTx.type),
    payee: payeeId,
    category: resolveCategoryId(bwTx, categoryIdToActual, incomeCategoryId),
    notes: bwTx.memo || null,
    cleared: bwTx.approved === true,
  };
}

function buildSubtransactions(parentBw, parentActualId, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById) {
  return parentBw.child_transactions.map((c) => ({
    date: effectiveDate(c.date ?? parentBw.date, c.ltb_next),
    amount: signAmount(c.amount, c.type),
    payee: c.payee && payeeNameToActual.has(c.payee)
      ? payeeNameToActual.get(c.payee)
      : null,
    category: resolveCategoryId(c, categoryIdToActual, incomeCategoryId),
    notes: c.memo || null,
    cleared: c.approved === true,
    parent_id: parentActualId,
  }));
}

async function importTransactions({
  transactions,
  accountIdToActual,
  categoryIdToActual,
  payeeNameToActual,
  incomeCategoryId,
}) {
  const transferPayeeByAccount = await ensureTransferPayees(accountIdToActual);

  const { skipIds, outflowDestAccountById } = planTransfers(transactions);

  const byAccount = new Map();
  let initialBalanceImported = 0;
  let ltbRouted = 0;
  let outflowHalves = 0;
  let childrenHoisted = 0;
  for (const tx of transactions) {
    if (skipIds.has(tx.id)) continue;
    if (tx.payee === 'Initial Balance') initialBalanceImported++;
    if (tx.type === 'inflow' && tx.category === 'Left to Budget') ltbRouted++;
    if (outflowDestAccountById.has(tx.id)) outflowHalves++;
    if (!byAccount.has(tx.account_id)) byAccount.set(tx.account_id, []);
    byAccount.get(tx.account_id).push(tx);
  }
  if (initialBalanceImported > 0) {
    logger.info(`  ${initialBalanceImported} "Initial Balance" txs imported as ordinary txs (carries account balance from original date)`);
  }
  if (ltbRouted > 0) {
    logger.info(`  routing ${ltbRouted} "Left to Budget" inflows to Income category`);
  }
  logger.info(`  ${outflowHalves} transfer outflow halves will use transfer payees`);

  let importedCount = 0;
  let splitCount = 0;

  for (const [bwAccountId, txs] of byAccount) {
    const actualAccountId = accountIdToActual.get(bwAccountId);
    if (!actualAccountId) {
      logger.warn(`Skipping ${txs.length} txs for unknown account ${bwAccountId}`);
      continue;
    }

    const toImport = [];
    for (const tx of txs) {
      const isSplitParent = Array.isArray(tx.child_transactions) && tx.child_transactions.length > 0;

      if (!isSplitParent) {
        toImport.push(buildActualTx(tx, accountIdToActual, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById));
        continue;
      }

      // Split parent. Compute each child's effective date (raw date + ltb_next
      // shift, day-clamped) and the parent's effective date. If a child's
      // effective date differs from the parent's, Actual's `addTransactions`
      // -> `makeChild` (bundle.api.js:60825) would silently overwrite the
      // child date with the parent date, breaking BW's ltb_next semantics.
      // Hoist such children into separate top-level transactions.
      const parentEffectiveDate = effectiveDate(tx.date, tx.ltb_next);
      const keptSubs = [];
      const hoistedSubs = [];
      for (const c of tx.child_transactions) {
        const childEffectiveDate = effectiveDate(c.date ?? tx.date, c.ltb_next);
        if (childEffectiveDate === parentEffectiveDate) {
          keptSubs.push(c);
        } else {
          hoistedSubs.push(c);
        }
      }

      // Emit hoisted children as standalone top-level transactions.
      for (const c of hoistedSubs) {
        toImport.push(buildActualTx(c, accountIdToActual, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById));
        childrenHoisted++;
      }

      // 0 remaining children: skip the parent entirely (its amount was 0 in BW,
      // every dollar is now represented by the hoisted children).
      if (keptSubs.length === 0) continue;

      // 1 remaining child: collapse to a plain (non-split) transaction. Cleaner
      // UX than a 1-child split, and avoids makeChild's per-child clobbering.
      if (keptSubs.length === 1) {
        toImport.push(buildActualTx(keptSubs[0], accountIdToActual, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById));
        continue;
      }

      // 2+ remaining children: emit as a real split parent.
      const parentId = randomUUID();
      const parent = buildActualTx(tx, accountIdToActual, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById);
      parent.id = parentId;
      const subs = keptSubs.map((c) => {
        const sub = buildSubtransactions({ ...tx, child_transactions: [c] }, parentId, categoryIdToActual, payeeNameToActual, incomeCategoryId, transferPayeeByAccount, outflowDestAccountById);
        return sub[0];
      });
      parent.amount = subs.reduce((s, c) => s + c.amount, 0);
      parent.subtransactions = subs;
      toImport.push(parent);
      splitCount++;
    }

    await api.addTransactions(actualAccountId, toImport, { runTransfers: true, learnCategories: true });
    importedCount += toImport.length;
    logger.info(`  account ${bwAccountId.slice(0, 8)}…: ${toImport.length} txs (${splitCount} splits so far)`);
  }

  if (childrenHoisted > 0) {
    logger.info(`  hoisted ${childrenHoisted} subtransaction(s) to top-level (effective-date differed from parent)`);
  }
  logger.info(`  Imported ${importedCount} top-level transactions (${splitCount} split parents)`);
  return { skipIds, importedCount, splitCount, childrenHoisted };
}

// =========================================================================
// PHASE F — Budget amounts
// =========================================================================
// Budgetwise's `timeframe_categories` data is a list-of-lists: outer array has
// 2 groups (non-CC and CC); each group is an array of {category_id, timeframe, budgeted, ...}
// entries. Each entry's `timeframe` field is "MMYYYY" (e.g. "122020" for Dec 2020).
//
// Actual's `setBudgetAmount(month, categoryId, value)` writes one
// (month, category, amount) tuple. month is "YYYY-MM-DD" (day must be 1).
//
// We flatten the Budgetwise groups, skip CC entries (they're CC-payment budget
// tracking, not regular category budgets — Actual tracks these through the
// CC account's "Payment" pseudo-category), and translate MMYYYY → YYYY-MM-01.
async function importBudgets(timeframeCategories, categoryIdToActual) {
  if (!Array.isArray(timeframeCategories) || timeframeCategories.length === 0) {
    logger.info('  No budget amounts to import');
    return 0;
  }
  // Flatten: outer array of groups, each group is an array of entries
  const flat = timeframeCategories.flat();
  let count = 0;
  let ccSkipped = 0;
  let missing = 0;
  await api.batchBudgetUpdates(async () => {
    for (const entry of flat) {
      if (entry.is_cc) { ccSkipped++; continue; }
      if (!entry.category_id) { missing++; continue; }
      const catId = categoryIdToActual.get(entry.category_id);
      if (!catId) { missing++; continue; }
      // Convert "MMYYYY" → "YYYY-MM-01"
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

// =========================================================================
// ENTRY POINT
// =========================================================================
export async function populate(capture) {
  logger.section('Importing into Actual Budget (runImport)');

  const accounts   = unwrap(capture.accounts);
  const categories = unwrap(capture.categories);
  const sections   = capture.sections ? unwrap(capture.sections) : [];
  const payees     = capture.payees ? unwrap(capture.payees) : [];
  const txns       = unwrap(capture.transactions);
  const tfc        = capture.timeframeCategories ? unwrap(capture.timeframeCategories) : [];

  const { categoryIdToActual } = await importCategoryGroups(sections, categories);
  const payeeNameToActual = await importPayees(payees);
  const incomeCategoryId = await ensureIncomeCategory();
  const accountIdToActual = await importAccounts(accounts);

  // Transfer halves: outflow half uses transfer payee; inflow half auto-created by Actual.
  const tr = await importTransactions({
    transactions: txns,
    accountIdToActual,
    categoryIdToActual,
    payeeNameToActual,
    incomeCategoryId,
  });

  // NOTE: Budget amounts are written in a separate phase AFTER runImport
  // completes. Calling api.setBudgetAmount() inside the runImport callback
  // is silently dropped (verified by testing against @actual-app/api 25.x).
  // If you upgrade @actual-app/api and find budget amounts are now applied
  // inside runImport, the post-import pass will double-apply — check the
  // version guard in bin/import_budgetwise.js before removing it.
  // See bin/import_budgetwise.js for the post-runImport budget pass.

  logger.info('Done.');
  return {
    accounts: accountIdToActual.size,
    categories: categoryIdToActual.size,
    payees: payeeNameToActual.size,
    transactions: tr.importedCount,
    splits: tr.splitCount,
    skipIds: tr.skipIds.size,
    budgetEntries: 0, // filled in by post-runImport phase
    categoryIdToActual, // expose for budget pass
  };
}
