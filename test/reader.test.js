// Tests for lib/reader.js payee dedup logic.
//
// We exercise dedupPayees directly (it's not exported, so we re-implement
// the smallest possible test surface by going through loadCapture).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture, unwrap } from '../lib/reader.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function withCapture(name, captureData) {
  const dir = resolve(tmpdir(), `bw2a-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  // loadCapture requires accounts, categories, transactions. Fill in defaults
  // for any that the test doesn't provide.
  const required = {
    accounts: { data: [] },
    categories: { data: [] },
    transactions: { data: [] },
    ...captureData,
  };
  for (const [filename, data] of Object.entries(required)) {
    await writeFile(resolve(dir, `${filename}.json`), JSON.stringify(data));
  }
  try {
    const cap = await loadCapture(dir);
    return unwrap(cap.payees);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('dedup: no duplicates — pass-through', async () => {
  const out = await withCapture('pass', {
    payees: { data: [
      { id: '1', name: 'Amazon' },
      { id: '2', name: 'Costco' },
    ] },
    transactions: { data: [] },
  });
  assert.equal(out.length, 2);
});

test('dedup: exact-name duplicates collapsed', async () => {
  const out = await withCapture('exact', {
    payees: { data: [
      { id: '1', name: 'Square One Insurance' },
      { id: '2', name: 'Square One Insurance' },
      { id: '3', name: 'Square One Insurance' },
      { id: '4', name: 'Costco' },
    ] },
    transactions: { data: [] },
  });
  // 3 duplicates collapsed to 1
  assert.equal(out.length, 2);
  assert.ok(out.some(p => p.name === 'Square One Insurance'));
  assert.ok(out.some(p => p.name === 'Costco'));
});

test('dedup: case-insensitive merges pick variant with most transaction usage', async () => {
  const out = await withCapture('case', {
    payees: { data: [
      { id: 'a', name: 'McDonald\'s' },
      { id: 'b', name: 'mcdonalds' },
      { id: 'c', name: 'Wendy\'s' },
      { id: 'd', name: 'wendys' },
    ] },
    transactions: { data: [
      { payee: 'McDonald\'s' },
      { payee: 'McDonald\'s' },
      { payee: 'McDonald\'s' },
      // mcdonalds: 0 transactions
      { payee: 'Wendy\'s' },
      // wendys: 0 transactions
    ] },
  });
  assert.equal(out.length, 2);
  assert.ok(out.some(p => p.name === 'McDonald\'s'));
  assert.ok(out.some(p => p.name === 'Wendy\'s'));
});

test('dedup: no fuzzy candidates to merge — substring pairs preserved', async () => {
  // 'Big White' and 'Big White Ski Resort' are different vendors — don't merge.
  const out = await withCapture('fuzzy', {
    payees: { data: [
      { id: 'a', name: 'Big White' },
      { id: 'b', name: 'Big White Ski Resort' },
      { id: 'c', name: 'impar' },
      { id: 'd', name: 'impark' },
    ] },
    transactions: { data: [] },
  });
  // No case overlap, no edits ≤ 2 with same first char — both pairs preserved.
  assert.equal(out.length, 4);
});

test('dedup: respects first-seen order on usage tie', async () => {
  const out = await withCapture('tie', {
    payees: { data: [
      { id: 'first', name: 'Twice' },       // seen first
      { id: 'second', name: 'TWICE' },     // same usage, same case-fold
    ] },
    transactions: { data: [
      { payee: 'Twice' },
      { payee: 'TWICE' },
    ] },
  });
  // Tie → first-seen wins (deterministic)
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Twice');
});
