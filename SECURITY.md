# Security

This tool takes banking credentials (Budgetwise email/password) via
`.env` and writes captured financial data to disk in plain JSON.

## Before running

- Use a dedicated Budgetwise account, or be aware that your account
  may be flagged for automated access patterns.
- After migration, **rotate both Budgetwise and Actual Budget passwords.**
- Delete the `captured/` directory when you're done — captures contain
  sensitive financial data (account numbers, payee names, amounts).

## Reporting

Please do NOT file public GitHub issues involving:
- Your credentials, tokens, or session cookies
- Captured Budgetwise JSON files (even partially)
- Specific account numbers, routing numbers, or payee names

For sensitive reports, contact the maintainers via GitHub Security
Advisories at https://github.com/ammunoz/budgetwise-to-actual/security/advisories/new.

## Threat model

This tool is designed for a single user running it on their own machine
to migrate their own data between two services they have legitimate
access to. It is NOT designed for:
- Multi-user deployments
- Hosting the tool on a public server
- Automated/scheduled migration of many accounts

If your threat model differs, review the source code first — the
network surface is small (one HTTP client in `lib/express-client.js`,
one HTTP client in `node_modules/@actual-app/api`) but neither
implements request signing, certificate pinning, or additional
encryption beyond TLS.

## Captured data sensitivity

The `captured/` directory contains:
- Account balances and transaction history
- Payee names (which can be identifying — e.g., medical providers,
  political donations, religious organizations)
- Category assignments (which can also be identifying)
- Notes on individual transactions

Treat captures like bank statements. Don't sync them to cloud storage
unencrypted, don't email them, don't post them in chat. If you must
share them for a bug report, redact first.

## `.env` file

The `.env` file contains plaintext credentials. It is gitignored. If
you accidentally commit it, rotate the passwords immediately.
