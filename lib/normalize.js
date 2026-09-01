// Normalize Budgetwise data into Actual Budget shapes.
//
// Conventions:
//   Budgetwise amounts are decimal strings, positive, with `type: outflow|inflow`.
//   Actual amounts are integers in cents (negative for outflow).
//
//   Budgetwise dates are ISO strings like "2026-06-08T12:00:00.000Z".
//   Actual wants YYYY-MM-DD.

export const toCents = (str) => {
  // str may be "198.33" or "-12.00" etc. Convert via amountToInteger semantics:
  // round-half-up to integer cents.
  const n = typeof str === 'number' ? str : parseFloat(str);
  if (!Number.isFinite(n)) throw new Error(`Non-numeric amount: ${str}`);
  return Math.round(n * 100);
};

export const signAmount = (amountStr, type) => {
  const cents = toCents(amountStr);
  // Normalize -0 to 0 so callers don't need to deal with signed zero.
  return type === 'outflow' ? (cents === 0 ? 0 : -cents) : cents;
};

export const toISODate = (s) => {
  if (typeof s !== 'string') return s;
  // "2026-06-08T12:00:00.000Z" -> "2026-06-08"
  return s.slice(0, 10);
};

// Shift a YYYY-MM-DD date string forward by N months (N defaults to 1).
// Used for Budgetwise's `ltb_next=true` semantics: when the user gets paid
// on the 25th for work done in the current month, BW attributes the income
// to the NEXT month's budget. Without this shift, Actual puts the income
// in the WRONG month and `incomeAvailable` (which is cumulative) diverges
// from Budgetwise's `incomeForMonth`.
export const shiftISODateMonths = (s, delta = 1) => {
  if (typeof s !== 'string') return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  let yyyy = parseInt(m[1], 10);
  let mm = parseInt(m[2], 10);
  const dd = m[3];
  mm += delta;
  while (mm > 12) { mm -= 12; yyyy++; }
  while (mm < 1)  { mm += 12; yyyy--; }
  return `${yyyy}-${String(mm).padStart(2, '0')}-${dd}`;
};

// Build the skip-set: inflow halves of transfer pairs (Actual will auto-create).
// An inflow half is the row in the destination account that has
// `transfer_origin_transaction_id` set.
export function buildTransferSkipSet(transactions) {
  const skip = new Set();
  for (const tx of transactions) {
    if (tx.transfer_origin_transaction_id != null) skip.add(tx.id);
  }
  return skip;
}

// Convenience: sign txs (everywhere they're used). Mutates nothing.
export function signTransactionAmount(tx) {
  return signAmount(tx.amount, tx.type);
}
