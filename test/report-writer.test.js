// Tests for lib/report-writer.js — composeMarkdown + stripLeadingH1 behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMarkdown } from '../lib/report-writer.js';

test('composeMarkdown: simple sections with h2 headings only', () => {
  const md = composeMarkdown('Title', [
    { heading: 'Section A', body: 'Body A text.' },
    { heading: 'Section B', body: 'Body B text.' },
  ]);
  assert.match(md, /^# Title/);
  assert.match(md, /## Section A/);
  assert.match(md, /Body A text/);
  assert.match(md, /## Section B/);
  assert.match(md, /Body B text/);
});

test('composeMarkdown: strips leading h1 from section body', () => {
  // Each section module emits its own h1 title; composeMarkdown drops it
  // so the bundled report has one h1 (the document title) and h2s for
  // sections — no nested h1.
  const md = composeMarkdown('Migration Report', [
    { heading: 'Settings', body: '# Settings Migration Guide\n\nThe guide text here.' },
    { heading: 'Reconciliation', body: '# Reconciliation Report\n\nRecon text here.' },
  ]);
  // h1 document title present
  assert.match(md, /^# Migration Report/);
  // h2 sections present
  assert.match(md, /## Settings/);
  assert.match(md, /## Reconciliation/);
  // The body content is preserved
  assert.match(md, /The guide text here/);
  assert.match(md, /Recon text here/);
  // The stripped h1 line itself is gone (only the doc title h1 remains)
  const h1Lines = md.split('\n').filter((l) => /^# [^#]/.test(l));
  assert.equal(h1Lines.length, 1, `expected exactly one h1 line, got: ${JSON.stringify(h1Lines)}`);
  assert.equal(h1Lines[0], '# Migration Report');
});

test('composeMarkdown: body without leading h1 is passed through unchanged', () => {
  const md = composeMarkdown('Title', [
    { heading: 'Notes', body: 'Just some **markdown** without a heading.' },
  ]);
  assert.match(md, /Just some \*\*markdown\*\* without a heading\./);
});

test('composeMarkdown: empty/null sections are skipped', () => {
  const md = composeMarkdown('Title', [
    null,
    { heading: 'Empty' },
    { heading: 'Real', body: 'Has body.' },
  ]);
  assert.doesNotMatch(md, /## Empty/);
  assert.match(md, /## Real/);
});

test('composeMarkdown: collapses 3+ consecutive newlines to 2', () => {
  const md = composeMarkdown('Title', [
    { heading: 'X', body: 'line1\n\n\n\nline2' },
  ]);
  assert.match(md, /line1\n\nline2/);
  assert.doesNotMatch(md, /\n\n\n/);
});
