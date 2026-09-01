#!/usr/bin/env node
// Income oracle v2: BW's "Left to Budget" income attribution depends on
// ltb_next. When ltb_next=true, BW attributes the income to the NEXT month
// (so a 2026-05-22 deposit shows up in 2026-06's incomeForMonth).
// populate.js doesn't account for this — it writes tx.date directly, so
// Actual puts the income in the WRONG month.
//
// This oracle computes:
//   (A) my v1: month = tx.date's month
//   (B) corrected: month = tx.date's month + (ltb_next ? 1 : 0)
// For each variant, compare Σ matching txs vs ltb.incomeForMonth.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const captureDir = resolve(process.argv[2] || '/path/to/captured/recon-budget-sample');

const txRaw = JSON.parse(await readFile(resolve(captureDir, 'transactions.json'), 'utf8'));
const ltb = JSON.parse(await readFile(resolve(captureDir, 'ltbBreakdown.json'), 'utf8'));
const txs = Array.isArray(txRaw.data) ? txRaw.data : txRaw;

function addMonth(mmYYYY, delta) {
  const mm = parseInt(mmYYYY.slice(0, 2), 10);
  let yyyy = parseInt(mmYYYY.slice(2, 6), 10);
  let newMm = mm + delta;
  if (newMm > 12) { newMm -= 12; yyyy++; }
  if (newMm < 1) { newMm += 12; yyyy--; }
  return String(newMm).padStart(2, '0') + String(yyyy);
}

function txDateMonth(t) {
  if (!t.date) return null;
  const d = new Date(t.date);
  if (isNaN(d)) return null;
  return String(d.getMonth() + 1).padStart(2, '0') + String(d.getFullYear());
}

const isLtbInflow = (t) => t.category === 'Left to Budget' && t.type === 'inflow' && t.approved !== false;
const months = Object.keys(ltb).sort();
const bwIncomeByMonth = new Map();
for (const m of months) bwIncomeByMonth.set(m, parseFloat(ltb[m].incomeForMonth || '0'));

const variants = [
  { name: '(A) my v1: month = tx.date',        shift: 0 },
  { name: '(B) corrected: month + ltb_next',   shift: 'ltb_next' },
  { name: '(C) +1 month ALWAYS (force shift)', shift: 1 },
];

for (const v of variants) {
  const sumByMonth = new Map();
  for (const t of txs) {
    if (!isLtbInflow(t)) continue;
    const baseMonth = txDateMonth(t);
    if (!baseMonth) continue;
    const month = v.shift === 'ltb_next' ? addMonth(baseMonth, t.ltb_next ? 1 : 0) : addMonth(baseMonth, v.shift);
    sumByMonth.set(month, (sumByMonth.get(month) || 0) + parseFloat(t.amount));
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
    if (Math.abs(diff) > 0.005) monthsDiff++;
    if (Math.abs(diff) > maxAbs) maxAbs = Math.abs(diff);
    if (firstDiv === null && Math.abs(diff) > 0.005) firstDiv = m;
  }

  console.log(`=== ${v.name} ===`);
  console.log(`  months where sum != BW: ${monthsDiff} / ${months.length}`);
  console.log(`  cumulative diff: $${(totalMine - totalBw).toFixed(2)}`);
  console.log(`  max abs diff: $${maxAbs.toFixed(2)}`);
  console.log(`  first divergence: ${firstDiv || '(none — perfect match)'}`);
  console.log();
}

// Detail of (B) corrected: show first 15 mismatches
{
  const sumByMonth = new Map();
  for (const t of txs) {
    if (!isLtbInflow(t)) continue;
    const baseMonth = txDateMonth(t);
    if (!baseMonth) continue;
    const month = addMonth(baseMonth, t.ltb_next ? 1 : 0);
    sumByMonth.set(month, (sumByMonth.get(month) || 0) + parseFloat(t.amount));
  }
  console.log('--- (B) detail: months where sum != BW income (first 20) ---');
  let printed = 0;
  for (const m of months) {
    const bw = bwIncomeByMonth.get(m) || 0;
    const mine = sumByMonth.get(m) || 0;
    const diff = mine - bw;
    if (Math.abs(diff) > 0.005) {
      console.log(`  ${m}: BW=$${bw.toFixed(2)}  oracle=$${mine.toFixed(2)}  diff=$${diff.toFixed(2)}`);
      printed++;
      if (printed >= 20) break;
    }
  }
}
