'use strict';

// ============================================================================
// loadgen
// ----------------------------------------------------------------------------
// Runs continuously from startup, exercising realistic citizen flows against
// the gateway so Dynatrace always has a baseline. The request rate (and a
// running on/off switch) is read from the loadgen_config row in Postgres,
// which the /control panel writes to — so the operator can dial traffic up or
// down, or pause it, live, without restarts.
//
// Requests are fired without awaiting each other (capped) so that when a
// BACKEND_SLOWDOWN scenario makes responses slow, the offered request RATE
// stays steady instead of collapsing — which is what lets the scenario build
// a visible signal.
// ============================================================================

const { Pool } = require('pg');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:8080';
const MAX_IN_FLIGHT = parseInt(process.env.MAX_IN_FLIGHT || '250', 10);
const SEEDED_CASES = parseInt(process.env.SEEDED_CASES || '300', 10);

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'casemgmt',
  password: process.env.PGPASSWORD || 'casemgmt',
  database: process.env.PGDATABASE || 'casemgmt',
  max: 2
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];

let cfg = { running: true, rps: 6 };
let inFlight = 0;
const stats = { total: 0, ok: 0, failed: 0, byFlow: {} };

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Wei', 'Aisha', 'Carlos', 'Fatima', 'John', 'Karen'];
const LAST = ['Smith', 'Johnson', 'Garcia', 'Nguyen', 'Patel', 'Kim', 'Okafor', 'Brown', 'Davis', 'Lopez'];
const TYPES = ['Benefits Claim', 'FOIA Request', 'Permit Application', 'Appeal'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const STATUSES = ['In Review', 'Pending Info', 'Approved', 'Denied', 'Closed'];

// Weighted flow table — browse/open dominate, writes are occasional, exactly
// like a real case-worker population.
const FLOWS = [
  { name: 'browseQueue', weight: 30, run: browseQueue },
  { name: 'openCase', weight: 28, run: openCase },
  { name: 'dashboard', weight: 14, run: dashboard },
  { name: 'search', weight: 10, run: search },
  { name: 'createCase', weight: 7, run: createCase },
  { name: 'changeStatus', weight: 6, run: changeStatus },
  { name: 'addNote', weight: 5, run: addNote }
];
const TOTAL_WEIGHT = FLOWS.reduce((s, f) => s + f.weight, 0);

function pickFlow() {
  let r = rnd(TOTAL_WEIGHT);
  for (const f of FLOWS) {
    if (r < f.weight) return f;
    r -= f.weight;
  }
  return FLOWS[0];
}

async function req(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(GATEWAY_URL + urlPath, opts);
  // Drain the body so the connection is reusable.
  await resp.text();
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
}

// --- Flows -----------------------------------------------------------------
function browseQueue() {
  const params = new URLSearchParams();
  if (Math.random() < 0.6) params.set('status', pick(['New', 'In Review', 'Pending Info']));
  if (Math.random() < 0.3) params.set('type', pick(TYPES));
  if (Math.random() < 0.2) params.set('slaBreached', 'true');
  params.set('page', String(1 + rnd(4)));
  return req('GET', `/api/cases?${params.toString()}`);
}

function openCase() {
  return req('GET', `/api/cases/${1 + rnd(SEEDED_CASES)}`);
}

function dashboard() {
  return req('GET', '/api/dashboard');
}

function search() {
  return req('GET', `/api/cases?q=${encodeURIComponent(pick(LAST))}`);
}

function createCase() {
  return req('POST', '/api/cases', {
    citizenName: `${pick(FIRST)} ${pick(LAST)}`,
    caseType: pick(TYPES),
    priority: pick(PRIORITIES),
    fileName: 'application.pdf'
  });
}

function changeStatus() {
  return req('PATCH', `/api/cases/${1 + rnd(SEEDED_CASES)}/status`, { status: pick(STATUSES) });
}

function addNote() {
  return req('POST', `/api/cases/${1 + rnd(SEEDED_CASES)}/notes`, {
    author: 'Officer Loadgen',
    body: 'Routine review performed; no action required at this time.'
  });
}

// --- Scheduler -------------------------------------------------------------
function fire() {
  if (inFlight >= MAX_IN_FLIGHT) return;
  const flow = pickFlow();
  inFlight++;
  stats.total++;
  stats.byFlow[flow.name] = (stats.byFlow[flow.name] || 0) + 1;
  flow
    .run()
    .then(() => {
      stats.ok++;
    })
    .catch(() => {
      stats.failed++;
    })
    .finally(() => {
      inFlight--;
    });
}

async function tick() {
  if (cfg.running && cfg.rps > 0) fire();
  const delay = cfg.running && cfg.rps > 0 ? Math.max(15, Math.floor(1000 / cfg.rps)) : 1000;
  setTimeout(tick, delay);
}

async function refreshConfig() {
  try {
    const { rows } = await pool.query('SELECT running, rps FROM loadgen_config WHERE id = 1');
    if (rows[0]) cfg = { running: rows[0].running, rps: rows[0].rps };
  } catch (_e) {
    // Keep last known config if the DB hiccups.
  }
}

function reportLoop() {
  setInterval(() => {
    const flows = Object.entries(stats.byFlow)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `[loadgen] running=${cfg.running} rps=${cfg.rps} inFlight=${inFlight} ` +
        `total=${stats.total} ok=${stats.ok} failed=${stats.failed} | ${flows}`
    );
  }, 15000);
}

async function waitForGateway(retries = 60) {
  for (let i = 1; i <= retries; i++) {
    try {
      const resp = await fetch(GATEWAY_URL + '/health');
      if (resp.ok) {
        await resp.text();
        console.log('[loadgen] gateway is up');
        return;
      }
    } catch (_e) {
      /* not ready yet */
    }
    console.log(`[loadgen] waiting for gateway (${i}/${retries})`);
    await sleep(2000);
  }
  console.warn('[loadgen] gateway never confirmed healthy; starting anyway');
}

async function main() {
  await refreshConfig();
  await waitForGateway();
  setInterval(refreshConfig, 2000);
  reportLoop();
  tick();
  console.log(`[loadgen] started against ${GATEWAY_URL}`);
}

main();
