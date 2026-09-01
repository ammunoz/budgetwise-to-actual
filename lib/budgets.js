// Budget expectation + verification. Single source of truth for "what the
// per-category per-month budgets should look like in Actual" — both the
// writer (bin/import_budgetwise.js writeBudgetsAfterImport) and the
// validator use expectedBudgetEntries, so they cannot diverge.
//
// Budgets API:
//   expectedBudgetEntries(capture, categoryIdToActual)
//     -> [{ month: 'YYYY-MM-DD', catId, cents }]
//        Returns the deduped, flattened, skip-CC, skip-null-cat-id set of
//        (month, category, cents) tuples that the writer should call
//        setBudgetAmount for.
//
//   validateBudgets(entries, { months, cats, getActual, getMonth })
//     -> { checked, drift: [{ month, catId, expected, actual }] }
//
//   fixDrift(drift, { setBudget })
//     Rewrites each drifted cell to the expected value (cents) using a
//     caller-supplied setBudget callback. Returns { fixed, unfixable }.

import { unwrap } from './reader.js';
import logger from './logger.js';

/**
 * Compute the set of (month, ActualCategoryId, cents) tuples that should be
 * in Actual after a clean import. Pure function; no api calls. Skips:
 *   - CC entries (is_cc === true) — Actual tracks CC payments via the
 *     account's "Payment" pseudo-category, not budget rows.
 *   - Entries without a category_id (orphan rows Budgetwise keeps around).
 *   - Entries whose category didn't make it into Actual (catId === null).
 *   - Entries with malformed timeframes (not exactly 6 chars).
 */
export function expectedBudgetEntries(capture, categoryIdToActual) {
  const tfc = unwrap(capture.timeframeCategories);
  if (!Array.isArray(tfc) || tfc.length === 0) return [];

  const flat = Array.isArray(tfc[0]) ? tfc.flat() : tfc;
  const out = [];
  for (const entry of flat) {
    if (!entry || entry.is_cc) continue;
    if (!entry.category_id) continue;
    if (!entry.timeframe || entry.timeframe.length !== 6) continue;
    const catId = categoryIdToActual.get(entry.category_id);
    if (!catId) continue;
    const mm = entry.timeframe.slice(0, 2);
    const yyyy = entry.timeframe.slice(2, 6);
    const month = `${yyyy}-${mm}-01`;
    const cents = Math.round(parseFloat(entry.budgeted || '0') * 100);
    out.push({ month, catId, cents });
  }
  return out;
}

/**
 * Compare expected entries against Actual's current state. Returns the set
 * of (month, catId, expected, actual) cells that disagree.
 *
 * `months`: 'all' (default) | string[] of 'YYYY-MM' to limit the sweep.
 *           Each entry's `month` field ('YYYY-MM-DD') is matched against the
 *           'YYYY-MM' prefix.
 * `cats`:   'all' (default) | Set<string> of ActualCategoryId to limit.
 *
 * Caller must supply `getMonth(month: 'YYYY-MM-DD') -> Promise<BudgetMonth>`
 * that returns an Actual budget month object whose categories each have a
 * `budgeted` integer (cents). This indirection lets tests inject mocks.
 */
export async function validateBudgets(entries, { months = 'all', cats = 'all', getMonth } = {}) {
  const monthFilter = months === 'all' ? null : new Set(months);
  const catFilter = cats === 'all' ? null : cats;

  // Bucket entries by month so we make one getMonth call per month.
  const byMonth = new Map();
  for (const e of entries) {
    const ym = e.month.slice(0, 7);
    if (monthFilter && !monthFilter.has(ym)) continue;
    if (catFilter && !catFilter.has(e.catId)) continue;
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(e);
  }

  let checked = 0;
  const drift = [];
  for (const [ym, monthEntries] of byMonth) {
    const monthStr = `${ym}-01`;
    const bm = await getMonth(monthStr);
    const actualByCat = new Map();
    for (const g of bm.categoryGroups || []) {
      for (const c of g.categories || []) {
        actualByCat.set(c.id, c.budgeted || 0);
      }
    }
    for (const e of monthEntries) {
      checked++;
      const actual = actualByCat.has(e.catId) ? actualByCat.get(e.catId) : 0;
      if (actual !== e.cents) {
        drift.push({
          month: monthStr,
          catId: e.catId,
          expected: e.cents,
          actual,
        });
      }
    }
  }
  return { checked, drift };
}

/**
 * Rewrite drifted cells to their expected values. Caller supplies a
 * setBudget(month, catId, cents) callback (typically api.setBudgetAmount).
 * Returns { fixed: drift[], unfixable: drift[] }. An entry is "unfixable"
 * if the underlying call throws.
 */
export async function fixDrift(drift, { setBudget }) {
  const fixed = [];
  const unfixable = [];
  for (const d of drift) {
    try {
      await setBudget(d.month, d.catId, d.expected);
      fixed.push(d);
    } catch (e) {
      d.error = e?.message || String(e);
      unfixable.push(d);
    }
  }
  logger.info(`  fix: ${fixed.length} cell(s) corrected, ${unfixable.length} failed`);
  return { fixed, unfixable };
}

/**
 * Format a drift cell as a human-readable string. Used by both the
 * post-import drift report and any TTY prompt.
 */
export function formatDriftCell(d, { catName = '?' } = {}) {
  return `${d.month} | ${catName.padEnd(28)} | expected=$${(d.expected / 100).toFixed(2).padStart(10)} actual=$${(d.actual / 100).toFixed(2).padStart(10)} delta=${d.actual - d.expected >= 0 ? '+' : ''}$${((d.actual - d.expected) / 100).toFixed(2)}`;
}