// Settings migration: push Budgetwise's per-budget preferences into Actual
// using the internal `preferences/save` handler.
//
// Why a separate module: keeps the @actual-app/api surface contact (one
// place that knows about `api.lib.send`) out of bin/import_budgetwise.js,
// and lets us unit-test the mapping without standing up a fake API.
//
// Mapping table is sourced from `SYNCED_PREF_KEYS` in
// @actual-app/api/dist/app/bundle.api.js (line 121859 at the time of
// writing), restricted to keys the user can reasonably want to carry over:
//
//   Actual pref       | BW field     | Notes
//   ------------------|--------------|----------------------------------------
//   dateFormat        | date_format  | Only forwarded if value is in the
//                    |              | known Actual whitelist (whitelist+guide
//                    |              | strategy — see WHITELIST below).
//   firstDayOfWeekIdx | first_day    | Stringified; values are 0-6.
//   numberFormat      | decimal+     | Mapped from separator combo via
//                    | thousands    | NUMBER_FORMAT_BY_SEPARATORS.
//   budgetType        | global_ltb   | false -> "envelope", true -> "tracking".
//
// Anything else in BW's settings.json (hide_due_date, month_view,
// show_symbol, symbol) has no programmatic equivalent in @actual-app/api —
// the guide lists these so the user can apply them by hand.
//
// All Actual values are stored as strings (prefs.d.ts:5 "value: string").

import logger from './logger.js';

// ----------------------------------------------------------------------------
// Pure: BW settings -> Actual mappings
// ----------------------------------------------------------------------------

// Known-accepted dateFormat strings in Actual. Defensively narrow — if BW
// uses a value not in this set, we skip the API call and rely on the guide
// rather than writing a value the UI might silently ignore or reject.
const DATE_FORMAT_WHITELIST = new Set([
  'MM/dd/yyyy',
  'dd/MM/yyyy',
  'yyyy-MM-dd',
  'dd.MM.yyyy',
  'yyyy/MM/dd',
  'MM.dd.yyyy',
]);

// Translate (decimal, thousands) -> Actual numberFormat enum. Only the 5
// values exposed in bundle.api.js's getNumberFormat are accepted. Anything
// outside this map means BW had a custom separator set; the guide handles it.
const NUMBER_FORMAT_BY_SEPARATORS = {
  '.,': 'comma-dot',      // en-US  1,000.00
  ',.': 'dot-comma',      // de-DE  1.000,00
  '.,\u2019': 'apostrophe-dot',  // de-CH  1’000.00 (BW uses ASCII ' typically)
  '.,\'': 'apostrophe-dot',
  ', ': 'space-comma',    // fr-FR  1 000,00
  ',,': 'comma-dot-in',   // en-IN  1,00,000.00
};

function numberFormatFor(bw) {
  const dec = bw.decimal || '.';
  const thou = bw.thousands || ',';
  const key = `${dec}${thou}`;
  return NUMBER_FORMAT_BY_SEPARATORS[key] || null;
}

// Translate BW `date_format` (e.g. "MM/DD/YY") into Actual's accepted form
// (e.g. "MM/dd/yyyy"). Common cases:
//   YY  -> yyyy   (4-digit year is the modern Actual norm)
//   DD  -> dd
//   YYYY-> yyyy (already 4-digit, left as-is)
// Returns null when we cannot safely map (e.g. exotic locale formats).
function translateDateFormat(bwFmt) {
  if (!bwFmt || typeof bwFmt !== 'string') return null;
  let out = bwFmt;
  out = out.replace(/YYYY/g, 'yyyy').replace(/YY(?!Y)/g, 'yyyy');
  out = out.replace(/DD/g, 'dd').replace(/D(?!D)/g, 'd');
  out = out.replace(/MM(?!M)/g, 'MM');  // month is MM in both
  if (!DATE_FORMAT_WHITELIST.has(out)) return null;
  return out;
}

/**
 * Pure: Budgetwise settings payload -> Actual preference mappings.
 *
 * @param {{data?: Array}} settingsPayload - The /budgets/{id}/settings response.
 *   Accepts either the wrapped {data: [...]} form (what /api returns) or a
 *   plain array. Returns mappings for the first record only — there is
 *   exactly one settings record per budget in Budgetwise.
 *
 * @returns {{
 *   mappings: Array<{id: string, value: string, bwKey: string}>,
 *   skipped:  Array<{bwKey: string, reason: string}>,
 *   unrecognized: string[],   // BW fields present that we never tried
 * }}
 */
export function bwPrefsToActual(settingsPayload) {
  const settings = Array.isArray(settingsPayload?.data)
    ? settingsPayload.data[0]
    : Array.isArray(settingsPayload)
      ? settingsPayload[0]
      : null;

  const mappings = [];
  const skipped = [];
  const unrecognized = [];

  if (!settings || typeof settings !== 'object') {
    return { mappings, skipped, unrecognized };
  }

  // ---- dateFormat ----
  if (typeof settings.date_format === 'string') {
    const translated = translateDateFormat(settings.date_format);
    if (translated) {
      mappings.push({
        id: 'dateFormat',
        value: translated,
        bwKey: 'date_format',
      });
    } else {
      skipped.push({
        bwKey: 'date_format',
        reason: `Value "${settings.date_format}" not in Actual's known dateFormat set; manual setting required`,
      });
    }
  }

  // ---- firstDayOfWeekIdx (0..6, integer in BW; string in Actual) ----
  if (Number.isInteger(settings.first_day) && settings.first_day >= 0 && settings.first_day <= 6) {
    mappings.push({
      id: 'firstDayOfWeekIdx',
      value: String(settings.first_day),
      bwKey: 'first_day',
    });
  } else if ('first_day' in settings) {
    skipped.push({
      bwKey: 'first_day',
      reason: `Unexpected first_day value "${settings.first_day}" (expected integer 0..6); manual setting required`,
    });
  }

  // ---- numberFormat (decimal + thousands -> enum) ----
  if ('decimal' in settings || 'thousands' in settings) {
    const nf = numberFormatFor(settings);
    if (nf) {
      mappings.push({
        id: 'numberFormat',
        value: nf,
        bwKey: 'decimal+thousands',
      });
    } else {
      skipped.push({
        bwKey: 'decimal+thousands',
        reason: `Combination decimal="${settings.decimal}" thousands="${settings.thousands}" has no Actual equivalent; manual setting required`,
      });
    }
  }

  // ---- budgetType (global_ltb) ----
  if (typeof settings.global_ltb === 'boolean') {
    mappings.push({
      id: 'budgetType',
      value: settings.global_ltb ? 'tracking' : 'envelope',
      bwKey: 'global_ltb',
    });
  }

  // ---- Track unrecognized fields for the guide ----
  const KNOWN = new Set([
    'budget_id', 'id', 'date_format', 'decimal', 'first_day',
    'global_ltb', 'hide_due_date', 'month_view', 'num_of_months',
    'show_symbol', 'symbol', 'thousands',
  ]);
  for (const k of Object.keys(settings)) {
    if (!KNOWN.has(k)) unrecognized.push(k);
  }

  return { mappings, skipped, unrecognized };
}

// ----------------------------------------------------------------------------
// Settings guide (manual fallback / unmapped keys)
// ----------------------------------------------------------------------------

/**
 * Markdown checklist of BW settings that have no programmatic Actual equivalent.
 * Always emitted (regardless of API success) — even fully-applied migrations
 * can benefit from a glance at what's NOT applied.
 *
 * The returned markdown is body-only (no leading `# Title`) so it can be
 * embedded inside the bundled `MIGRATION_REPORT.md` without producing a
 * nested h1. Callers using it standalone can prepend their own heading.
 */
export function settingsMigrationGuide(bwPayload, unrecognized = [], skippedMappings = []) {
  const settings = Array.isArray(bwPayload?.data)
    ? bwPayload.data[0]
    : Array.isArray(bwPayload)
      ? bwPayload[0]
      : {};

  const lines = [];
  lines.push('These Budgetwise settings did not have a programmatic equivalent in `@actual-app/api`. Apply them manually in Actual → Settings → Preferences after the import.');
  lines.push('');

  const pushRow = (bwKey, bwValue, where, note = '') => {
    const v = (bwValue === null || bwValue === undefined || bwValue === '') ? '—' : String(bwValue);
    lines.push(`- [ ] **${bwKey}** = \`${v}\` → ${where}${note ? ` — _${note}_` : ''}`);
  };

  if ('show_symbol' in settings || 'symbol' in settings) {
    pushRow(
      'show_symbol + symbol',
      `${settings.show_symbol}/${settings.symbol}`,
      'Actual → Settings → Preferences → Display',
      'There is no per-budget currency-symbol toggle; Actual uses the budget file\'s currency (set on creation).',
    );
  }
  if ('hide_due_date' in settings) {
    pushRow(
      'hide_due_date',
      settings.hide_due_date,
      'Actual → Settings → Preferences → Scheduled Transactions',
      'Toggle "Show transaction dates" or similar.',
    );
  }
  if ('month_view' in settings) {
    pushRow(
      'month_view',
      settings.month_view,
      'Actual → Settings → Preferences → Display',
      'BW "single" / "all" maps roughly to Actual\'s single-month vs multi-month view.',
    );
  }

  if (skippedMappings.length > 0) {
    lines.push('');
    lines.push('## Auto-migration was skipped for:');
    lines.push('');
    for (const s of skippedMappings) {
      lines.push(`- [ ] **${s.bwKey}** — _${s.reason}_`);
    }
  }

  if (unrecognized.length > 0) {
    lines.push('');
    lines.push('## Unrecognized Budgetwise settings:');
    lines.push('');
    lines.push('These keys appeared in your `settings.json` but the importer does not handle them. Review them by hand if they matter to you:');
    lines.push('');
    for (const k of unrecognized) lines.push(`- \`${k}\``);
  }

  return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------------------
// API: apply via injected send function
// ----------------------------------------------------------------------------

/**
 * Apply mappings to Actual by calling `send('preferences/save', {id, value})`
 * for each one. Returns applied/failed arrays so the caller can both log and
 * surface the result in MIGRATION_REPORT.md.
 *
 * The send function is injected so tests can stub it without reaching into
 * `api.lib`. In production, bin/import_budgetwise.js passes
 * `(name, args) => api.lib.send(name, args)`.
 *
 * Note: `preferences/save` is a registered mutator handler that updates the
 * `preferences` table in the active budget file. It persists via the same
 * sync mechanism as budget cells; we call api.sync() once after this pass
 * to push the writes to the server.
 *
 * @param {(name: string, args: any) => Promise<any>} send
 * @param {Array<{id: string, value: string}>} mappings
 * @returns {Promise<{applied: Array, failed: Array}>}
 */
export async function applySyncedPrefs(send, mappings) {
  const applied = [];
  const failed = [];
  for (const m of mappings) {
    try {
      await send('preferences/save', { id: m.id, value: m.value });
      applied.push(m);
    } catch (e) {
      failed.push({ id: m.id, value: m.value, error: e?.message || String(e) });
    }
  }
  return { applied, failed };
}

// ----------------------------------------------------------------------------
// Orchestration helper used by bin/import_budgetwise.js
// ----------------------------------------------------------------------------

/**
 * One-call helper: take the raw BW settings payload, derive the mappings,
 * apply via `send`, return everything callers need to surface results.
 *
 * @param {(name: string, args: any) => Promise<any>} send
 * @param {{data?: Array} | Array} bwSettingsPayload
 * @returns {Promise<{
 *   applied: Array,
 *   failed: Array,
 *   skipped: Array,
 *   unrecognized: string[],
 *   guideMarkdown: string,
 * }>}
 */
export async function migrateSettings(send, bwSettingsPayload) {
  const { mappings, skipped, unrecognized } = bwPrefsToActual(bwSettingsPayload);
  let applied = [];
  let failed = [];
  if (mappings.length > 0) {
    const res = await applySyncedPrefs(send, mappings);
    applied = res.applied;
    failed = res.failed;
  }
  // Always emit the guide — even fully-applied migrations have unmapped
  // fields worth glancing at (currency symbol, month view, etc.).
  const guideMarkdown = settingsMigrationGuide(bwSettingsPayload, unrecognized, skipped);
  if (applied.length > 0) {
    logger.info(`  settings migrated via API: ${applied.length}/${mappings.length}`);
  }
  if (failed.length > 0) {
    logger.warn(`  settings API failed for ${failed.length} key(s); guide covers them`);
  }
  if (applied.length === 0 && mappings.length > 0) {
    logger.warn(`  settings could not be auto-migrated; see \`MIGRATION_REPORT.md\` § Settings`);
  }
  return { applied, failed, skipped, unrecognized, guideMarkdown };
}
