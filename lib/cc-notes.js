// Credit-card payment notes generator.
//
// Budgetwise budgets CC payment rows explicitly (one row per CC account per
// month in `timeframeCategories` with is_cc=true). Actual Budget tracks CC
// payments implicitly: each creditcard account has a built-in "Payment"
// pseudo-category that auto-sums the month's outflows from that account to
// the on-budget account that paid it, and the budget cell tracks the
// "available to pay" amount.
//
// The mismatch can surprise users when they open Actual and see different
// numbers than BW showed. This module produces a section explaining:
//   - which CC accounts were imported
//   - the BW "CC payment" budget per (account, month) from the capture
//   - the Actual behavior they'll see
//   - the "available to pay" they should expect to find in Actual

import { unwrap } from './reader.js';

const fmtDollars = (n) => `$${Number(n).toFixed(2)}`;

function mmYYYYtoPretty(s) {
  if (!s || s.length !== 6) return s;
  const mm = parseInt(s.slice(0, 2), 10);
  const yyyy = s.slice(2, 6);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[mm - 1] || '???'} ${yyyy}`;
}

// Sum CC-payment budgeted dollars per (cc_account_id, month). Mirrors the
// non-CC SUM rule but for the is_cc branch — we deduplicate CC rows by id
// first (BW emits duplicates with different `spent`), then sum `budgeted`.
// Same logic the import path applies at lib/populate.js (skipped at the
// setBudgetAmount layer because Actual handles CC via the Payment pseudo-
// category); here we surface that data instead of dropping it.
export function ccPaymentRows(timeframeCategories) {
  // The capture may be wrapped as {data: [...]} (single flat list) or as
  // {data: [[...], [...]]} (BW's two-group envelope). Flatten transparently.
  const unwrapped = unwrap(timeframeCategories);
  const flat = Array.isArray(unwrapped) && Array.isArray(unwrapped[0])
    ? unwrapped.flat()
    : unwrapped;
  if (!Array.isArray(flat)) return [];

  const summed = new Map(); // `${tf}|${ccId}` -> { tf, ccId, budgeted }
  const seenIds = new Map(); // key -> Set<id>

  for (const e of flat) {
    if (!e.is_cc) continue;
    if (!e.cc_account_id || !e.timeframe) continue;
    const key = `${e.timeframe}|${e.cc_account_id}`;
    if (!seenIds.has(key)) seenIds.set(key, new Set());
    const ids = seenIds.get(key);
    if (ids.has(e.id)) continue;
    ids.add(e.id);

    const amt = parseFloat(e.budgeted || '0');
    if (!summed.has(key)) {
      summed.set(key, { tf: e.timeframe, ccId: e.cc_account_id, budgeted: 0 });
    }
    summed.get(key).budgeted += amt;
  }

  const out = [];
  for (const v of summed.values()) {
    out.push({
      timeFrame: v.tf,
      ccAccountId: v.ccId,
      budgeted: v.budgeted,
    });
  }
  out.sort((a, b) => a.timeFrame.localeCompare(b.timeFrame) || a.ccAccountId.localeCompare(b.ccAccountId));
  return out;
}

// Public: build the markdown section. Pass the deduped capture (so
// timeframeCategories has already been collapsed) and the BW accounts.
export function ccNotes(capture, accounts = null) {
  const accountsFlat = accounts ?? unwrap(capture.accounts);
  const allAccounts = Array.isArray(accountsFlat) ? accountsFlat : [];
  // CC-payment pseudo-category behavior is most prominent for creditcard
  // accounts, but Budgetwise stores these rows for any account that is paid
  // out of another (loans, lines of credit). Include every account that
  // has at least one is_cc row referencing it — labelled as "credit-style"
  // in the report so the user knows Actual will treat creditcard accounts
  // via the Payment pseudo-category and other debt accounts differently.
  const rows = ccPaymentRows(capture.timeframeCategories);
  const referencedIds = new Set(rows.map((r) => r.ccAccountId));
  const knownIds = new Set(allAccounts.filter((a) => a && a.id).map((a) => a.id));
  const orphanIds = [...referencedIds].filter((id) => !knownIds.has(id));
  const ccAccounts = allAccounts.filter((a) => a && referencedIds.has(a.id));
  // Stable order: creditcard first, then everything else, alphabetical.
  ccAccounts.sort((a, b) => {
    const aCredit = a.type === 'creditcard' || a.type === 'credit' || a.type === 'credit_card';
    const bCredit = b.type === 'creditcard' || b.type === 'credit' || b.type === 'credit_card';
    if (aCredit !== bCredit) return aCredit ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const lines = [];
  lines.push('# Credit Card Payment Migration Notes');
  lines.push('');
  lines.push('Budgetwise budgets credit-style payments as explicit per-(account, month) rows in `timeframeCategories` (the `is_cc` flag). Actual Budget tracks credit-card payments automatically via each **creditcard** account\'s built-in **Payment** pseudo-category — auto-calculating "available to pay" from month-of-outflows plus prior carryover. For loan / debt accounts, Actual does not have an equivalent pseudo-category; the values here will appear as ordinary budget rows (if you choose to import them).');
  lines.push('');

  if (ccAccounts.length === 0) {
    lines.push('_No "is_cc" budget rows appear in the capture — there are no payment cells to verify._');
    return lines.join('\n') + '\n';
  }

  lines.push(`## ${ccAccounts.length} account(s) referenced by CC-style payment rows`);
  lines.push('');
  for (const a of ccAccounts) {
    const tag = (a.type === 'creditcard' || a.type === 'credit' || a.type === 'credit_card')
      ? '**Credit card**'
      : `_Other type: \`${a.type}\`_`;
    lines.push(`- **${a.name || '(unnamed)'}** ${tag} _(Budgetwise id \`${a.id}\`)_`);
  }
  lines.push('');

  if (rows.length === 0) {
    lines.push('_No CC payment budget rows appear in the capture — Actual will start the "Payment" category from $0 carryover._');
    return lines.join('\n') + '\n';
  }

  lines.push(`## Budgetwise CC payment budget rows (${rows.length})`);
  lines.push('');
  lines.push('These are what Budgetwise showed as "budgeted for the CC payment category" per month. Actual will not show these exact numbers — it derives them from the income side (transfers paid to the card). Use this table as ground truth for spot-checking the initial state.');
  lines.push('');

  // Map cc_account_id -> account name for friendlier output
  const ccIdToName = new Map(ccAccounts.map((a) => [a.id, a.name || a.id.slice(0, 8)]));

  // Group by cc_account_id so each card gets its own table.
  const byCc = new Map();
  for (const r of rows) {
    if (!byCc.has(r.ccAccountId)) byCc.set(r.ccAccountId, []);
    byCc.get(r.ccAccountId).push(r);
  }

  for (const [ccId, items] of byCc) {
    const name = ccIdToName.get(ccId) || ccId.slice(0, 8);
    lines.push(`### ${name}`);
    lines.push('');
    lines.push('| Month | BW budgeted |');
    lines.push('|---|---|');
    for (const r of items) {
      lines.push(`| ${mmYYYYtoPretty(r.timeFrame)} | ${fmtDollars(r.budgeted)} |`);
    }
    lines.push('');

    const total = items.reduce((s, r) => s + r.budgeted, 0);
    lines.push(`_Total over ${items.length} months: **${fmtDollars(total)}**_`);
    lines.push('');
  }

  lines.push('## What to expect in Actual');
  lines.push('');
  lines.push('- Each CC account\'s **Payment** cell will reflect **available-to-pay** = outstanding balance minus payments already made — not the Budgetwise "budgeted" number.');
  lines.push('- Carryover from previous months rolls forward automatically; you do not need to set the Payment budget yourself.');
  lines.push('- The first month after import will look like the starting state; discrepancies between BW and Actual are most visible on the month of import.');
  lines.push('');

  if (orphanIds.length > 0) {
    lines.push('## Unlisted accounts (referenced but not in accounts.json)');
    lines.push('');
    lines.push(`The following BW account ids had \`is_cc\` rows but did not appear in \`accounts.json\`. Their budget rows are still included in the tables above, but they are not listed in the "referenced accounts" section. If these are real accounts, add them to \`accounts.json\` (re-run the export) and re-import.`);
    lines.push('');
    for (const id of orphanIds) lines.push(`- \`${id}\``);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}
