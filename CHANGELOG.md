# Changelog

## 0.1.3 (2026-08)

### Honor Budgetwise's `ltb_next` flag on income

When a Budgetwise "Left to Budget" inflow has `ltb_next=true`, BW attributes
the income to the NEXT month's budget (so a 2026-05-22 payroll shows up in
2026-06's `incomeForMonth`). The previous importer wrote the transaction
with `tx.date` directly, so Actual's `totalIncome[m]` would route it to
the wrong month — Actual's `incomeAvailable` is cumulative across months,
so a one-month shift propagates a non-trivial gap into the carryover chain.

A 81-month capture-side income oracle (`scripts/oracle/prove-income-rule.js`)
confirms: with `ltb_next` shift applied, 73/81 months match BW's
`incomeForMonth` exactly. (The remaining 8 months diverge by small amounts
that appear to be stale BW data — the chain itself is consistent.)

**Code change**:
- `lib/normalize.js`: new `shiftISODateMonths(s, delta=1)` — pure date
  arithmetic, no Date object (avoids TZ surprises).
- `lib/populate.js`: `buildActualTx` and `buildSubtransactions` shift the
  date by `+1 month` when `bwTx.ltb_next === true`.
- `test/normalize.test.js`: 6 new tests for `shiftISODateMonths`
  (same-year, year-rollover, zero/no-op, day-edge, non-string pass-through).

### Residual gap

After the SUM and ltb_next fixes, Actual's `toBudget` and BW's
`leftToBudget` still differ for some months.

**Actual's formula** (from `@actual-app/api` source):
```
to-budget[m] =
    available-funds[m]
  + last-month-overspent[m]   // per-category overspending carried forward
  + total-budgeted[m]         // negative cents
  - buffered[m]
```

**BW's formula** (from `ltbBreakdown` chain, 80/80 verified):
```
leftToBudget[m] = income[m] + ltb[m-1] - budgeted[m]
```

The difference: Actual tracks `last-month-overspent` that BW doesn't.
This is fundamental, not a fixable import bug.

## 0.1.2 (2026-08)

### Budget row consolidation: SUM instead of first-wins

The v0.1.1 fix used "lowest-id-wins" to collapse duplicate
`/timeframe_categories` rows, based on a single hand-checked UI
observation. An oracle cross-check against the
capture's own `ltbBreakdown.budgetedForMonth` field — Budgetwise's
authoritative per-month total — revealed that the real rule is **SUM**
across all rows per `(timeframe, category_id)`, not first-wins. For
81/81 ltbBreakdown months, summing all raw rows matches the ltb total
exactly to the penny. First-wins under-budgets by ~$331 cumulative
across the captured dataset; this is the source of the lingering
"Left to Budget" gap between Actual and Budgetwise UIs.

Reader now consolidates per `(timeframe, category_id)` (and
`(timeframe, cc_account_id)` for CC rows), summing `budgeted` across
all contributing rows. CC rows are id-deduped first because the BW
API may emit the same CC row twice with different `spent` values;
the `budgeted` value is identical and should count once.

The v0.1.1 `validateBudgets` post-import check still passes — the
writer and the validator share `expectedBudgetEntries`, so they are
both updated by this fix. Re-running the import will write the
corrected sums to Actual; existing imports will show drift on the
cells that were previously under-budgeted (3 non-CC categories in
the captured dataset).

## 0.1.1 (2026-08)

### Budget row dedup + per-cell post-import validation

The Budgetwise `/timeframe_categories` endpoint returns one row per
save, with the same spent but potentially different budgeted. Without
dedup, `setBudgetAmount` calls were last-write-wins per (month, cat),
silently overwriting real budgets with trailing `$0` echo rows. Reader
now collapses to one row per `(timeframe, category_id)` (with SUM of
all `budgeted` values; see 0.1.2), and a post-import pass re-reads
Actual's budget cells and reports drift against the consolidated
capture. `--fix` writes the expected values non-interactively; in a
TTY the tool prompts `fix` / `keep` / `fail`.

Also fixes a crash on transfer outflow halves
(`accountIdToActual` was referenced but not defined in
`buildActualTx`'s signature) — every v0.1.0 import with transfers
errored at the first transfer outflow.

### Unique budget-name resolution

`--name <name>` now picks the next free counter suffix if a file with
that name already exists ('<name>-2', '<name>-3', …), so re-running
no longer silently leaves duplicate-name files on the server. To
re-run with the exact same name, delete the prior file in Actual →
Settings → Files first.

## 0.1.0 (2026-08)

Initial public release. Migrates a Budgetwise budget to Actual Budget
via `runImport`. Verified against my.budgetwise.io circa 2026-08.

Features:

- Read-only Budgetwise data capture (Express API)
- Categories + sections + payees + accounts + transactions
- Transfer pairs (linked across accounts)
- Split transactions (parent + children, parent.amount = Σ child.amounts)
- Per-month budget amounts
- Payee dedup: exact-match collapses duplicates; case-insensitive +
  apostrophe-normalized merges variants
- Fuzzy candidate warnings (substring / edit-distance pairs) — not auto-merged

Limitations (see README):

- Pseudo-income categories (UI display vs. data) — see README
- User settings (date format, currency) not auto-imported
- Budgetwise API is undocumented/reverse-engineered
- `setBudgetAmount` silently no-ops inside `runImport`; budget pass is
  post-import
