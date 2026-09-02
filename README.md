# budgetwise-to-actual

Unofficial, personal-use migration tool from [Budgetwise](https://my.budgetwise.io) to [Actual Budget](https://actualbudget.org/).

> **⚠️ Disclaimer.** Unofficial. Not affiliated with Budgetwise Inc. or Actual Budget. Personal use only — no warranty, no support, no liability. See [NOTICE](./NOTICE) for the full text.

> **Verified against the my.budgetwise.io deployment (user-facing web app, circa 2026-08).** Not tested against alpha.budgetwise.io, self-hosted deployments, mobile clients, older or newer versions, or forks. No guarantees of compatibility.

## What it does

This tool captures all your Budgetwise data (accounts, categories, payees, transactions, splits, transfers, budgets) and recreates it in a fresh Actual Budget file via the `runImport` API.

**It is read-only against Budgetwise** — only POSTs are login requests. **It is write-only against Actual Budget** — creates a new budget file, populates it.

## Features

- Read-only Budgetwise data capture (Express API)
- Idempotent Actual Budget file creation via `runImport`
- Categories + sections + payees + accounts
- Transaction transfers (linked pair across accounts)
- Split transactions
- 83 months of per-category budget history
- Payee dedup: exact-match collapses duplicates; case-insensitive + apostrophe-normalized merges variants like `McDonald's`/`mcdonalds`
- Fuzzy candidate warnings: substring and edit-distance pairs are logged but NOT auto-merged (you decide)

## Limitations

These won't be fixed in v0.1.0:

- **Programmatic file deletion isn't supported** by the `@actual-app/api` version we depend on. After a successful import, you'll need to delete the test file manually in Actual's UI (Settings → Files → Delete).
- **Pseudo-income categories (UI display vs. data).** The Budgetwise UI
  shows inflows to the `Left to Budget` pseudo-category with a computed
  label like "Income for June" — that's a display name only, the
  underlying category is literally `Left to Budget`. Our importer
  detects `Left to Budget` and routes those inflows to Actual's built-in
  Income pseudo-category, which is why "To Budget" shows sensible
  (often-positive) numbers after import. **If you have any *other*
  income categories in your Budgetwise data** (categories you created
  yourself that you think of as income), they'll import as regular
  expense categories; flip them to `is_income: true` in Actual manually
  if needed.
- **Settings (date format, currency symbol, etc.)** are partially auto-imported — see "Post-import reports" below. Currency symbol and per-budget currency settings still need to be configured by hand in Actual → Settings → Preferences.
- **The Budgetwise API is unofficial.** We reverse-engineered it for personal use; behavior may change. See [docs/budgetwise-api.md](./docs/budgetwise-api.md) for what we documented.
- **`bin/smoke.js` creates a real file on your Actual server.** It can't be auto-deleted. The file is named `__smoke-test-budget`.

## Post-import reports

After every run, two markdown files are written to the **capture directory** (the directory you passed via `--capture`):

- **`MIGRATION_REPORT.md`** — bundled report with four sections: settings migration outcome, per-month LTB reconciliation (BW `ltbBreakdown` vs Actual's `getBudgetMonth`), credit-card payment mapping explanation, and a first-actions checklist excerpt.
- **`FIRST_ACTIONS.md`** — standalone checklist of manual follow-up tasks (fuzzy payees to review, income candidates to flip, budget drift to fix, etc.).

These files make it easy to verify the migration succeeded before treating the new budget as authoritative. The reconciliation report runs in about a second on the typical 80-month dataset.

## Quick start

```bash
git clone https://github.com/ammunoz/budgetwise-to-actual.git
cd budgetwise-to-actual
npm install
cp .env.example .env
# Edit .env with your credentials
node bin/smoke.js               # verify Actual connectivity
node bin/export_budgetwise.js --budget Budget --out ../captured/budgetwise-export
node bin/import_budgetwise.js --capture ../captured/budgetwise-export --name "Budgetwise-Migration"
```

Open Actual at your server URL, switch to `Budget-Migration`, verify the data, then delete the empty test files.

## Prerequisites

- Node 22+
- An Actual Budget server ([setup docs](https://actualbudget.org/docs/install/))
- A Budgetwise account at my.budgetwise.io with at least one budget

## Configuration

`.env` keys (copy from `.env.example`):

| Var | Required | Default | Description |
|---|---|---|---|
| `ACTUAL_SERVER_URL` | yes | — | URL of your Actual server |
| `ACTUAL_PASSWORD` | yes | — | Your Actual password |
| `ACTUAL_DATA_DIR` | no | `./.actual-data` | Local cache directory |
| `BUDGETWISE_EMAIL` | yes | — | Budgetwise email |
| `BUDGETWISE_PASSWORD` | yes | — | Budgetwise password |
| `BUDGETWISE_BUDGET_ID` | yes | — | UUID of the budget to operate on |
| `BUDGETWISE_API_URL` | no | `https://ex.budgetwise.io` | Override only if testing against a non-production host |
| `CAPTURED_DIR` | no | `../captured` | Where capture JSON files go |

By default, captures are written **outside** the project directory (to `../captured`). This keeps sensitive financial data out of your project folder. You can override with `CAPTURED_DIR=./captured` if you prefer.

## CLI flags

### `node bin/export_budgetwise.js [options]`

```
--budget <name|id>   Budget to export. Name resolves via /api/budgets.
                     Defaults to BUDGETWISE_BUDGET_ID from .env.
--out <dir>          Output directory. Defaults to ../captured/budgetwise-<name>.
--force              Overwrite existing manifest.json without warning.
--verbose            Debug-level logging.
--help, -h           Show this help.
```

### `node bin/import_budgetwise.js [options]`

```
--capture <dir>      Capture directory (default: ../captured/recon-budget).
--name <name>        Budget file name in Actual
                     (default: 'Budgetwise-Migration-Budget'). If a file
                     with that name already exists, a counter suffix is
                     appended automatically ('Budget' → 'Budget-2' → …).
                     To re-run with the exact same name, delete the prior
                     file in Actual → Settings → Files first.
--no-verify          Skip post-flight verification queries.
--fix                If budget drift is detected, write the expected values
                     non-interactively (use with care — trusts the capture).
--verbose            Debug-level logging.
--help, -h           Show this help.
```

### `node bin/smoke.js`

Verifies `ACTUAL_SERVER_URL` + `ACTUAL_PASSWORD` work and `runImport` succeeds. Creates `__smoke-test-budget` on the server (delete it manually later via Settings → Files).

## How it works

```
[my.budgetwise.io]
       │  POST /api/sessions (login, get JWT)
       │  GET /api/budgets/{id}/{accounts|categories|...}
       ▼
[lib/express-client.js]    — read-only Budgetwise client
       │
       ▼
captured/*.json files       — local JSON snapshot
       │
       ▼
[lib/populate.js]            — called inside api.runImport()
       │
       │  api.createCategoryGroup / Category / Payee / Account
       │  api.addTransactions(..., { runTransfers: true, learnCategories: true })
       ▼
[New file in Actual]         — `Budgetwise-Migration-Budget`
```

Budget amounts are written in a **separate post-import pass** because `setBudgetAmount` is silently dropped inside `runImport` (verified against `@actual-app/api` 25.x).

## Privacy

This tool writes your entire Budgetwise financial data to disk as plain JSON files. These captures contain personally identifiable information (PII) and sensitive financial data.

- **Don't commit captures to version control.** They are gitignored; keep it that way.
- **Delete the capture directory after migration.** The JSON files remain on disk indefinitely otherwise.
- **This tool runs locally.** No data is sent to the author or any third party by the tool itself. However, the Budgetwise and Actual APIs you connect to are operated by their respective owners; their data-handling practices are not the author's responsibility.

## Reverse-engineered API

The Budgetwise Express API used by this tool is undocumented. We've documented what we found in [docs/budgetwise-api.md](./docs/budgetwise-api.md). Do not treat that documentation as a contract — Budgetwise may change behavior at any time.

## Contributing / Issues

Open a GitHub issue at https://github.com/ammunoz/budgetwise-to-actual/issues. **Do not attach credentials or captured JSON files to issues** — see [SECURITY.md](./SECURITY.md).

## License

This is free and unencumbered software released into the public domain.
See [LICENSE](./LICENSE) (The Unlicense).

Disclaimer and additional notices — see [NOTICE](./NOTICE).

## Note on copyright

Portions of this codebase were drafted with AI assistance. Releasing
under The Unlicense rather than a copyright-bearing license (MIT,
BSD, Apache) reflects the author's position that it's inappropriate
to assert copyright over AI-drafted code. You can do whatever you
want with this software; please don't sue the author.
