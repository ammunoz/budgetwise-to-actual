# Budgetwise Express API (reverse-engineered)

This is **unofficial** documentation of the Budgetwise HTTP API used
by this migration tool. It was reverse-engineered by observing
requests and responses during personal use. **It is not a contract;
Budgetwise may change behavior at any time without notice.**

## Conventions

- **Base URL**: `https://ex.budgetwise.io/api`
  - Override via `BUDGETWISE_API_URL` env var for testing non-prod hosts
- **Auth**: `Authorization: Bearer: <jwt>` (note the colon)
  - Acquire via `POST /sessions` (login)
- **Response shape**: `{ "data": [...] | {...} }` for most endpoints
- **Cache buster**: endpoints that paginate per-month data
  (`timeframe_categories`, `ltb_breakdown`) require a `?date=<iso>`
  query parameter; without it they return 400.

## Endpoints used

### Auth

#### `POST /sessions`

Login.

Request body:
```json
{ "email": "...", "password": "..." }
```

Response:
```json
{
  "meta": { "token": "<jwt>" }
}
```

JWT lifetime is ~30 days.

### Budgets

#### `GET /budgets`

List the user's budgets.

Response:
```json
{ "data": [{ "id": "...", "name": "..." }] }
```

### Capture endpoints (per-budget, read-only)

All capture endpoints are GETs under `/budgets/{budget_id}/...`.

| Endpoint | Returns |
|---|---|
| `/budgets/{id}/accounts` | List of accounts (id, name, type, current_bal, off_budget) |
| `/budgets/{id}/categories` | List of categories (id, name, section_id, is_income) |
| `/budgets/{id}/sections` | List of category groups (id, name, subcategories_order) |
| `/budgets/{id}/payees` | List of payees (id, name) |
| `/budgets/{id}/settings` | UI preferences (date_format, first_day, etc.) |
| `/budgets/{id}/transactions` | All transactions (id, date, amount, type, payee, category_id, transfer_*) |
| `/budgets/{id}/timeframe_categories?date=<iso>` | Per-category, per-month `budgeted` amounts (cache-buster required) |
| `/budgets/{id}/ltb_breakdown?date=<iso>` | Per-month rollup (cache-buster required) |

## Schema quirks

These aren't documented anywhere. They were discovered empirically:

- **Amounts** are positive decimal strings. The sign comes from a separate
  `type` field: `"outflow"` (negative) or `"inflow"` (positive).
- **Payee** on transactions is a string name, not an ID. There's no
  `payee_id` field on transactions.
- **Category** on transactions is sometimes `{ id: null, name: "..." }`.
  When `id` is null, fall back to `name` to discover pseudo-categories
  like "Left to Budget" (which represent income entering the budget).
- **Date strings** are `YYYY-MM-DDTHH:MM:SS.000Z` (noon UTC) — slice
  to first 10 chars for `YYYY-MM-DD`.
- **Transfer pairs**:
  - The outflow half has `transfer_target_transaction_id` set (not
    `transfer_target_account_id` — that doesn't exist).
  - The inflow half has `transfer_origin_transaction_id` set.
  - The destination account is determined by looking up the partner
    transaction's `account_id`.
  - Both halves have no category and no payee (the `payee` field is
    `null`); Actual creates the linking via a transfer payee.
- **`timeframe`** field uses `MMYYYY` (e.g., `"122020"` for Dec 2020).
  Translate to `YYYY-MM-01` for Actual.
- **`global_ltb: false`** in settings means carryover is NOT global,
  but per-category carryover tracking still happens.
- **Duplicate payee records**: Budgetwise has a bug where the same
  payee name gets stored multiple times with different IDs. Our dedup
  pass collapses these.

## Caveats

- This is the my.budgetwise.io web app API. alpha.budgetwise.io,
  self-hosted instances, mobile clients, and Budgetwise forks may
  differ.
- The JWT auth has no rotation or refresh. If your token expires,
  re-login via `POST /sessions`.
- Rate limits aren't documented. The tool makes ~10 requests per
  budget and is designed to be run once per migration.
