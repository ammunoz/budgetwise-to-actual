import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Load .env from repo root (one level up from lib/)
require('dotenv').config({ path: resolve(here, '..', '.env') });

const env = (k, fallback = undefined) => {
  const v = process.env[k];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${k}`);
  }
  return v;
};

const optEnv = (k, fallback = '') => process.env[k] || fallback;

export const config = {
  actual: {
    serverURL: env('ACTUAL_SERVER_URL'),
    password: env('ACTUAL_PASSWORD'),
    dataDir: optEnv('ACTUAL_DATA_DIR', './.actual-data'),
  },
  budgetwise: {
    email: env('BUDGETWISE_EMAIL'),
    password: env('BUDGETWISE_PASSWORD'),
    budgetId: env('BUDGETWISE_BUDGET_ID'),
  },
  paths: {
    // default: <project_root>/captured (relative to importer/, two levels up)
    capturedDir: resolve(here, '..', '..', optEnv('CAPTURED_DIR', 'captured')),
  },
};

export default config;
