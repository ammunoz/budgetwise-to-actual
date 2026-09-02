#!/usr/bin/env node
// Income oracle v3: BW's "Left to Budget" income attribution.
//
// Three things this oracle gets right that earlier versions missed:
//   1. Iterates split children (parent's category may be 'Left to Budget'
//      OR the children may be — either way, count each LTB tx once).
//   2. Counts BOTH inflows and outflows (BW nets both into incomeForMonth:
//      an LTB outflow like a refund reduces income).
//   3. Uses string slicing for month derivation (TZ-safe; `new Date()` is
//      local-timezone-sensitive and caused false positives).
//
// Compares Σ matching txs vs BW's per-month `ltb.incomeForMonth`.
// 81/81 months should match with `ltb_next` shift applied.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const captureDir = resolve(process.argv[2]);

const txRaw = JSON.parse(await readFile(resolve(captureDir, 'transactions.json'), 'utf8'));
const ltb = JSON.parse(await readFile(resolve(captureDir, 'ltbBreakdown.json'), 'utf8'));
const txs = Array.isArray(txRaw.data) ? txRaw.data : txRaw;

// MMYYYY utilities (string-only; no Date objects)
function addMonth(mmYYYY, delta) {
  const mm = parseInt(mmYYYY.slice(0, 2), 10);
  let yyyy = parseInt(mmYYYY.slice(2, 6), 10);
  let newMm = mm + delta;
  if (newMm > 12) { newMm -= 12; yyyy++; }
  if (newMm < 1) { newMm += 12; yyyy--; }
  return String(newMm).padStart(2, '0') + String(yyyy);
}

// TZ-safe month derivation from a YYYY-MM-DD[THH:MM:SS] date string.
function txDateMonth(t) {
  if (!t.date) return null;
  const m = String(t.date).match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return m[2] + m[1];  // MMYYYY
}

// Collect every LTB tx as a flat list. Includes both:
//   - Top-level txs with category === 'Left to Budget'
//   - Children of split parents whose category === 'Left to Budget'
// Captures BOTH inflows AND outflows (BW nets both into incomeForMonth).
// Outflows subtract from income (e.g., a refund that nets into LTB
// reduces income for that month).
function collectAllLtbTxs(transactions) {
  const out = [];
  for (const tx of transactions) {
    const hasChildren = Array.isArray(tx.child_transactions) && tx.child_transactions.length > 0;
    if (tx.category === 'Left to Budget' && !hasChildren) {
      out.push(tx);
    } else if (tx.category === 'Left to Budget' && hasChildren) {
      // Split parent with LTB category: skip the parent (its amount is 0 in BW;
      // the children carry the actual amounts), iterate children.
      for (const c of tx.child_transactions) {
        if (c.category === 'Left to Budget') out.push(c);
      }
    } else if (hasChildren) {
      // Parent has different category but a child is LTB — include that child.
      for (const c of tx.child_transactions) {
        if (c.category === 'Left to Budget') out.push(c);
      }
    }
  }
  return out;
}

const months = Object.keys(ltb);
const bwIncomeByMonth = new Map();
for (const m of months) bwIncomeByMonth.set(m, parseFloat(ltb[m].incomeForMonth || '0'));

const variants = [
  { name: '(A) tx.date only (no shift)', shift: 0 },
  { name: '(B) tx.date + ltb_next shift', shift: 'ltb_next' },
];

const allLtb = collectAllLtbTxs(txs);

for (const v of variants) {
  const sumByMonth = new Map();
  for (const t of allLtb) {
    const baseMonth = txDateMonth(t);
    if (!baseMonth) continue;
    const month = v.shift === 'ltb_next' ? addMonth(baseMonth, t.ltb_next ? 1 : 0) : baseMonth;
    // Inflows contribute positively; outflows contribute negatively.
    const signed = (t.type === 'outflow' ? -1 : 1) * parseFloat(t.amount);
    sumByMonth.set(month, (sumByMonth.get(month) || 0) + signed);
  }

  let totalBw = 0, totalMine = 0;
  let monthsDiff = 0;
  let maxAbs = 0;
  let firstDiv = null;
  for (const m of months) {
    const bw = bwIncomeByMonth.get(m) || 0;
    const mine = sumByMonth.get(m) || 0;
    totalBw += bw;
    totalMine += mine;
    const diff = Math.round((mine - bw) * 100) / 100;
    if (Math.abs(diff) > 0.005) {
      monthsDiff++;
      if (firstDiv === null) firstDiv = m;
      if (Math.abs(diff) > maxAbs) maxAbs = Math.abs(diff);
    }
  }

  console.log(`=== ${v.name} ===`);
  console.log(`  LTB txs scanned: ${allLtb.length} (parents + split children)`);
  console.log(`  months where sum != BW: ${monthsDiff} / ${months.length}`);
  console.log(`  cumulative diff: $${(totalMine - totalBw).toFixed(2)}`);
  console.log(`  max abs diff: $${maxAbs.toFixed(2)}`);
  console.log(`  first divergence: ${firstDiv || '(none — perfect match)'}`);
  console.log();
}

// Detail of (B) corrected: show all mismatches with explanations
{
  const sumByMonth = new Map();
  for (const t of allLtb) {
    const baseMonth = txDateMonth(t);
    if (!baseMonth) continue;
    const month = addMonth(baseMonth, t.ltb_next ? 1 : 0);
    const signed = (t.type === 'outflow' ? -1 : 1) * parseFloat(t.amount);
    sumByMonth.set(month, (sumByMonth.get(month) || 0) + signed);
  }
  console.log('--- (B) detail: months where sum != BW income ---');
  let printed = 0;
  for (const m of months) {
    const bw = bwIncomeByMonth.get(m) || 0;
    const mine = sumByMonth.get(m) || 0;
    const diff = mine - bw;
    if (Math.abs(diff) > 0.005) {
      console.log(`  ${m}: BW=$${bw.toFixed(2)}  oracle=$${mine.toFixed(2)}  diff=$${diff.toFixed(2)}`);
      printed++;
    }
  }
  if (printed === 0) console.log('  (no mismatches — perfect 81/81 match)');
}
