// budget-mgmt.js — list Actual budget files + warn about name collisions.
//
// NOTE: This version of @actual-app/api does not expose a programmatic
// "delete budget file" handler. The user must delete prior files via the
// Actual UI: Settings -> Files -> Delete. We therefore do NOT auto-wipe;
// we WARN on collisions and instruct the user.

import * as api from '@actual-app/api';
import logger from './logger.js';

export async function listBudgets() {
  return api.internal.send('api/get-budgets');
}

export async function findByName(needle) {
  const all = await listBudgets();
  return all.filter(b => b.name && b.name.toLowerCase().includes(needle.toLowerCase()));
}

export async function findExact(name) {
  const all = await listBudgets();
  return all.filter(b => b.name === name);
}

// Returns the number of COLLIDING files (those with the exact same name).
// Caller should warn and ask the user to delete them in the UI before re-running.
export async function checkCollision(name) {
  const hits = await findExact(name);
  if (hits.length > 0) {
    logger.warn(`Found ${hits.length} existing file(s) named exactly "${name}":`);
    for (const b of hits) {
      logger.warn(`  - ${b.name} (id=${b.id}, cloudFileId=${b.cloudFileId || 'local'})`);
    }
    logger.warn(`This run will create another file with the same name.`);
    logger.warn(`To start fresh: open Actual, go to Settings -> Files, delete the old "${name}" file, then re-run.`);
  }
  return hits.length;
}

// Resolve a desired budget-name into one that's guaranteed not to collide
// with existing files on the server. The @actual-app/api's runImport is
// always additive — every call creates a new file — so re-running the
// import against a name that's already on the server would silently leave
// the old file in place AND add a new one with the same display name.
// Instead, we pick a free counter suffix:
//
//   resolveUniqueBudgetName('Budget')
//     when free         -> 'Budget'
//     when taken        -> 'Budget-2'
//     when also -2 taken -> 'Budget-3', etc.
//
// The `existing` parameter is the file list to resolve against. When
// omitted, fetches from the server. Tests pass an explicit list to avoid
// monkey-patching the ESM module.
export async function resolveUniqueBudgetName(baseName, existing = null) {
  const all = existing ?? await listBudgets();
  const re = new RegExp(`^${escapeRegExp(baseName)}(-\\d+)?$`);
  const used = new Set(all.filter(b => re.test(b.name)).map(b => b.name));

  if (!used.has(baseName)) return baseName;
  let i = 2;
  while (used.has(`${baseName}-${i}`)) i++;
  return `${baseName}-${i}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Stub kept for API compat with earlier draft. No-op now.
export async function autoWipe(_name) {
  logger.warn('autoWipe is a no-op in this Actual API version; user must delete files via UI.');
  return 0;
}
