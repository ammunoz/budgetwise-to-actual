// Budgetwise Express backend client — read-only.
//
// Captures all data needed for an Actual Budget migration into JSON files.
// Stateless beyond a bearer token obtained from login.
//
// Verified against the my.budgetwise.io deployment (user-facing web app,
// circa 2026-08). The host can be overridden via BUDGETWISE_API_URL for
// testing against other deployments, but those are untested.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import logger from './logger.js';

const BASE = (process.env.BUDGETWISE_API_URL || 'https://ex.budgetwise.io') + '/api';

async function login(email, password) {
  const r = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Budgetwise login failed: ${r.status} ${body}`);
  }
  const j = await r.json();
  return j.meta.token;
}

async function get(token, path) {
  const url = `${BASE}${path}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer: ${token}`,
      'Accept': 'application/json',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GET ${path} failed: ${r.status} ${body}`);
  }
  return r.json();
}

async function post(token, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer: ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST ${path} failed: ${r.status} ${t}`);
  }
  return r.json();
}

export async function listBudgets(email, password) {
  const token = await login(email, password);
  const r = await get(token, '/budgets');
  return { token, budgets: r.data };
}

// Resolve budgetId from a name-or-id string. Returns {id, name} or null.
export async function resolveBudget(token, nameOrId) {
  const r = await get(token, '/budgets');
  const list = r.data;
  const exact = list.find((b) => b.id === nameOrId);
  if (exact) return exact;
  const byName = list.find((b) => b.name.toLowerCase() === nameOrId.toLowerCase());
  if (byName) return byName;
  return null;
}

// Capture all endpoints needed. Each endpoint returns its raw response.
const ENDPOINTS = {
  accounts:        (t, id) => get(t, `/budgets/${id}/accounts`),
  categories:      (t, id) => get(t, `/budgets/${id}/categories`),
  sections:        (t, id) => get(t, `/budgets/${id}/sections`),
  payees:          (t, id) => get(t, `/budgets/${id}/payees`),
  settings:        (t, id) => get(t, `/budgets/${id}/settings`),
  // These endpoints require ?date=<iso> as a cache-buster; otherwise they
  // return 400 "Internal server error". See recon-budget.md.
  timeframeCategories: (t, id) => get(t, `/budgets/${id}/timeframe_categories?date=${new Date().toISOString()}`),
  ltbBreakdown:    (t, id) => get(t, `/budgets/${id}/ltb_breakdown?date=${new Date().toISOString()}`),
  transactions:    async (t, id) => {
    const r = await get(t, `/budgets/${id}/transactions`);
    return r;
  },
};

export async function captureAll({ email, password, budgetId, outDir }) {
  const token = await login(email, password);
  logger.info(`Logged in to Budgetwise Express`);
  const summary = {};
  for (const [name, fn] of Object.entries(ENDPOINTS)) {
    const t0 = Date.now();
    let payload;
    try {
      payload = await fn(token, budgetId);
    } catch (e) {
      logger.warn(`Skipping ${name}: ${e.message}`);
      summary[name] = { ok: false, error: e.message };
      continue;
    }
    const file = resolve(outDir, `${name}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(payload, null, 2));
    const data = payload?.data ?? payload;
    const count = Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : '?');
    logger.info(`  ${name}: ${count} entries (${Date.now() - t0}ms)`);
    summary[name] = { ok: true, count };
  }
  // Manifest
  const manifest = {
    budgetId,
    capturedAt: new Date().toISOString(),
    endpointCounts: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.count ?? null])),
  };
  await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { token, summary, manifest };
}
