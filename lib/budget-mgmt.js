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

// Stub kept for API compat with earlier draft. No-op now.
export async function autoWipe(_name) {
  logger.warn('autoWipe is a no-op in this Actual API version; user must delete files via UI.');
  return 0;
}
