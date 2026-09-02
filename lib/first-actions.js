// First-actions checklist generator.
//
// Pulls together the issues we already detect during import (fuzzy payees,
// uncategorized transactions, income-category candidates) and renders them
// as a Markdown checklist the user can work through after the migration.
//
// Inputs come from the capture (already-deduped payees, transaction list) and
// from a small Actual-only post-import pass (per-category balance lookup for
// the "net-positive non-Income category" heuristic).
//
// Why we don't reach for more heuristics: anything beyond a short list of
// obvious "review these N things" items turns the checklist into noise. We
// want the user to glance at it once and trust it.

import { unwrap, findFuzzyCandidates } from './reader.js';

// ---------------------------------------------------------------------------
// Pure data collectors
// ---------------------------------------------------------------------------

// Fuzzy payee candidates from the dedup pass. Same heuristic as
// lib/reader.js's internal call — re-run here against the deduped payee
// list so the checklist has the same data the importer logged.
export function detectFuzzyPayees(payees) {
  const flat = unwrap(payees);
  if (!Array.isArray(flat)) return [];
  return findFuzzyCandidates(flat);
}

// Categories whose Actual balance is net-positive (inflows > outflows over
// the captured window). These are candidates to flip to `is_income: true`.
// Caller supplies accountIdToActual and the Actual categories list.
//
// `balanceByCatId` is a Map<categoryId, integerCents> the caller can produce
// by walking each account's transactions (or `getCategoryBalance` if exposed).
export function detectIncomeCandidates(categories, balanceByCatId) {
  if (!Array.isArray(categories)) return [];
  const out = [];
  for (const c of categories) {
    if (!c || c.is_income) continue;
    const bal = balanceByCatId.get(c.id) || 0;
    if (bal > 0) {
      out.push({ id: c.id, name: c.name, balanceCents: bal });
    }
  }
  out.sort((a, b) => b.balanceCents - a.balanceCents);
  return out;
}

// Uncategorized transactions detected post-import. Caller walks accounts and
// supplies the count.
export function countUncategorized(perAccountCounts) {
  return perAccountCounts.reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

const fmtDollars = (cents) => `$${(cents / 100).toFixed(2)}`;

export function firstActionsChecklist({
  fuzzyPayees = [],
  uncategorizedCount = 0,
  incomeCandidates = [],
  settingsNotMigrated = [],
  driftCells = 0,
  budgetName = '',
} = {}) {
  const lines = [];
  lines.push(`# First Actions Checklist${budgetName ? ` — ${budgetName}` : ''}`);
  lines.push('');
  lines.push('Generated at the end of the import. Work through these before treating the new budget as authoritative.');
  lines.push('');

  let needsReview = false;

  if (fuzzyPayees.length > 0) {
    needsReview = true;
    lines.push(`## Payee dedup candidates (${fuzzyPayees.length})`);
    lines.push('');
    lines.push('These payee names are similar (substring or near-match) but were NOT auto-merged. Review in Actual → Payees and merge if the variants refer to the same vendor.');
    lines.push('');
    for (const f of fuzzyPayees.slice(0, 50)) {
      lines.push(`- [ ] Compare and merge: \`${f.a}\` ↔ \`${f.b}\` _(reason: ${f.reason})_`);
    }
    if (fuzzyPayees.length > 50) {
      lines.push(`- _…and ${fuzzyPayees.length - 50} more — see capture directory for the full list._`);
    }
    lines.push('');
  }

  if (incomeCandidates.length > 0) {
    needsReview = true;
    lines.push(`## Categories with net-positive balance (${incomeCandidates.length})`);
    lines.push('');
    lines.push('These categories received more inflows than outflows across the import. They may be Income categories that Budgetwise left unmarked. Open the category in Actual → Categories and toggle "Income" if appropriate.');
    lines.push('');
    for (const c of incomeCandidates.slice(0, 30)) {
      lines.push(`- [ ] Review category \`${c.name}\` (net ${fmtDollars(c.balanceCents)}) — flip to **Income** if applicable`);
    }
    if (incomeCandidates.length > 30) {
      lines.push(`- _…and ${incomeCandidates.length - 30} more._`);
    }
    lines.push('');
  }

  if (uncategorizedCount > 0) {
    needsReview = true;
    lines.push(`## Uncategorized transactions (${uncategorizedCount})`);
    lines.push('');
    lines.push('These transactions had no category in Budgetwise (e.g. transfers or pending entries). Open the Uncategorized view in Actual and assign categories as needed.');
    lines.push('');
    lines.push(`- [ ] Categorize the ${uncategorizedCount} uncategorized transactions`);
    lines.push('');
  }

  if (settingsNotMigrated.length > 0) {
    needsReview = true;
    lines.push(`## Settings not migrated automatically (${settingsNotMigrated.length})`);
    lines.push('');
    lines.push('These preferences had no programmatic equivalent in the @actual-app/api surface. Configure them manually in Actual → Settings → Preferences.');
    lines.push('');
    for (const s of settingsNotMigrated) {
      lines.push(`- [ ] ${s}`);
    }
    lines.push('');
  }

  if (driftCells > 0) {
    needsReview = true;
    lines.push('## Budget-cell drift');
    lines.push('');
    lines.push(`Some ${driftCells} (month, category) budget cells in Actual differ from the Budgetwise capture. See \`MIGRATION_REPORT.md\` § Budget verification for the per-cell list. Re-run with \`--fix\` to rewrite the cells if the capture is the source of truth.`);
    lines.push('');
    lines.push(`- [ ] Decide on each drifted cell (fix via \`--fix\` or review manually)`);
    lines.push('');
  }

  if (!needsReview) {
    lines.push('_No outstanding actions detected. The migration looks clean — verify by spot-checking key months in Actual._');
    lines.push('');
  }

  return lines.join('\n');
}
