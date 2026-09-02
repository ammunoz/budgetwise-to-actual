// Reconciliation report.
//
// After the import, walks Budgetwise's `ltbBreakdown` (per-month rollup) and
// compares it against Actual's `getBudgetMonth(month)` for the same months.
// Also cross-checks per-account balances (BW `current_bal` vs Actual's
// computed sum-of-transactions balance).
//
// Emits a single Markdown section suitable for `MIGRATION_REPORT.md`. Pure:
// the API functions are injected so tests can pin behavior deterministically.
//
// BW month keys are "MMYYYY" (e.g. "102024" = Oct 2024). Actual's
// `getBudgetMonth` takes "YYYY-MM-DD" with day=1.

import { unwrap } from './reader.js';

const fmtDollars = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
};
const fmtCents = (cents) => fmtDollars(cents == null ? NaN : cents / 100);
const MM = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function mmYYYYtoActual(mmyyyy) {
  if (!mmyyyy || mmyyyy.length !== 6) return null;
  const mm = parseInt(mmyyyy.slice(0, 2), 10);
  const yyyy = mmyyyy.slice(2, 6);
  return `${yyyy}-${String(mm).padStart(2, '0')}-01`;
}

function mmYYYYtoLabel(mmyyyy) {
  if (!mmyyyy || mmyyyy.length !== 6) return mmyyyy;
  const mm = parseInt(mmyyyy.slice(0, 2), 10);
  const yyyy = mmyyyy.slice(2, 6);
  return `${MM[mm - 1] || '???'} ${yyyy}`;
}

// Parse BW's ltb numeric fields, which are string-or-number (sometimes "-0").
function parseBWNumber(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------------------------------------------------------
// Per-month LTB comparison
// ----------------------------------------------------------------------------

/**
 * For each month in the BW ltbBreakdown, call getBudgetMonth and compare:
 *   incomeForMonth  <-> totalIncome
 *   leftToBudget     <-> toBudget
 *   fwdFromLastMonth <-> fromLastMonth   (last-month carryover)
 *   budgetedForMonth <-> totalBudgeted   (signed; outgoing)
 *
 * @param {Object} ltbBreakdown         Map<mmYYYY, ltbRecord>
 * @param {(m: string) => Promise<{month, incomeAvailable, lastMonthOverspent,
 *                                  forNextMonth, totalBudgeted, toBudget,
 *                                  fromLastMonth, totalIncome, totalSpent,
 *                                  totalBalance}>} getMonth
 * @returns {Promise<{
 *   rows:    Array<{month, mmyyyy, bw, actual, deltas}>,
 *   summary: {monthsChecked, monthsClean, maxAbsDelta}
 * }>}
 */
export async function compareLtbMonths(ltbBreakdown, getMonth) {
  const months = Object.keys(ltbBreakdown).sort();
  const rows = [];
  let monthsClean = 0;
  let maxAbsDelta = 0;

  for (const tf of months) {
    const bw = ltbBreakdown[tf];
    const monthStr = mmYYYYtoActual(tf);
    const actual = await getMonth(monthStr).catch((e) => ({ error: e.message }));
    if (actual && actual.error) {
      rows.push({ month: monthStr, mmyyyy: tf, bw, actual: null, deltas: { error: actual.error } });
      continue;
    }

    const bwIncome = Math.round(parseBWNumber(bw.incomeForMonth) * 100);
    const bwLtb = Math.round(parseBWNumber(bw.leftToBudget) * 100);
    const bwFwd = Math.round(parseBWNumber(bw.fwdFromLastMonth) * 100);
    // BW's budgetedForMonth is the SUM of positive budget cells (in dollars).
    // Actual's totalBudgeted is in cents and is *negative* (it's an outgoing
    // that reduces toBudget). Convert BW positive cents to Actual-negative
    // cents for a like-for-like comparison.
    const bwBudgeted = -Math.round(parseBWNumber(bw.budgetedForMonth) * 100);

    const aIncome = actual.totalIncome ?? 0;
    const aLtb = actual.toBudget ?? 0;
    const aFwd = actual.fromLastMonth ?? 0;
    const aBudgeted = actual.totalBudgeted ?? 0;

    const deltas = {
      income: aIncome - bwIncome,
      ltb: aLtb - bwLtb,
      fwd: aFwd - bwFwd,
      budgeted: aBudgeted - bwBudgeted,
    };
    const max = Math.max(
      Math.abs(deltas.income),
      Math.abs(deltas.ltb),
      Math.abs(deltas.fwd),
      Math.abs(deltas.budgeted),
    );
    if (max > 1) { // tolerate ±$0.01 rounding
      maxAbsDelta = Math.max(maxAbsDelta, max);
    } else {
      monthsClean++;
    }

    rows.push({
      month: monthStr,
      mmyyyy: tf,
      bw: { income: bwIncome, ltb: bwLtb, fwd: bwFwd, budgeted: bwBudgeted },
      actual: { income: aIncome, ltb: aLtb, fwd: aFwd, budgeted: aBudgeted },
      deltas,
    });
  }

  return {
    rows,
    summary: {
      monthsChecked: months.length,
      monthsClean,
      maxAbsDelta,
    },
  };
}

// ----------------------------------------------------------------------------
// Per-account balance comparison
// ----------------------------------------------------------------------------

/**
 * @param {Array<{id, name, current_bal}>} bwAccounts   From accounts.json (deduped).
 * @param {Map<string, string>} bwIdToActualId          Map<BW account id, Actual account id>.
 * @param {(id: string) => Promise<number>} getBalance  Returns cents (Actual's convention).
 * @returns {Promise<Array<{name, bwCents, actualCents, deltaCents}>>}
 */
export async function compareAccountBalances(bwAccounts, bwIdToActualId, getBalance) {
  const out = [];
  for (const a of (Array.isArray(bwAccounts) ? bwAccounts : [])) {
    if (!a || !a.id) continue;
    const actualId = bwIdToActualId.get(a.id);
    if (!actualId) {
      out.push({ name: a.name || '(unnamed)', bwCents: null, actualCents: null, deltaCents: null, missing: true });
      continue;
    }
    const bwCents = Math.round(parseBWNumber(a.current_bal) * 100);
    let actualCents = null;
    try {
      actualCents = await getBalance(actualId);
    } catch {
      actualCents = null;
    }
    out.push({
      name: a.name || '(unnamed)',
      bwCents,
      actualCents,
      deltaCents: actualCents == null ? null : actualCents - bwCents,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Markdown rendering
// ----------------------------------------------------------------------------

function renderAccountTable(balances) {
  const lines = [];
  lines.push('| Account | BW current_bal | Actual balance | Δ (cents) |');
  lines.push('|---|---:|---:|---:|');
  for (const b of balances) {
    if (b.missing) {
      lines.push(`| ${b.name} | _no matching Actual account_ | — | — |`);
    } else {
      lines.push(`| ${b.name} | ${fmtCents(b.bwCents)} | ${fmtCents(b.actualCents)} | ${b.deltaCents == null ? '—' : (b.deltaCents >= 0 ? '+' : '') + b.deltaCents} |`);
    }
  }
  return lines.join('\n');
}

function renderMonthTable(rows, summary) {
  const lines = [];
  lines.push(`**${summary.monthsChecked}** months compared. **${summary.monthsClean}** match to within ±$0.01. Max absolute delta across months: **${fmtCents(summary.maxAbsDelta)}**.`);
  lines.push('');
  lines.push('| Month | BW income | Actual income | Δ | BW LTB | Actual LTB | Δ | BW fwd | Actual fwd | Δ |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    if (r.deltas.error) {
      lines.push(`| ${mmYYYYtoLabel(r.mmyyyy)} | _error: ${r.deltas.error}_ | | | | | | | | |`);
      continue;
    }
    const d = (n) => (n == null ? '—' : (n >= 0 ? '+' : '') + n);
    lines.push(
      `| ${mmYYYYtoLabel(r.mmyyyy)}`
      + ` | ${fmtCents(r.bw.income)} | ${fmtCents(r.actual.income)} | ${d(r.deltas.income)}`
      + ` | ${fmtCents(r.bw.ltb)} | ${fmtCents(r.actual.ltb)} | ${d(r.deltas.ltb)}`
      + ` | ${fmtCents(r.bw.fwd)} | ${fmtCents(r.actual.fwd)} | ${d(r.deltas.fwd)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Build the full reconciliation markdown section.
 *
 * @param {Object} args
 * @param {Awaited<ReturnType<typeof compareLtbMonths>>} args.ltb
 * @param {Awaited<ReturnType<typeof compareAccountBalances>>} [args.balances]
 * @returns {string}
 */
export function reconMarkdown({ ltb, balances = [] }) {
  const lines = [];
  lines.push('# Reconciliation Report');
  lines.push('');
  lines.push('Compares Budgetwise\'s `ltbBreakdown` and `accounts.current_bal` against Actual\'s `getBudgetMonth(month)` and per-account balances after the import.');
  lines.push('');

  lines.push('## Per-account balances');
  lines.push('');
  if (balances.length === 0) {
    lines.push('_No accounts in the capture or accountIdToActual map was empty._');
  } else {
    lines.push(renderAccountTable(balances));
  }
  lines.push('');

  lines.push('## Per-month LTB comparison');
  lines.push('');
  if (!ltb || ltb.rows.length === 0) {
    lines.push('_No LTB data in the capture — capture looks empty or `ltbBreakdown.json` was missing._');
  } else {
    lines.push(renderMonthTable(ltb.rows, ltb.summary));
  }
  lines.push('');

  lines.push('## Interpretation notes');
  lines.push('');
  lines.push('- **BW LTB** is Budgetwise\'s `ltbBreakdown.leftToBudget` for that month. **Actual LTB** is `getBudgetMonth(m).toBudget`. BW allows overspending to carry forward globally; Actual keeps it per-category, so month-level deltas are expected and small.');
  lines.push('- **BW fwd** is Budgetwise\'s `ltbBreakdown.fwdFromLastMonth` (cumulative forward income). Actual\'s `fromLastMonth` is a per-month rollup; the two use different conventions and will diverge for any month with prior-month carryover.');
  lines.push('- **BW income** uses the `ltb_next` shift for income attribution. Our import applies the same shift — exact matches are expected for clean captures.');
  lines.push('');
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Orchestration helper used by bin/import_budgetwise.js
// ----------------------------------------------------------------------------

/**
 * Run the reconciliation and return the markdown + raw data.
 *
 * @param {Object} args
 * @param {Object} args.capture                          The deduped capture.
 * @param {Function} args.getMonth                       (m) => Promise<BudgetMonth>
 * @param {Function} args.getBalanceForAcctId            (actualAcctId) => Promise<cents>
 * @param {Map<string,string>} args.bwIdToActualAcctId   BW id -> Actual id.
 * @returns {Promise<{ltb: object, balances: Array, markdown: string}>}
 */
export async function runReconReport({ capture, getMonth, getBalanceForAcctId, bwIdToActualAcctId }) {
  const ltbBreakdown = capture.ltbBreakdown && typeof capture.ltbBreakdown === 'object'
    ? capture.ltbBreakdown
    : {};
  const ltb = await compareLtbMonths(ltbBreakdown, getMonth);
  const bwAccounts = unwrap(capture.accounts);
  const balances = await compareAccountBalances(bwAccounts, bwIdToActualAcctId, getBalanceForAcctId);
  const markdown = reconMarkdown({ ltb, balances });
  return { ltb, balances, markdown };
}
