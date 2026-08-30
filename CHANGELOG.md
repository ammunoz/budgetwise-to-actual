# Changelog

## 0.1.0 (2026-08)

Initial public release. Migrates a Budgetwise budget to Actual Budget
via `runImport`. Verified against my.budgetwise.io circa 2026-08.

Features:

- Read-only Budgetwise data capture (Express API)
- Idempotent Actual Budget file creation via `runImport`
- Categories + sections + payees + accounts + transactions
- Transfer pairs (linked across accounts)
- Split transactions (parent + children, parent.amount = Σ child.amounts)
- Per-month budget amounts (83 months)
- Payee dedup: exact-match collapses duplicates; case-insensitive +
  apostrophe-normalized merges variants
- Fuzzy candidate warnings (substring / edit-distance pairs) — not auto-merged

Limitations (see README):

- Programmatic file deletion not exposed by `@actual-app/api` 25.x
- Pseudo-income categories (UI display vs. data) — see README
- User settings (date format, currency) not auto-imported
- Budgetwise API is undocumented/reverse-engineered
- `setBudgetAmount` silently no-ops inside `runImport`; budget pass is
  post-import
