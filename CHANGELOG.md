# Changelog

## Unreleased

### Smoother post-import transition

After a Budgetwise → Actual migration the user now gets two artifact files in the capture directory:

- **`MIGRATION_REPORT.md`** — bundled: settings migration outcome, per-month LTB reconciliation (BW `ltbBreakdown` vs Actual `getBudgetMonth`), per-account balance comparison, credit-card payment mapping, first-actions checklist excerpt.
- **`FIRST_ACTIONS.md`** — standalone checklist of manual follow-up tasks.

#### Settings migration (programmatic + guide fallback)

The post-import pass now attempts to push Budgetwise's per-budget preferences into Actual via the internal `preferences/save` handler (`api.lib.send`):

| BW setting       | Actual pref       | Status |
|------------------|-------------------|--------|
| `date_format`    | `dateFormat`      | Whitelisted; `YY`→`yyyy` translated |
| `first_day`      | `firstDayOfWeekIdx` | Stringified int |
| `decimal`+`thousands` | `numberFormat` | Mapped to one of 5 known format enums |
| `global_ltb`     | `budgetType`      | `false`→`envelope`, `true`→`tracking` |

Anything that fails the API call or has no programmatic equivalent is surfaced in the report's Manual Settings Guide section with concrete UI paths.

#### Reconciliation report

For each month in `ltbBreakdown.json`, the report fetches Actual's `getBudgetMonth(m)` and compares `incomeForMonth`/`leftToBudget`/`fwdFromLastMonth`/`budgetedForMonth` against `totalIncome`/`toBudget`/`fromLastMonth`/`totalBudgeted`. Per-account balances from BW's `current_bal` are also compared against Actual's transaction-summed balances. ~1 second for the captured dataset (~80 months).

#### Credit-card payment notes

Budgetwise budgets CC payments explicitly; Actual tracks them automatically via each creditcard account's built-in **Payment** pseudo-category. The report explains this mapping and surfaces the BW "budgeted" values per (card, month) so users can spot-check Actual's computed "available to pay".

#### First Actions checklist

Generated from signals already detected during import: fuzzy payee candidates (re-uses `findFuzzyCandidates`), uncategorized transactions, non-Income categories with net-positive Actual balance (likely income mis-categorized in BW), settings that didn't migrate, and any budget-cell drift from the existing verification step.

### Code changes

- New modules (each with unit tests, 23 new tests total):
  - `lib/settings-migrate.js` — BW prefs → Actual mappings; uses injected `send` function so tests don't reach into `api.lib`
  - `lib/recon-report.js` — pure comparison logic; injected `getMonth` + `getBalance` for testability
  - `lib/cc-notes.js` — CC payment migration notes
  - `lib/first-actions.js` — checklist composition
  - `lib/report-writer.js` — shared `writeArtifact`/`writeArtifactRequired` helper
- `lib/reader.js`: `findFuzzyCandidates` is now a top-level export (no behavior change)
- `bin/import_budgetwise.js`:
  - Settings migration runs after `runImport` + budget pass (synced prefs are per-file scoped, not part of `runImport`'s transaction)
  - Reports written between postflight and `validateBudgetsOrExit` so users always have a record even if the budget-drift check exits 1
  - `--no-verify` still produces the lighter reports (uncategorized count, account balances) without the per-cell budget drift sweep

### Bug fixes from review pass

- **`populate()` now exposes `accountIdToActual`.** The first iteration didn't thread the BW→Actual account id map into its return value, so `runReconReport` always saw an empty map and marked every account as "no matching Actual account" in the per-account balance comparison. Fixed by adding `accountIdToActual` to the return object (`lib/populate.js`) and adding a regression test that uses Node's `--experimental-test-module-mocks` to stub `@actual-app/api` and verify the return shape.
- **Drift count surfaces in the first-actions checklist.** `validateBudgetsOrExit` was split into `detectBudgetDrift` (read-only, runs before report writing) and `applyDriftDecision` (the fix/keep/fail/exit logic, runs after). Reports now include the drift cell count.
- **Bundled report heading hierarchy is clean.** `composeMarkdown` strips the leading `# Title` from each section body so we don't end up with h1s nested under h2 sections. `settingsMigrationGuide` now returns body-only markdown (its h1 is implied by the containing section's `## heading`).

### Other improvements

- **`ccNotes` lists orphan CC ids.** If an `is_cc` row references an account id that isn't in `accounts.json`, the id is now surfaced in a "Unlisted accounts" section at the end of the CC report so the user can fix their capture.
- **All-fail test for `applySyncedPrefs`.** If every `preferences/save` call rejects (e.g., `@actual-app/api` internal API changes), all mappings are recorded as failures and the guide fallback still surfaces.

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
