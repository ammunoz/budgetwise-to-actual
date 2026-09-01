# Changelog

## 0.1.1 (2026-08)

### Budget row dedup + per-cell post-import validation

The Budgetwise `/timeframe_categories` endpoint returns one row per
save, with the same spent but potentially different budgeted. Without
dedup, `setBudgetAmount` calls were last-write-wins per (month, cat),
silently overwriting real budgets with trailing `$0` echo rows. Reader
now collapses to the lowest-id row (matches Budgetwise UI), and a
post-import pass re-reads Actual's budget cells and reports drift
against the deduped capture. `--fix` writes the expected values
non-interactively; in a TTY the tool prompts `fix` / `keep` / `fail`.

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
