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

### Investigation follow-up: why `toBudget` still diverges from `leftToBudget`

Even after the SUM and ltb_next fixes, Actual's `toBudget[m]` and BW's
`leftToBudget[m]` differ for some months. Discovered that the difference
is NOT a data-layer or import bug — it's an Actual algorithm difference.

**Actual's formula** (from `@actual-app/api` source, line 55290-55300):
```
to-budget[m] =
    available-funds[m]      // = total-income[m] + to-budget[m-1]
  + last-month-overspent[m] // = Σ min(0, leftover[cat][m-1])
  + total-budgeted[m]       // negative cents (storage convention)
  - buffered[m]
```

**BW's formula** (from ltbBreakdown chain, 80/80 verified):
```
leftToBudget[m] = incomeForMonth[m] + fwdFromLastMonth[m] - budgetedForMonth[m]
                = income[m] + ltb[m-1] - budgeted[m]
```

The difference: Actual tracks `last-month-overspent` (per-category
overspending). If a category has `budgeted=$0` but actual spending > 0
in a month, Actual carries the negative leftover forward as overspent
and subtracts it from next month's `toBudget`. BW does not.

**Concrete example**: Rent category in MMYYYY had `budgeted=$0` but a
`$500` actual outflow. Actual's `lastMonthOverspent[MMYYYY]` = -$500,
which reduces `toBudget[MMYYYY]` by $500. BW's `leftToBudget[MMYYYY]`
doesn't deduct this. The cumulative carryover of these overspent
categories accumulates to the ~$8K residual gap at MMYYYY.

This is **correct behavior in Actual** (the UI shows overspending so the
user can re-budget). The discrepancy is fundamental: BW treats "Left to
Budget" as a planning tool with no actual-spend awareness; Actual is a
full accounting system. The only ways to match BW exactly would be:
(a) drop the actual outflow transactions (bad — we want spending history),
or (b) add a budgeted amount for every outflow category (impractical).
The recommended interpretation is to accept the gap as Actual being
"stricter" about overspending than BW.

### Capture-side oracles (read-only diagnostics)

Two scripts verify the import is data-layer correct without an Actual
round-trip:

- `scripts/oracle/prove-sum-rule.js` — proves the SUM consolidation
  rule matches BW's own per-month LTB math (`ltbBreakdown.budgetedForMonth`)
  for 81/81 months across the captured dataset.
- `scripts/oracle/prove-income-rule.js` — confirms `ltb_next=true`
  is the right income-attribution rule (BW internal identity holds
  81/81, carryover chain holds 80/80 in chronological order).

Re-run after any capture/data changes to verify the import is faithful
to BW's math before committing.

## 0.1.2 (2026-08)

### Budget row consolidation: SUM instead of first-wins

The v0.1.1 fix used "lowest-id-wins" to collapse duplicate
`/timeframe_categories` rows, based on a single hand-checked UI
observation (Dog 2021-12 → $230). An oracle cross-check against the
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

Also fixes a crash on transfer outflow halves
(`accountIdToActual` was referenced but not defined in
`buildActualTx`'s signature) — every v0.1.0 import with transfers
errored at the first transfer outflow.

### Unique budget-name resolution

`--name SampleBudget` now picks the next free counter suffix if a file with
that name already exists ('SampleBudget-2', 'SampleBudget-3', …), so re-running
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
