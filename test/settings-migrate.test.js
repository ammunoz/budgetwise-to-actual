// Tests for lib/settings-migrate.js — pure mapping + injected-send API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bwPrefsToActual,
  settingsMigrationGuide,
  applySyncedPrefs,
  migrateSettings,
} from '../lib/settings-migrate.js';

const SAMPLE_BW = {
  data: [{
    budget_id: 'a-uuid',
    id: 'a-uuid',
    date_format: 'MM/DD/YY',
    decimal: '.',
    first_day: 0,
    global_ltb: false,
    hide_due_date: true,
    month_view: 'single',
    num_of_months: 1,
    show_symbol: true,
    symbol: '$',
    thousands: ',',
  }],
};

test('bwPrefsToActual: canonical sample maps dateFormat/firstDay/numberFormat/budgetType', () => {
  const { mappings, skipped, unrecognized } = bwPrefsToActual(SAMPLE_BW);
  const byId = Object.fromEntries(mappings.map((m) => [m.id, m.value]));
  assert.equal(byId.dateFormat, 'MM/dd/yyyy');
  assert.equal(byId.firstDayOfWeekIdx, '0');
  assert.equal(byId.numberFormat, 'comma-dot');
  assert.equal(byId.budgetType, 'envelope');
  assert.equal(skipped.length, 0);
  assert.deepEqual(unrecognized.sort(), []);
});

test('bwPrefsToActual: global_ltb=true maps to tracking', () => {
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], global_ltb: true }],
  });
  assert.equal(out.mappings.find((m) => m.id === 'budgetType').value, 'tracking');
});

test('bwPrefsToActual: dot-comma German separators', () => {
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], decimal: ',', thousands: '.' }],
  });
  assert.equal(out.mappings.find((m) => m.id === 'numberFormat').value, 'dot-comma');
});

test('bwPrefsToActual: unknown separator combo -> skipped, no mapping', () => {
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], decimal: ';', thousands: '|' }],
  });
  assert.equal(out.mappings.find((m) => m.id === 'numberFormat'), undefined);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /no Actual equivalent/);
});

test('bwPrefsToActual: exotic date_format -> skipped', () => {
  // "MM-YY" is two-digit year, two-digit month; not in whitelist after translate.
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], date_format: 'MM-YY' }],
  });
  assert.equal(out.mappings.find((m) => m.id === 'dateFormat'), undefined);
  assert.equal(out.skipped.length, 1);
});

test('bwPrefsToActual: 4-digit year date_format passes through translate', () => {
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], date_format: 'dd/MM/yyyy' }],
  });
  assert.equal(out.mappings.find((m) => m.id === 'dateFormat').value, 'dd/MM/yyyy');
});

test('bwPrefsToActual: out-of-range first_day -> skipped with reason', () => {
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], first_day: 7 }],
  });
  assert.equal(out.mappings.find((m) => m.id === 'firstDayOfWeekIdx'), undefined);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /first_day/);
});

test('bwPrefsToActual: unrecognized field surfaces for the guide', () => {
  const out = bwPrefsToActual({
    data: [{ ...SAMPLE_BW.data[0], made_up_field: 'foo' }],
  });
  assert.deepEqual(out.unrecognized, ['made_up_field']);
});

test('bwPrefsToActual: empty/null payload yields empty mappings', () => {
  assert.deepEqual(bwPrefsToActual(null), { mappings: [], skipped: [], unrecognized: [] });
  assert.deepEqual(bwPrefsToActual({}), { mappings: [], skipped: [], unrecognized: [] });
  assert.deepEqual(bwPrefsToActual({ data: [] }), { mappings: [], skipped: [], unrecognized: [] });
});

test('settingsMigrationGuide: lists currency, due date, month view', () => {
  const md = settingsMigrationGuide(SAMPLE_BW);
  // Body-only output (no leading h1) so it composes cleanly inside a
  // bundled report without nesting h1s. The phrase "settings migration
  // guide" still appears in the prose.
  assert.match(md, /programmatic equivalent/);
  assert.match(md, /show_symbol/);
  assert.match(md, /hide_due_date/);
  assert.match(md, /month_view/);
  assert.doesNotMatch(md, /^# /m, 'settingsMigrationGuide must not emit a leading h1');
});

test('settingsMigrationGuide: skipped + unrecognized entries appear', () => {
  const md = settingsMigrationGuide(SAMPLE_BW, ['weirdKey'], [
    { bwKey: 'date_format', reason: 'unknown' },
  ]);
  assert.match(md, /date_format.*unknown/s);
  assert.match(md, /weirdKey/);
});

test('applySyncedPrefs: each mapping calls send; failures recorded', async () => {
  const calls = [];
  const send = async (name, args) => {
    calls.push({ name, args });
    if (args.id === 'bad') throw new Error('boom');
  };
  const mappings = [
    { id: 'dateFormat', value: 'MM/dd/yyyy' },
    { id: 'firstDayOfWeekIdx', value: '0' },
    { id: 'bad', value: 'x' },
  ];
  const res = await applySyncedPrefs(send, mappings);
  assert.deepEqual(calls.map((c) => c.name), ['preferences/save', 'preferences/save', 'preferences/save']);
  assert.equal(res.applied.length, 2);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /boom/);
});

test('migrateSettings: end-to-end happy path with injected send', async () => {
  const calls = [];
  const send = async (name, args) => { calls.push({ name, args }); };
  const res = await migrateSettings(send, SAMPLE_BW);
  assert.equal(res.applied.length, 4);
  assert.equal(res.failed.length, 0);
  assert.equal(res.skipped.length, 0);
  assert.deepEqual(res.unrecognized, []);
  // Guide still mentions the manual-only fields.
  assert.match(res.guideMarkdown, /show_symbol/);
});

test('migrateSettings: failure on one key does not block others', async () => {
  const send = async (_name, args) => {
    if (args.id === 'budgetType') throw new Error('budgetType not allowed');
  };
  const res = await migrateSettings(send, SAMPLE_BW);
  assert.equal(res.applied.length, 3);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 'budgetType');
});

test('migrateSettings: returns no mappings for an empty capture', async () => {
  const res = await migrateSettings(async () => {}, null);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 0);
  // Guide is still non-empty: it has the prose intro even with no rows.
  assert.match(res.guideMarkdown, /programmatic equivalent/);
});

test('applySyncedPrefs: every mapping fails when send always throws', async () => {
  // Defensive case: if the @actual-app/api internal handler signature changes
  // and EVERY preferences/save call rejects, the migration should record all
  // failures without aborting.
  const calls = [];
  const send = async (name, args) => {
    calls.push({ name, args });
    throw new Error('preferences/save rejected');
  };
  const mappings = [
    { id: 'dateFormat', value: 'MM/dd/yyyy' },
    { id: 'firstDayOfWeekIdx', value: '0' },
    { id: 'numberFormat', value: 'comma-dot' },
  ];
  const res = await applySyncedPrefs(send, mappings);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.name), ['preferences/save', 'preferences/save', 'preferences/save']);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 3);
  for (const f of res.failed) {
    assert.match(f.error, /preferences\/save rejected/);
  }
});

test('migrateSettings: total API failure -> guide fallback surfaces all keys', async () => {
  // All sends throw; migrateSettings should still produce a usable guide
  // so the user can apply the settings manually in Actual's UI.
  const send = async () => { throw new Error('handler removed'); };
  const res = await migrateSettings(send, SAMPLE_BW);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 4);
  // Guide still lists currency, due date, month view (manual-only fields).
  assert.match(res.guideMarkdown, /show_symbol/);
  assert.match(res.guideMarkdown, /hide_due_date/);
  assert.match(res.guideMarkdown, /month_view/);
});
