'use strict';

// ============================================================================
// case-service
// ----------------------------------------------------------------------------
// Owns the case-domain Postgres queries: case CRUD, search, dashboard
// aggregations, notes, and the write side of the scenario / loadgen controls.
//
// Self-degrades based on the shared scenario_flags table:
//   DB_FAILURE_RATE  -> a configurable % of case-domain queries are forced to
//                       fail against a non-existent table (real DB errors).
//   BACKEND_SLOWDOWN -> injects latency into the case read endpoints. The
//                       gateway awaits this, so the frontend looks slow while
//                       the true root cause lives here. (Headline RCA scenario.)
// ============================================================================

const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3001', 10);
const FLAG_TTL_MS = parseInt(process.env.FLAG_TTL_MS || '2000', 10);

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'casemgmt',
  password: process.env.PGPASSWORD || 'casemgmt',
  database: process.env.PGDATABASE || 'casemgmt',
  max: parseInt(process.env.PG_POOL_MAX || '10', 10)
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Scenario flags — read from Postgres with a short TTL cache so we honour the
// "every service reads the active flags" contract without hammering the DB on
// every single request. The flags read itself is NEVER subject to failure
// injection, otherwise we could not recover from DB_FAILURE_RATE.
// ---------------------------------------------------------------------------
const DEFAULT_FLAGS = {
  HIGH_CPU: { enabled: false, intensity: 0 },
  DB_FAILURE_RATE: { enabled: false, intensity: 0 },
  BACKEND_SLOWDOWN: { enabled: false, intensity: 0 }
};
let flagCache = { at: 0, data: DEFAULT_FLAGS };

async function getFlags() {
  const now = Date.now();
  if (now - flagCache.at < FLAG_TTL_MS) return flagCache.data;
  try {
    const { rows } = await pool.query('SELECT name, enabled, intensity FROM scenario_flags');
    const data = {};
    for (const r of rows) data[r.name] = { enabled: r.enabled, intensity: r.intensity };
    flagCache = { at: now, data };
    return data;
  } catch (err) {
    // Never let a flag read break the request path; fall back to last known.
    return flagCache.data;
  }
}

// Wraps every case-domain query. Honours DB_FAILURE_RATE by issuing a real
// failing query so the error surfaces in distributed traces and DB telemetry.
async function dbQuery(text, params) {
  const f = (await getFlags()).DB_FAILURE_RATE;
  if (f && f.enabled && Math.random() * 100 < f.intensity) {
    await pool.query('SELECT * FROM injected_failure_nonexistent_table');
  }
  return pool.query(text, params);
}

// Honours BACKEND_SLOWDOWN by awaiting injected latency before responding.
async function maybeSlowdown() {
  const f = (await getFlags()).BACKEND_SLOWDOWN;
  if (f && f.enabled && f.intensity > 0) await sleep(f.intensity);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(morgan('combined'));

const CASE_TYPES = ['Benefits Claim', 'FOIA Request', 'Permit Application', 'Appeal'];
const STATUSES = ['New', 'In Review', 'Pending Info', 'Approved', 'Denied', 'Closed'];
const TERMINAL = ['Approved', 'Denied', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'case-service' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// --- Dashboard aggregations ------------------------------------------------
app.get('/cases/stats', async (_req, res, next) => {
  try {
    await maybeSlowdown();

    const byStatus = await dbQuery(
      'SELECT status, count(*)::int AS count FROM cases GROUP BY status'
    );
    const byType = await dbQuery(
      'SELECT case_type, count(*)::int AS count FROM cases GROUP BY case_type'
    );
    const byPriority = await dbQuery(
      'SELECT priority, count(*)::int AS count FROM cases GROUP BY priority'
    );
    const totals = await dbQuery(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status NOT IN ('Approved','Denied','Closed'))::int AS open,
        count(*) FILTER (
          WHERE sla_due_date < now()
            AND status NOT IN ('Approved','Denied','Closed')
        )::int AS sla_breaches,
        round(
          EXTRACT(EPOCH FROM avg(closed_at - created_at)) / 86400.0, 1
        ) AS avg_days_to_close
      FROM cases
    `);

    const statusCounts = {};
    for (const s of STATUSES) statusCounts[s] = 0;
    for (const r of byStatus.rows) statusCounts[r.status] = r.count;

    const typeCounts = {};
    for (const t of CASE_TYPES) typeCounts[t] = 0;
    for (const r of byType.rows) typeCounts[r.case_type] = r.count;

    const priorityCounts = {};
    for (const p of PRIORITIES) priorityCounts[p] = 0;
    for (const r of byPriority.rows) priorityCounts[r.priority] = r.count;

    res.json({
      total: totals.rows[0].total,
      open: totals.rows[0].open,
      slaBreaches: totals.rows[0].sla_breaches,
      avgDaysToClose: totals.rows[0].avg_days_to_close,
      byStatus: statusCounts,
      byType: typeCounts,
      byPriority: priorityCounts
    });
  } catch (err) {
    next(err);
  }
});

// --- Filterable, paginated case queue --------------------------------------
app.get('/cases', async (req, res, next) => {
  try {
    await maybeSlowdown();

    const where = [];
    const params = [];
    const add = (clause, value) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (req.query.status) add('status = $?', req.query.status);
    if (req.query.type) add('case_type = $?', req.query.type);
    if (req.query.priority) add('priority = $?', req.query.priority);
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const i = params.length;
      where.push(`(citizen_name ILIKE $${i} OR case_number ILIKE $${i})`);
    }
    if (req.query.slaBreached === 'true') {
      where.push("sla_due_date < now() AND status NOT IN ('Approved','Denied','Closed')");
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '25', 10)));
    const offset = (page - 1) * pageSize;

    const countRes = await dbQuery(`SELECT count(*)::int AS total FROM cases ${whereSql}`, params);
    const total = countRes.rows[0].total;

    const listParams = params.slice();
    listParams.push(pageSize, offset);
    const listRes = await dbQuery(
      `SELECT id, case_number, citizen_name, case_type, status, priority,
              assigned_officer, sla_due_date, created_at, updated_at, closed_at,
              (sla_due_date < now() AND status NOT IN ('Approved','Denied','Closed')) AS sla_breached
         FROM cases
         ${whereSql}
         ORDER BY
           CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
           sla_due_date ASC NULLS LAST
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({ items: listRes.rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// --- Single case + notes ---------------------------------------------------
app.get('/cases/:id', async (req, res, next) => {
  try {
    await maybeSlowdown();

    const caseRes = await dbQuery(
      `SELECT id, case_number, citizen_name, case_type, status, priority,
              assigned_officer, sla_due_date, created_at, updated_at, closed_at,
              (sla_due_date < now() AND status NOT IN ('Approved','Denied','Closed')) AS sla_breached
         FROM cases WHERE id = $1`,
      [req.params.id]
    );
    if (caseRes.rowCount === 0) return res.status(404).json({ error: 'Case not found' });

    const notesRes = await dbQuery(
      'SELECT id, author, body, created_at FROM case_notes WHERE case_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    const row = caseRes.rows[0];
    row.notes = notesRes.rows;
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// --- Create a case ---------------------------------------------------------
app.post('/cases', async (req, res, next) => {
  try {
    const { citizenName, caseType, priority } = req.body || {};
    if (!citizenName || !caseType) {
      return res.status(400).json({ error: 'citizenName and caseType are required' });
    }
    if (!CASE_TYPES.includes(caseType)) {
      return res.status(400).json({ error: `caseType must be one of: ${CASE_TYPES.join(', ')}` });
    }
    const prio = PRIORITIES.includes(priority) ? priority : 'Medium';

    // Human-friendly, collision-resistant case number.
    const seq = Date.now().toString().slice(-6);
    const caseNumber = `CSA-2026-9${seq}`;
    const slaDays = prio === 'Urgent' ? 5 : prio === 'High' ? 12 : prio === 'Medium' ? 21 : 30;

    const ins = await dbQuery(
      `INSERT INTO cases
         (case_number, citizen_name, case_type, status, priority, sla_due_date)
       VALUES ($1, $2, $3, 'New', $4, now() + ($5 || ' days')::interval)
       RETURNING id, case_number, citizen_name, case_type, status, priority,
                 assigned_officer, sla_due_date, created_at, updated_at, closed_at`,
      [caseNumber, citizenName, caseType, prio, String(slaDays)]
    );

    await dbQuery(
      'INSERT INTO case_notes (case_id, author, body) VALUES ($1, $2, $3)',
      [ins.rows[0].id, 'Intake System', 'Case created via Citizen Services intake portal.']
    );

    res.status(201).json(ins.rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- Change status (workflow) ----------------------------------------------
app.patch('/cases/:id/status', async (req, res, next) => {
  try {
    const { status, officer } = req.body || {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }
    const closedClause = TERMINAL.includes(status)
      ? 'closed_at = COALESCE(closed_at, now())'
      : 'closed_at = NULL';

    const upd = await dbQuery(
      `UPDATE cases
          SET status = $1,
              assigned_officer = COALESCE($2, assigned_officer),
              updated_at = now(),
              ${closedClause}
        WHERE id = $3
        RETURNING id, case_number, citizen_name, case_type, status, priority,
                  assigned_officer, sla_due_date, created_at, updated_at, closed_at`,
      [status, officer || null, req.params.id]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Case not found' });

    await dbQuery(
      'INSERT INTO case_notes (case_id, author, body) VALUES ($1, $2, $3)',
      [req.params.id, officer || 'Case Officer', `Status changed to "${status}".`]
    );

    res.json(upd.rows[0]);
  } catch (err) {
    next(err);
  }
});

// --- Add a note ------------------------------------------------------------
app.post('/cases/:id/notes', async (req, res, next) => {
  try {
    const { author, body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body is required' });
    const ins = await dbQuery(
      `INSERT INTO case_notes (case_id, author, body)
       VALUES ($1, $2, $3)
       RETURNING id, author, body, created_at`,
      [req.params.id, author || 'Case Officer', body]
    );
    await dbQuery('UPDATE cases SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Scenario controls (write side). The flags read uses the raw pool so it is
// immune to DB_FAILURE_RATE and the operator can always recover.
// ---------------------------------------------------------------------------
app.get('/scenarios', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, enabled, intensity, updated_at FROM scenario_flags ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.put('/scenarios/:name', async (req, res, next) => {
  try {
    const name = req.params.name;
    const { enabled, intensity } = req.body || {};
    const sets = [];
    const params = [];
    if (typeof enabled === 'boolean') {
      params.push(enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if (Number.isFinite(intensity)) {
      params.push(Math.max(0, Math.trunc(intensity)));
      sets.push(`intensity = $${params.length}`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'Provide enabled (boolean) and/or intensity (number)' });
    }
    sets.push('updated_at = now()');
    params.push(name);
    const upd = await pool.query(
      `UPDATE scenario_flags SET ${sets.join(', ')} WHERE name = $${params.length}
       RETURNING name, enabled, intensity, updated_at`,
      params
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: `Unknown scenario: ${name}` });
    flagCache = { at: 0, data: flagCache.data }; // force a fresh read next request
    res.json(upd.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Load generator config (write side).
// ---------------------------------------------------------------------------
app.get('/loadgen', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT running, rps, updated_at FROM loadgen_config WHERE id = 1');
    res.json(rows[0] || { running: false, rps: 0 });
  } catch (err) {
    next(err);
  }
});

app.put('/loadgen', async (req, res, next) => {
  try {
    const { running, rps } = req.body || {};
    const sets = [];
    const params = [];
    if (typeof running === 'boolean') {
      params.push(running);
      sets.push(`running = $${params.length}`);
    }
    if (Number.isFinite(rps)) {
      params.push(Math.min(100, Math.max(0, Math.trunc(rps))));
      sets.push(`rps = $${params.length}`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'Provide running (boolean) and/or rps (number)' });
    }
    sets.push('updated_at = now()');
    const upd = await pool.query(
      `UPDATE loadgen_config SET ${sets.join(', ')} WHERE id = 1
       RETURNING running, rps, updated_at`,
      params
    );
    res.json(upd.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Error handler — surfaces 5xx with a clear message (great for failure-rate
// telemetry) without leaking internals beyond the message.
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[case-service] request failed:', err.message);
  res.status(500).json({ error: 'case-service internal error', detail: err.message });
});

// ---------------------------------------------------------------------------
// Startup — wait for Postgres, then listen.
// ---------------------------------------------------------------------------
async function waitForDb(retries = 30) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[case-service] connected to Postgres');
      return;
    } catch (err) {
      console.log(`[case-service] waiting for Postgres (${i}/${retries}): ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Postgres not reachable after retries');
}

waitForDb()
  .then(() => app.listen(PORT, () => console.log(`[case-service] listening on :${PORT}`)))
  .catch((err) => {
    console.error('[case-service] fatal:', err.message);
    process.exit(1);
  });
