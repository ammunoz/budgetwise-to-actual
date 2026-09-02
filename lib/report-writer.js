// Tiny helper to write report artifacts to disk with explicit error handling.
// Used by every post-import report module. Two flavors:
//   writeArtifact(path, content)        — best-effort; warn + return false on
//                                          failure (e.g. SECOND_ACTIONS.md)
//   writeArtifactRequired(path, content) — hard-fail with a clear error on
//                                          failure (e.g. MIGRATION_REPORT.md)
//
// "Hard-fail" here throws; callers in bin/import_budgetwise.js catch around
// postflight reports so a write failure surfaces but doesn't corrupt state.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import logger from './logger.js';

export async function writeArtifact(filePath, content) {
  try {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, content, 'utf8');
    logger.info(`  wrote ${filePath}`);
    return true;
  } catch (e) {
    logger.warn(`  could not write ${filePath}: ${e.message}`);
    return false;
  }
}

export async function writeArtifactRequired(filePath, content) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, content, 'utf8');
  logger.info(`  wrote ${filePath}`);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

// Strip a leading h1 line (`# Title\n`) from a body so the bundled report
// doesn't end up with nested h1s. Used by composeMarkdown when each section
// is emitted under its own h2 heading.
function stripLeadingH1(body) {
  if (!body) return '';
  const lines = body.split('\n');
  if (lines[0] && /^# [^\n]+$/.test(lines[0])) {
    // Drop the first line plus any blank line that follows it.
    let drop = 1;
    if (lines[1] === '') drop = 2;
    return lines.slice(drop).join('\n').trimStart();
  }
  return body;
}

// Compose a markdown document from sections. Trims trailing blanks; skips
// null/empty sections to keep output clean. Each section's body has its
// leading `# Title` line stripped (if present) so we don't produce nested
// h1s when the body itself opens with an h1.
export function composeMarkdown(title, sections) {
  const parts = [];
  if (title) parts.push(`# ${title}\n`);
  for (const s of sections) {
    if (!s || !s.body) continue;
    const cleaned = stripLeadingH1(s.body);
    if (s.heading) parts.push(`\n## ${s.heading}\n`);
    parts.push(cleaned.trimEnd());
    parts.push('');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Resolve the artifact paths for a given capture dir + import bookkeeping.
export function reportPaths(captureDir, budgetName = '') {
  const dir = resolve(captureDir);
  return {
    migrationReport: resolve(dir, 'MIGRATION_REPORT.md'),
    firstActions: resolve(dir, 'FIRST_ACTIONS.md'),
    captureDir: dir,
    budgetName,
  };
}
