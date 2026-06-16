# Citizen Services Case Management System

A multi-service demo application for showcasing **Dynatrace** in front of U.S.
federal/public-sector audiences. It looks and behaves like a real citizen
case-management system, emits full-stack telemetry (distributed traces, SQL,
errors, CPU), runs continuous baseline traffic, and lets you flip **sustained
failure scenarios** on demand to demonstrate **Davis AI** root-cause analysis
across a service dependency chain.

It is modeled on the structure of Dynatrace's **EasyTrade** demo, adapted to a
federal case-management domain and split into separate containers so Dynatrace
builds a real **service map** and Davis can root-cause across services.

> The **U.S. Citizen Services Administration (CSA)** is a fictional agency used
> for observability demos. No real agency, seal, or system is represented.

---

## Quick start

Put **OneAgent** (full-stack) on the Docker host first — it auto-instruments
every container below plus Postgres. Then:

```bash
docker compose up --build
```

| Surface | URL |
| --- | --- |
| Citizen application | http://localhost:8080 |
| Operator control console | http://localhost:8080/control |
| case-service (debug) | http://localhost:3001/health |
| document-service (debug) | http://localhost:3002/health |
| Postgres | localhost:5432 (`casemgmt` / `casemgmt`) |

The load generator starts automatically and a baseline forms within a minute or
two. **Leave it running 5–10 minutes before flipping a scenario** so Dynatrace
has a baseline to compare against.

---

## Architecture

```
                 browser (RUM)
                      │  fetch/XHR
                      ▼
              ┌───────────────┐
              │    gateway    │  Node/Express · BFF + static frontend
              │  (no database)│  port 8080
              └───────┬───────┘
            ┌─────────┴───────────┐
            ▼                     ▼
   ┌────────────────┐    ┌──────────────────┐
   │  case-service  │    │ document-service │  Node/Express
   │  port 3001     │    │  port 3002       │  CPU-bound work
   └───────┬────────┘    └─────────┬────────┘
           │ SQL (pg)              │ reads scenario flags
           ▼                       ▼
      ┌─────────────────────────────────┐
      │            postgres             │  cases, notes, scenario_flags,
      │            port 5432            │  loadgen_config
      └─────────────────────────────────┘
           ▲
           │ polls loadgen_config + drives traffic at gateway
   ┌───────┴────────┐
   │    loadgen     │  Node · continuous baseline traffic
   └────────────────┘
```

**Trace flow:** a browser action calls the gateway, which fans out over HTTP to
`case-service` and/or `document-service`; `case-service` queries Postgres. With
OneAgent on the host this is a single distributed trace spanning
`browser → gateway → case-service → postgres` (and `→ document-service`), so
Davis can attribute a frontend symptom to the true downstream root cause.

---

## Services

### gateway — Node.js / Express (`:8080`)
Serves the citizen frontend (static HTML/CSS/JS) and is a **backend-for-frontend**.
Every UI API call lands here; it calls `case-service` and (for create/detail
flows) `document-service`, then returns. **It holds no database connection and
injects no failures of its own** — all frontend-perceived latency and errors are
*inherited* from downstream. That is the point: the frontend looks broken while
the root cause is a service two hops away.

- **Telemetry:** inbound `/api/*` service + endpoints, outbound HTTP calls to
  the two downstream services, propagated trace context, request logs.

### case-service — Node.js / Express (`:3001`)
Owns the **case-domain Postgres queries**: case CRUD, filtered/paginated search,
dashboard aggregations, notes, and the write side of the scenario/loadgen
controls. Hosts the **DB_FAILURE_RATE** and **BACKEND_SLOWDOWN** scenarios.

- **Telemetry:** Express endpoints, `pg` database calls and statements, SQL
  errors (during DB_FAILURE_RATE), elevated response time (during
  BACKEND_SLOWDOWN).

### document-service — Node.js / Express (`:3002`)
Simulates document intake/processing for a case (validating an uploaded
attachment, listing processed documents). Called by the gateway during case
**creation** (validate) and case **detail** (list). **The CPU-bound work lives
here.** Hosts the **HIGH_CPU** scenario.

- **Telemetry:** Express endpoints, process CPU (spikes during HIGH_CPU),
  elevated response time on `/documents/*`.

### postgres — PostgreSQL 16 (`:5432`)
Real database. Schema and a ~300-case seed run automatically on first start from
`db/init/`. Auto-instrumented by OneAgent as a database service.

### loadgen — Node.js
Runs continuously from startup, exercising realistic case-worker flows against
the gateway (browse queue, open case, dashboard, search, create case, change
status, add note) at a configurable rate. Reads its `running`/`rps` config from
the `loadgen_config` table every 2s, so the `/control` panel can pause it or
change the rate live without a restart. Requests are fired without awaiting each
other (capped) so the offered request **rate** stays steady even when a slowdown
scenario makes responses slow.

---

## Domain model (Postgres)

**`cases`** — `case_number`, `citizen_name`, `case_type`
(*Benefits Claim, FOIA Request, Permit Application, Appeal*), `status`
(*New, In Review, Pending Info, Approved, Denied, Closed*), `priority`
(*Low, Medium, High, Urgent*), `assigned_officer`, `sla_due_date`,
`created_at`, `updated_at`, `closed_at`.

**`case_notes`** — per-case workflow/audit notes.

**`scenario_flags`** — the shared scenario engine table (`name`, `enabled`,
`intensity`).

**`loadgen_config`** — single-row load-generator control (`running`, `rps`).

The seed creates **~300 cases** spread across all types, statuses, priorities,
and the last ~200 days, with a realistic slice of **open cases past their SLA**
and terminal cases that have a `closed_at` (so "avg time to close" is real).

---

## Problem-scenario engine

A shared **`scenario_flags`** table in Postgres drives the engine. Every service
that can self-degrade reads the active flags on each request (with a 2-second
cache so the read doesn't dominate telemetry) and degrades accordingly.
Scenarios are **sustained** — they stay on until you turn them off — and each has
an **intensity** knob.

| Scenario | Lives in | What it does | Intensity | Telemetry produced |
| --- | --- | --- | --- | --- |
| **HIGH_CPU** | document-service | Runs a CPU-bound busy loop on every request | busy-loop duration (ms) | Process CPU spike on document-service; higher `/documents/*` response time |
| **DB_FAILURE_RATE** | case-service | Forces a % of Postgres queries to fail against a non-existent table | error rate (%) | Real DB errors + elevated failure rate on case endpoints, propagated to the gateway and frontend |
| **BACKEND_SLOWDOWN** ⭐ | case-service | Injects latency into case responses; the gateway awaits it | injected latency (ms) | Slow gateway/frontend whose root cause is a downstream service — **the headline RCA scenario** |

⭐ **Headline RCA:** with BACKEND_SLOWDOWN on, the browser and gateway look slow,
but Davis traces the latency through the dependency chain to `case-service` as
the real culprit.

### Operate from `/control`
The operator console at **http://localhost:8080/control** (intentionally **not**
linked from the citizen UI) has:
- a toggle + intensity slider per scenario,
- a live "currently active" indicator (polls every 3s, so it reflects changes
  made from curl too),
- a load-generator panel (start/stop + requests-per-second).

### Operate from curl
The same controls are a REST API on the gateway:

```bash
# Headline RCA: inject 1200 ms of latency in case-service
curl -X PUT http://localhost:8080/api/scenarios/BACKEND_SLOWDOWN \
  -H 'Content-Type: application/json' -d '{"enabled":true,"intensity":1200}'

# Fail 40% of case-service DB queries
curl -X PUT http://localhost:8080/api/scenarios/DB_FAILURE_RATE \
  -H 'Content-Type: application/json' -d '{"enabled":true,"intensity":40}'

# Burn CPU in document-service: 400 ms busy-loop per request
curl -X PUT http://localhost:8080/api/scenarios/HIGH_CPU \
  -H 'Content-Type: application/json' -d '{"enabled":true,"intensity":400}'

# Turn a scenario back off
curl -X PUT http://localhost:8080/api/scenarios/BACKEND_SLOWDOWN \
  -H 'Content-Type: application/json' -d '{"enabled":false}'

# Control the load generator
curl -X PUT http://localhost:8080/api/loadgen \
  -H 'Content-Type: application/json' -d '{"running":true,"rps":10}'

# Read current state
curl http://localhost:8080/api/scenarios
curl http://localhost:8080/api/loadgen
```

---

## Demo runbook

1. `docker compose up --build`. Confirm the citizen app loads at :8080 and the
   loadgen container logs traffic.
2. **Let the baseline run ~5–10 minutes** (longer is better) so Dynatrace learns
   normal behavior. Davis will not raise a problem without an established
   baseline and active traffic.
3. From `/control` (or curl), flip **BACKEND_SLOWDOWN** to ~900–1500 ms.
4. Leave it on **~15–20 minutes**. Watch the gateway/frontend response time
   climb in Dynatrace while the load generator keeps pressure on.
5. Open the Davis problem and walk the root cause from the slow frontend symptom
   down to `case-service`.
6. Turn the scenario **off** and let it recover. Repeat with DB_FAILURE_RATE
   (failure-rate story) or HIGH_CPU (CPU saturation story) as needed.

> Scenarios are most convincing with sustained traffic and a 15–20 minute run.
> A quick on/off flip may not generate enough signal for Davis to open a problem.

---

## Real User Monitoring (RUM)

To correlate browser user actions with backend traces, paste your Dynatrace RUM
JavaScript agent snippet into the **commented placeholder in the `<head>`** of
`gateway/public/index.html`:

```html
<!-- <script type="text/javascript" src="PASTE_YOUR_RUM_JS_AGENT_URL"></script> -->
```

The frontend makes real `fetch` calls to the gateway for every action (load
dashboard, filter queue, open case, change status, create case), so RUM user
actions line up with the distributed traces they trigger.

---

## OneAgent notes

- All services use a **glibc** base image (`node:20-slim`) for the broadest
  OneAgent Node.js auto-instrumentation compatibility.
- Put OneAgent on the **host**; it discovers and instruments the containers and
  Postgres automatically — no code changes or in-image agent required.
- Service names in Dynatrace are auto-detected. The container names
  (`csa-gateway`, `csa-case-service`, `csa-document-service`, `csa-postgres`,
  `csa-loadgen`) make them easy to find in the entity list and service map.

---

## Reset / teardown

```bash
docker compose down          # stop, keep the seeded data
docker compose down -v       # stop AND wipe the database (re-seeds on next up)
```

The schema/seed in `db/init/` only run when the Postgres volume is empty, so use
`down -v` to get a fresh 300-case dataset.

---

## Design / implementation notes

- **`case-service` owns all case-domain SQL.** Per the scenario-engine
  requirement, the services that self-degrade also each read the shared
  `scenario_flags` table directly (a tiny, cached query) so the engine is
  decentralized and a DB-failure scenario in one service can't stop another from
  reading flags. This also gives every degrading service a visible Postgres
  dependency in the service map.
- **The gateway deliberately has no database and no failure injection** — it only
  awaits downstream, which is what makes the cross-service root-cause story
  clean.
- **Accessibility:** the citizen UI targets WCAG 2.1 AA / Section 508 — semantic
  landmarks, ARIA, full keyboard navigation, visible focus, a native accessible
  dialog, live regions for status/toasts, and AA-contrast USWDS color tokens.
- Default credentials and the operator console are unauthenticated **for demo
  convenience**; do not expose this app on an untrusted network.
```
