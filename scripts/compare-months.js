#!/usr/bin/env node
// Per-month comparison of an imported Actual file vs BW ltbBreakdown.
// For each YYYY-MM (chronological), compare:
//   - BW budgetedForMonth (CC-normalized: subtract id-deduped CC for that month)
//   - Actual budgeted total (Σ categoryGroups[].categories[].budgeted)
//   - BW income vs Actual incomeAvailable (incremental)
//   - BW leftToBudget vs Actual toBudget
//   - Cumulative diff to spot compounding

import * as api from '@actual-app/api';
import { config } from '../lib/config.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';



const tfcRaw = JSON.parse(await readFile(resolve(captureDir, 'timeframeCategories.json'), 'utf8'));
const ltb = JSON.parse(await readFile(resolve(captureDir, 'ltbBreakdown.json'), 'utf8'));
const tfc = Array.isArray(tfcRaw.data) ? tfcRaw.data : tfcRaw.data;
const tfcFlat = Array.isArray(tfc[0]) ? tfc.flat() : tfc;

// CC id-dedup per month
const ccByMonth = new Map();
const seen = new Set();
for (const e of tfcFlat) {
  if (!e.is_cc || !e.timeframe) continue;
  const k = e.timeframe + '|' + e.id;
  if (seen.has(k)) continue;
  seen.add(k);
  const v = parseFloat(e.budgeted || '0');
  ccByMonth.set(e.timeframe, (ccByMonth.get(e.timeframe) || 0) + v);
}

await api.init({
  serverURL: config.actual.serverURL,
  password: config.actual.password,
  dataDir: config.actual.dataDir,
});

const files = await api.internal.send('api/get-budgets');
const target = files.find(f => f.name === BUDGET_NAME);
if (!target) throw new Error(`Budget "${BUDGET_NAME}" not found on server`);
console.log(`${BUDGET_NAME} groupId:`, target.groupId);
await api.downloadBudget(mb4.groupId);

// Chronological sort
const months = Object.keys(ltb).sort((a, b) => {
  const aY = a.slice(2, 6), aM = a.slice(0, 2);
  const bY = b.slice(2, 6), bM = b.slice(0, 2);
  return (aY + aM).localeCompare(bY + bM);
});

console.log('Per-month comparison (chronological):');
console.log('mm/yyyy  bw_budg    actual   diff   bw_inc     act_inc   diff   bw_ltb      actual_tb   diff');

let cumBw = 0, cumActual = 0, cumLtbBw = 0, cumLtbAct = 0;
let prevActualIncome = 0;
let firstIncomeDiv = null;
let firstBudgetedDiv = null;
let firstLtbDiv = null;
const rows = [];
let actualMonthStart = null;

for (const m of months) {
  const d = ltb[m];
  const bwBudgeted = parseFloat(d.budgetedForMonth || '0');
  const ccThisMonth = ccByMonth.get(m) || 0;
  const bwBudgetedNormalized = bwBudgeted - ccThisMonth; // CC id-deduped subtractions
  const bwIncome = parseFloat(d.incomeForMonth || '0');
  const bwLtb = parseFloat(d.leftToBudget || '0');

  const yyyy = m.slice(2, 6);
  const mm = m.slice(0, 2);
  const month = `${yyyy}-${mm}`;
  let bm;
  try {
    bm = await api.getBudgetMonth(month);
  } catch (e) {
    if (String(e.message).includes('No budget exists')) {
      // Actual doesn't have this month — skip
      rows.push({ m, skip: true, reason: 'no budget in Actual' });
      continue;
    }
    throw e;
  }
  let actualBudgeted = 0;
  for (const g of bm.categoryGroups || []) {
    for (const c of g.categories || []) {
      if (c.budgeted) actualBudgeted += c.budgeted;
    }
  }
  const actualBudgetedDollars = actualBudgeted / 100;
  const actualIncome = bm.incomeAvailable || 0;
  const actualIncomeIncr = (actualIncome - prevActualIncome) / 100;
  prevActualIncome = actualIncome;
  const actualTb = bm.toBudget || 0;

  const budgetedDiff = Math.round((actualBudgetedDollars - bwBudgetedNormalized) * 100) / 100;
  const incomeDiff = Math.round((actualIncomeIncr - bwIncome) * 100) / 100;
  const ltbDiff = Math.round(((actualTb - bwLtb * 100) / 100)) / 100;

  cumBw += bwBudgetedNormalized;
  cumActual += actualBudgetedDollars;
  cumLtbBw += bwLtb;
  cumLtbAct += actualTb / 100;

  rows.push({ m, bwBudgetedNormalized, actualBudgetedDollars, budgetedDiff, bwIncome, actualIncomeIncr, incomeDiff, bwLtb, actualTb: actualTb / 100, ltbDiff });

  if (Math.abs(budgetedDiff) > 0.005 && firstBudgetedDiv === null) firstBudgetedDiv = m;
  if (Math.abs(incomeDiff) > 0.005 && firstIncomeDiv === null) firstIncomeDiv = m;
  if (Math.abs(ltbDiff) > 0.005 && firstLtbDiv === null) firstLtbDiv = m;
  if (actualMonthStart === null) actualMonthStart = m;
}

for (const r of rows) {
  if (r.skip) {
    console.log(`${r.m}  (skipped: ${r.reason})`);
    continue;
  }
  console.log(`${r.m}  $${r.bwBudgetedNormalized.toFixed(2).padStart(8)}  $${r.actualBudgetedDollars.toFixed(2).padStart(8)}  ${r.budgetedDiff >= 0 ? '+' : ''}$${r.budgetedDiff.toFixed(2).padStart(6)}  $${r.bwIncome.toFixed(2).padStart(8)}  $${r.actualIncomeIncr.toFixed(2).padStart(8)}  ${r.incomeDiff >= 0 ? '+' : ''}$${r.incomeDiff.toFixed(2).padStart(6)}  $${r.bwLtb.toFixed(2).padStart(8)}  $${r.actualTb.toFixed(2).padStart(8)}  ${r.ltbDiff >= 0 ? '+' : ''}$${r.ltbDiff.toFixed(2).padStart(6)}`);
}

console.log();
console.log(`First budgeted divergence: ${firstBudgetedDiv || '(none)'}`);
console.log(`First income divergence: ${firstIncomeDiv || '(none)'}`);
console.log(`First LTB divergence: ${firstLtbDiv || '(none)'}`);
console.log();
console.log(`Cumulative budgeted: BW=$${cumBw.toFixed(2)}  Actual=$${cumActual.toFixed(2)}  diff=$${(cumActual - cumBw).toFixed(2)}`);
console.log(`Cumulative LTB (no carry): BW=$${cumLtbBw.toFixed(2)}  Actual=$${cumLtbAct.toFixed(2)}  diff=$${(cumLtbAct - cumLtbBw).toFixed(2)}`);

await api.shutdown();
