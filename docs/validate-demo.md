# 5 · Validate & run the demo

Confirm Dynatrace sees everything, establish a baseline, then trigger a problem.

## 5.1 Confirm the host, services & database

In Dynatrace, after a few minutes of traffic:

- **Hosts** → your EC2 instance is listed with live CPU, memory, disk and
  network, and a **Docker** section showing the running containers.
- **Services** → you should find three Node.js services —
  **gateway**, **case-service**, **document-service** — plus a **PostgreSQL**
  database service. (OneAgent auto-names services; if names differ, match them by
  the listening ports 8080 / 3001 / 3002 and the `postgres` technology.)
- **Technologies / Processes** → Node.js and PostgreSQL process groups, one per
  container.

!!! note "Give it a few minutes"
    Entities and traces appear shortly after the restarted containers take
    traffic. If you don't see services yet, confirm `loadgen` is running (next
    section) and wait 2–3 minutes.

## 5.2 Confirm the service map

Open **Service flow** (or **Smartscape**) from the `gateway` service. You should
see the dependency chain:

```
gateway  →  case-service   →  PostgreSQL
gateway  →  document-service
```

Open a **distributed trace** from the gateway and confirm a request flows
`gateway → case-service → postgres`, with the SQL statements captured on the
Postgres calls. This is the path Davis will reason over.

## 5.3 Confirm the load generator (baseline traffic)

`loadgen` starts automatically and drives realistic flows (browse queue, open
case, dashboard, search, create case, change status) at a default **6 req/s**.

- From the host: `docker compose logs --tail=20 loadgen`
- From the control page (`http://<EC2_PUBLIC_IP>:8080/control`): the **Load
  generator** panel shows *Traffic on* and the current rate.

You can change the rate or pause it from that panel, or via curl:

```bash
# 10 requests/second
curl -X PUT http://<EC2_PUBLIC_IP>:8080/api/loadgen \
  -H 'Content-Type: application/json' -d '{"running":true,"rps":10}'
```

## 5.4 Let a baseline form — then trigger a problem

!!! warning "Davis needs a baseline and sustained load"
    Leave the app running with **active baseline traffic for ~15–20 minutes
    before** flipping a scenario, and keep the scenario **on for ~15–20 minutes**
    once you do. Davis establishes normal behavior first; a quick on/off flip
    rarely produces enough signal to open a problem.

### Trigger from the control page

Go to `http://<EC2_PUBLIC_IP>:8080/control` and, for the headline root-cause
demo, toggle **BACKEND_SLOWDOWN** on and set the intensity slider to **~900–1500
ms**. The "currently active" banner confirms it.

### Or trigger via curl

The same controls are a REST API on the gateway. The scenario names are
`HIGH_CPU`, `DB_FAILURE_RATE`, and `BACKEND_SLOWDOWN`.

```bash
# Headline RCA: inject 1200 ms of latency in case-service
curl -X PUT http://<EC2_PUBLIC_IP>:8080/api/scenarios/BACKEND_SLOWDOWN \
  -H 'Content-Type: application/json' -d '{"enabled":true,"intensity":1200}'

# Fail 40% of case-service database queries
curl -X PUT http://<EC2_PUBLIC_IP>:8080/api/scenarios/DB_FAILURE_RATE \
  -H 'Content-Type: application/json' -d '{"enabled":true,"intensity":40}'

# Burn CPU in document-service: 400 ms busy-loop per request
curl -X PUT http://<EC2_PUBLIC_IP>:8080/api/scenarios/HIGH_CPU \
  -H 'Content-Type: application/json' -d '{"enabled":true,"intensity":400}'

# Read current scenario state
curl http://<EC2_PUBLIC_IP>:8080/api/scenarios
```

### What each scenario demonstrates

| Scenario | Lives in | Symptom you'll see | Root cause Davis should find |
| --- | --- | --- | --- |
| **BACKEND_SLOWDOWN** ⭐ | case-service | Slow frontend & gateway response time | Latency injected in `case-service` (gateway is just waiting) |
| **DB_FAILURE_RATE** | case-service | Spiking failure rate on case endpoints, propagated to the gateway/frontend | Failing PostgreSQL queries in `case-service` |
| **HIGH_CPU** | document-service | CPU saturation + slow `document-service` responses | CPU-bound work in `document-service` |

### Turn the scenario back off

```bash
curl -X PUT http://<EC2_PUBLIC_IP>:8080/api/scenarios/BACKEND_SLOWDOWN \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

…or flip the toggle off on the control page. Let the app recover before the next
scenario.

!!! success "You're demo-ready"
    You can now walk an audience from a frontend/RUM symptom, through the service
    flow, down to the Davis-identified root-cause service.

Next: [**Day-to-day operations →**](operations.md)
