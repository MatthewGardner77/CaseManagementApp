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
// Concurrency cap. Kept deliberately low: the scheduler fires requests without
// awaiting them, so if downstream slows, in-flight requests would otherwise
// snowball and saturate the host CPU (turning a brief spike into a permanent
// one). 25 leaves ample headroom at the default rate while bounding a runaway.
const MAX_IN_FLIGHT = parseInt(process.env.MAX_IN_FLIGHT || '25', 10);
const SEEDED_CASES = parseInt(process.env.SEEDED_CASES || '300', 10);

// How long a case sits in New before the worker population picks it up. Without
// this, changeStatus only ever touched the seeded range and every case created
// since deployment stayed New forever, skewing the table to ~100% one value and
// destroying the selectivity of every status index.
const STATUS_AGE_HOURS = parseInt(process.env.STATUS_AGE_HOURS || '24', 10);

// Retention sweep. Bounded per batch and per run so a large first pass cannot
// hold a long lock or run away. Cases below SEEDED_CASES are never reaped, since
// openCase and the changeStatus fallback both depend on that range existing.
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '60', 10);
const REAP_BATCH = parseInt(process.env.REAP_BATCH || '1000', 10);
const REAP_MAX_PER_RUN = parseInt(process.env.REAP_MAX_PER_RUN || '50000', 10);
const REAP_INTERVAL_MS = parseInt(process.env.REAP_INTERVAL_MS || '3600000', 10);

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'casemgmt',
  password: process.env.PGPASSWORD || 'casemgmt',
  database: process.env.PGDATABASE || 'casemgmt',
  // 3 rather than 2: config polling, the ageing lookup and the retention sweep
  // can overlap. Still deliberately tiny next to case-service's pool.
  max: 3
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];

let cfg = { running: true, rps: 3 };
let inFlight = 0;
const stats = { total: 0, ok: 0, failed: 0, byFlow: {}, aged: 0, reaped: 0 };

// Working list of cases that have sat in New past STATUS_AGE_HOURS. Topped up
// from Postgres and consumed one id at a time so we work through the backlog
// rather than re-touching the same few rows.
let agingIds = [];

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Wei', 'Aisha', 'Carlos', 'Fatima', 'John', 'Karen'];
const LAST = ['Smith', 'Johnson', 'Garcia', 'Nguyen', 'Patel', 'Kim', 'Okafor', 'Brown', 'Davis', 'Lopez'];
const TYPES = ['Benefits Claim', 'FOIA Request', 'Permit Application', 'Appeal'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
// Where an aged New case goes next. Weighted towards the active pipeline so the
// table keeps a realistic spread instead of everything jumping straight to a
// terminal state, but terminal outcomes still occur so closed_at populates and
// the avg-days-to-close figure on the dashboard stays meaningful.
const STATUSES = [
  'In Review', 'In Review', 'In Review',
  'Pending Info', 'Pending Info',
  'Approved', 'Denied', 'Closed'
];

// Weighted flow table — browse/open dominate, writes are occasional, exactly
// like a real case-worker population.
// changeStatus must out-weigh createCase or the New backlog grows without
// bound: at 3 rps, each point of weight is ~2,600 cases/day. With createCase at
// 7 and changeStatus at 13, ageing clears ~33.7k/day against ~18.1k/day created,
// so the backlog drains instead of accumulating.
const FLOWS = [
  { name: 'browseQueue', weight: 25, run: browseQueue },
  { name: 'openCase', weight: 26, run: openCase },
  { name: 'dashboard', weight: 14, run: dashboard },
  { name: 'search', weight: 10, run: search },
  { name: 'createCase', weight: 7, run: createCase },
  { name: 'changeStatus', weight: 13, run: changeStatus },
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
  // Work through the backlog of aged New cases. Falls back to the seeded range
  // when the backlog is empty, so the flow still generates traffic on a fresh
  // database where nothing has aged past the threshold yet.
  let id;
  if (agingIds.length) {
    id = agingIds.shift();
    stats.aged++;
  } else {
    id = 1 + rnd(SEEDED_CASES);
  }
  return req('PATCH', `/api/cases/${id}/status`, { status: pick(STATUSES) });
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

// --- Case ageing -----------------------------------------------------------
// Tops up the working list of cases that have sat in New past the threshold.
// Only refills when the list runs low, so this is not issued every cycle. The
// ORDER BY matches idx_cases_created, so it walks the index and stops at LIMIT
// instead of scanning the New backlog.
async function refreshAgingIds() {
  if (agingIds.length > 50) return;
  try {
    const { rows } = await pool.query(
      `SELECT id
         FROM cases
        WHERE status = 'New'
          AND created_at < now() - make_interval(hours => $1)
        ORDER BY created_at ASC
        LIMIT 500`,
      [STATUS_AGE_HOURS]
    );
    agingIds = rows.map((r) => r.id);
  } catch (_e) {
    // Keep the last known list if the DB hiccups.
  }
}

// --- Retention sweep -------------------------------------------------------
// Deletes in bounded batches so a large first pass cannot hold a long lock or
// stall the request path. case_notes rows go with them via ON DELETE CASCADE.
// The seeded range is excluded on purpose: openCase and the changeStatus
// fallback address those ids directly and would 404 continuously without them.
async function reapOldCases() {
  let removed = 0;
  try {
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM cases
          WHERE id IN (
            SELECT id
              FROM cases
             WHERE created_at < now() - make_interval(days => $1)
               AND id > $2
             ORDER BY created_at ASC
             LIMIT $3
          )`,
        [RETENTION_DAYS, SEEDED_CASES, REAP_BATCH]
      );
      removed += rowCount;
      if (rowCount < REAP_BATCH || removed >= REAP_MAX_PER_RUN) break;
      // Yield between batches so the sweep never monopolises its connection.
      await sleep(250);
    }
    if (removed) {
      stats.reaped += removed;
      console.log(
        `[loadgen] retention: removed ${removed} case(s) older than ${RETENTION_DAYS}d` +
          (removed >= REAP_MAX_PER_RUN ? ' (per-run cap hit, continues next sweep)' : '')
      );
    }
  } catch (err) {
    console.warn(`[loadgen] retention sweep failed: ${err.message}`);
  }
}

function reportLoop() {
  setInterval(() => {
    const flows = Object.entries(stats.byFlow)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `[loadgen] running=${cfg.running} rps=${cfg.rps} inFlight=${inFlight} ` +
        `total=${stats.total} ok=${stats.ok} failed=${stats.failed} ` +
        `aged=${stats.aged} reaped=${stats.reaped} backlog=${agingIds.length} | ${flows}`
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

  // Ageing backlog: prime it, then top up on a slow interval.
  await refreshAgingIds();
  setInterval(refreshAgingIds, 30000);

  // Retention: first sweep a minute after start, so an already-large database
  // gets trimmed without waiting a full interval, then on the normal cadence.
  setTimeout(reapOldCases, 60000);
  setInterval(reapOldCases, REAP_INTERVAL_MS);

  reportLoop();
  tick();
  console.log(
    `[loadgen] started against ${GATEWAY_URL} ` +
      `(ageing New cases after ${STATUS_AGE_HOURS}h, retention ${RETENTION_DAYS}d)`
  );
}

main();
