#!/usr/bin/env node
// Smoke test: connect to Actual, create a throwaway budget via runImport, shut down.
// Validates ACTUAL_SERVER_URL + ACTUAL_PASSWORD without touching any data.

import { config } from '../lib/config.js';
import { setLevel, logger } from '../lib/logger.js';
import * as api from '@actual-app/api';
import { checkCollision } from '../lib/budget-mgmt.js';
import * as fs from 'node:fs';

if (process.argv.includes('--verbose')) setLevel('debug');

const SMOKE_NAME = '__smoke-test-budget';

async function main() {
  if (!fs.existsSync(config.actual.dataDir)) {
    fs.mkdirSync(config.actual.dataDir, { recursive: true });
  }

  logger.section('Smoke test');
  logger.info(`  server:  ${config.actual.serverURL}`);

  await api.init({
    serverURL: config.actual.serverURL,
    password: config.actual.password,
    dataDir: config.actual.dataDir,
  });
  logger.info('  ✓ init() succeeded');

  try {
    await api.runImport(SMOKE_NAME, async () => {
      // Intentionally empty
    });
    logger.info(`  ✓ runImport("${SMOKE_NAME}") succeeded`);
  } catch (e) {
    logger.error(`  ✗ runImport failed: ${e.message}`);
    throw e;
  }

  const collisions = await checkCollision(SMOKE_NAME);
  logger.info(`  smoke-test file "${SMOKE_NAME}" left in place; ${collisions} prior collision(s)`);

  await api.shutdown();
  logger.info('  ✓ shutdown() succeeded');

  logger.section('Smoke test PASSED');
}

main().catch((e) => {
  logger.error(e.stack || e.message);
  process.exit(1);
});
