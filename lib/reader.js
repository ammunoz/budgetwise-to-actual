// Reader: load captured JSON from a directory and validate shape.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import logger from './logger.js';

export async function loadCapture(capturedDir) {
  const dir = resolve(capturedDir);
  const files = await readdir(dir);
  // Required: accounts, categories, transactions. Optional: the rest.
  const required = ['accounts', 'categories', 'transactions'];
  const optional = ['sections', 'payees', 'settings',
                    'timeframeCategories', 'ltbBreakdown'];
  const out = {};
  for (const name of required) {
    const f = resolve(dir, `${name}.json`);
    try {
      out[name] = JSON.parse(await readFile(f, 'utf8'));
    } catch (e) {
      throw new Error(`Required capture file missing or unreadable: ${f} (${e.message})`);
    }
  }
  for (const name of optional) {
    const f = resolve(dir, `${name}.json`);
    try {
      out[name] = JSON.parse(await readFile(f, 'utf8'));
    } catch {
      logger.warn(`  optional capture file missing: ${f}; proceeding with empty`);
      out[name] = null;
    }
  }
  // manifest.json is optional
  try {
    const mf = resolve(dir, 'manifest.json');
    out.manifest = JSON.parse(await readFile(mf, 'utf8'));
  } catch {
    out.manifest = null;
  }

  // Apply payee dedup. Transactions reference payees by name string (no
  // payee_id), so this is safe — consolidating duplicate Budgetwise records
  // by name preserves all transaction links.
  if (out.payees) {
    out.payees = dedupPayees(out.payees, out.transactions);
  }

  // Apply budget-row dedup. Budgetwise's API returns multiple rows per
  // (timeframe, category_id) — one per save — with the same `spent` value
  // but potentially different `budgeted`. Budgetwise's UI shows the FIRST
  // row's value (lowest id). Without dedup, setBudgetAmount is called per
  // row and Actual's last-write-wins behavior overwrites the real value with
  // the trailing $0 echo row, silently zeroing out budgets.
  // See https://github.com/ammunoz/budgetwise-to-actual for context.
  if (out.timeframeCategories) {
    out.timeframeCategories = dedupTimeframeCategories(out.timeframeCategories);
  }

  return out;
}

// Unwrap {data: [...]} envelopes. Some Budgetwise endpoints wrap their data.
export function unwrap(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.data)) return payload.data;
  return payload;
}

// =========================================================================
// Payee dedup
// =========================================================================
// Budgetwise has a bug where duplicate payee records get created despite
// having the same name. We dedupe in two passes:
//
//   1. Exact-name match: collapse byte-identical names. Picks the first
//      occurrence (record ordering is stable across runs).
//
//   2. Case-insensitive match: collapse names that differ only in case
//      (e.g., "McDonald's" vs "mcdonalds"). Picks the variant with the most
//      transaction usage; ties broken by first-seen.
//
// Fuzzy candidates we did NOT auto-merge (substring / edit-distance pairs
// that could be intentionally distinct vendors) are logged as warnings so
// the user can review them.
//
// Returns: payees object (with `data` wrapper preserved) ready for unwrap().
function dedupPayees(payeesPayload, transactionsPayload) {
  const payees = unwrap(payeesPayload);
  if (!Array.isArray(payees)) return payeesPayload;

  // Count transaction usage per payee name to pick the best variant.
  const usageByName = new Map();
  const txns = unwrap(transactionsPayload);
  if (Array.isArray(txns)) {
    for (const t of txns) {
      if (t.payee) usageByName.set(t.payee, (usageByName.get(t.payee) || 0) + 1);
    }
  }

  // Pass 1: exact-name dedup
  const exactSeen = new Map(); // name → winning record
  const exactRemoved = [];
  for (const p of payees) {
    if (exactSeen.has(p.name)) {
      exactRemoved.push(p.name);
      continue;
    }
    exactSeen.set(p.name, p);
  }
  let result = Array.from(exactSeen.values());

  // Pass 2: case-insensitive dedup. Group by normalized name (lowercase +
  // apostrophes stripped), pick winner per group. Stripping apostrophes
  // catches common Mc/Wendy's style name variants.
  const ciBuckets = new Map(); // normalized name → [records]
  for (const p of result) {
    const k = normalizeName(p.name);
    if (!ciBuckets.has(k)) ciBuckets.set(k, []);
    ciBuckets.get(k).push(p);
  }
  const caseMerges = [];
  result = [];
  for (const [, group] of ciBuckets) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Pick the variant with most transaction usage; ties broken by first-seen.
    group.sort((a, b) => {
      const ua = usageByName.get(a.name) || 0;
      const ub = usageByName.get(b.name) || 0;
      if (ub !== ua) return ub - ua;
      return 0; // stable sort = first-seen wins
    });
    const winner = group[0];
    const losers = group.slice(1);
    for (const loser of losers) {
      caseMerges.push(`${winner.name} (kept) ← ${loser.name}`);
    }
    result.push(winner);
  }

  // Log dedup results
  if (exactRemoved.length > 0) {
    logger.info(`  payee dedup: removed ${exactRemoved.length} exact-name duplicate(s)`);
  }
  if (caseMerges.length > 0) {
    logger.info(`  payee dedup: merged ${caseMerges.length} case variant(s):`);
    for (const m of caseMerges) logger.info(`    ${m}`);
  }

  // Fuzzy candidates we did NOT merge. We use a simple heuristic: pairs of
  // remaining names where one is a substring of the other, OR edit distance ≤ 2.
  const fuzzy = findFuzzyCandidates(result);
  if (fuzzy.length > 0) {
    logger.warn(`  payee dedup: ${fuzzy.length} fuzzy candidate(s) NOT auto-merged:`);
    for (const f of fuzzy) logger.warn(`    ${JSON.stringify(f.a)} ↔ ${JSON.stringify(f.b)} (${f.reason})`);
  }

  return { data: result };
}

// =========================================================================
// TimeframeCategory dedup
// =========================================================================
// Budgetwise's `/api/budgets/{id}/timeframe_categories` endpoint returns
// one row per save — re-saving an unchanged budget (e.g. when only `spent`
// changes) creates a new row with the same category, month, and spent but a
// fresh id and a `budgeted` value that may differ from the original. We
// collapse duplicates by `(timeframe, category_id)`, keeping the row with
// the lowest id (i.e. the oldest row). This matches what Budgetwise's UI
// shows: the value from the first save wins, not the most recent edit.
//
// Why lowest-id and not array-position: row ids are monotonically increasing
// database keys, so the lowest-id row is unambiguously the oldest. Array
// position happens to match today but isn't a documented contract.
//
// `is_cc` rows are deduped too (same key collision happens with CC budget
// entries); consumers that care about CC separately can filter on `is_cc`
// after this transform.
//
// Returns: timeframeCategories object (with `data` wrapper preserved) ready
// for unwrap().
function dedupTimeframeCategories(payload) {
  const flat = unwrap(payload);
  if (!Array.isArray(flat)) return payload;

  // The payload can be `{data: [[...], [...]]}` (group envelope) or
  // `{data: [...]}` (already flat). Flatten to a single list before dedup
  // so the same dedup key handles both shapes.
  const entries = Array.isArray(flat[0]) ? flat.flat() : flat;

  const winners = new Map(); // `${timeframe}|${category_id}` → entry
  let dropped = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const tf = entry.timeframe;
    const cid = entry.category_id;
    // Only dedup rows we have a stable key for. CC rows have no category_id,
    // so key on cc_account_id for those. Rows missing both pass through.
    const key = tf && cid
      ? `${tf}|cat:${cid}`
      : tf && entry.cc_account_id
        ? `${tf}|cc:${entry.cc_account_id}`
        : null;
    if (!key) {
      // No key — keep the row as-is by giving it a unique synthetic key
      // (it's a one-off and shouldn't collide with anything else).
      const synth = `__unkeyed:${entry.id ?? Math.random()}`;
      winners.set(synth, entry);
      continue;
    }
    const prev = winners.get(key);
    if (!prev || (entry.id != null && prev.id != null && entry.id < prev.id)) {
      if (prev) dropped++;
      winners.set(key, entry);
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    logger.info(`  budget dedup: dropped ${dropped} duplicate(s)`);
  }

  return { data: Array.from(winners.values()) };
}

// Normalize a name for case-insensitive comparison: lowercase + strip
// apostrophes (Mc/Wendy's style variants).
function normalizeName(s) {
  return s.toLowerCase().replace(/['\u2019]/g, '');
}

function findFuzzyCandidates(payees) {
  const findings = [];
  const names = payees.map(p => p.name).sort();
  // Substring relationships (one name contains another)
  for (let i = 0; i < names.length; i++) {
    const a = names[i];
    if (a.length < 5) continue;
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      const b = names[j];
      if (b.length < 5) continue;
      if (b.length <= a.length) continue; // only shorter-contained-in-longer
      if (b.includes(a) && !findings.find(f => (f.a === a && f.b === b) || (f.a === b && f.b === a))) {
        findings.push({ a, b, reason: 'substring' });
      }
    }
  }
  // Edit distance ≤ 2 (limited to short names to keep cost bounded)
  for (let i = 0; i < names.length; i++) {
    const a = names[i];
    if (a.length < 5 || a.length > 30) continue;
    for (let j = i + 1; j < names.length; j++) {
      const b = names[j];
      if (b.length < 5 || b.length > 30) continue;
      if (Math.abs(a.length - b.length) > 2) continue;
      // Quick check: first chars should match to avoid obviously different words
      if (a[0].toLowerCase() !== b[0].toLowerCase()) continue;
      const d = levenshtein(a.toLowerCase(), b.toLowerCase());
      if (d > 0 && d <= 2) {
        // Skip if already captured as substring
        if (a.includes(b) || b.includes(a)) continue;
        findings.push({ a, b, reason: `edit distance ${d}` });
      }
    }
  }
  return findings;
}

function levenshtein(s1, s2) {
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;
  const prev = new Array(s2.length + 1);
  const cur = new Array(s2.length + 1);
  for (let j = 0; j <= s2.length; j++) prev[j] = j;
  for (let i = 1; i <= s1.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= s2.length; j++) prev[j] = cur[j];
  }
  return prev[s2.length];
}
