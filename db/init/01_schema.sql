-- ============================================================================
-- Citizen Services Case Management System — database schema
-- Runs automatically on first container init (Postgres /docker-entrypoint-initdb.d).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Core domain: cases + notes
-- ----------------------------------------------------------------------------
CREATE TABLE cases (
    id               SERIAL PRIMARY KEY,
    case_number      TEXT        NOT NULL UNIQUE,
    citizen_name     TEXT        NOT NULL,
    case_type        TEXT        NOT NULL,   -- Benefits Claim | FOIA Request | Permit Application | Appeal
    status           TEXT        NOT NULL,   -- New | In Review | Pending Info | Approved | Denied | Closed
    priority         TEXT        NOT NULL,   -- Low | Medium | High | Urgent
    assigned_officer TEXT,                   -- NULL while unassigned (e.g. brand-new cases)
    sla_due_date     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at        TIMESTAMPTZ             -- set when status is a terminal state
);

CREATE INDEX idx_cases_status   ON cases (status);
CREATE INDEX idx_cases_type     ON cases (case_type);
CREATE INDEX idx_cases_priority ON cases (priority);
CREATE INDEX idx_cases_sla      ON cases (sla_due_date);
CREATE INDEX idx_cases_created  ON cases (created_at);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_cases_citizen_name_trgm ON cases USING gin (citizen_name gin_trgm_ops);
CREATE INDEX idx_cases_case_number_trgm  ON cases USING gin (case_number  gin_trgm_ops);

-- Expression indexes matching the queue's ORDER BY exactly. Without these,
-- every /cases listing sorts the entire matching set before applying LIMIT,
-- because no plain column index can satisfy the CASE expression. With them
-- Postgres walks the index in order and stops at LIMIT.
CREATE INDEX idx_cases_priority_rank_sla ON cases (
    (CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END),
    sla_due_date ASC NULLS LAST
);

-- Same sort, prefixed by status: covers the filtered queue, which is the most
-- common browse path (~60% of listing requests carry a status filter).
CREATE INDEX idx_cases_status_priority_rank_sla ON cases (
    status,
    (CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END),
    sla_due_date ASC NULLS LAST
);

CREATE TABLE case_notes (
    id         SERIAL PRIMARY KEY,
    case_id    INTEGER     NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    author     TEXT        NOT NULL,
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_case ON case_notes (case_id);

-- ----------------------------------------------------------------------------
-- Scenario engine: shared flags table read by every service on each request.
-- enabled  = scenario on/off (sustained until toggled off)
-- intensity = scenario-specific knob:
--   HIGH_CPU          -> busy-loop duration in ms per request (document-service)
--   DB_FAILURE_RATE   -> percentage of Postgres queries forced to fail (case-service)
--   BACKEND_SLOWDOWN  -> injected latency in ms per request (case-service)
-- ----------------------------------------------------------------------------
CREATE TABLE scenario_flags (
    name       TEXT        PRIMARY KEY,
    enabled    BOOLEAN     NOT NULL DEFAULT false,
    intensity  INTEGER     NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO scenario_flags (name, enabled, intensity) VALUES
    ('HIGH_CPU',         false, 250),   -- 250 ms of CPU burn per document-service request
    ('DB_FAILURE_RATE',  false, 30),    -- 30% of case-service queries fail
    ('BACKEND_SLOWDOWN', false, 900);   -- 900 ms injected into case-service responses

-- ----------------------------------------------------------------------------
-- Load generator config: single-row table the loadgen container polls.
-- The /control panel writes here (via case-service) to start/stop traffic
-- and change the request rate without restarting anything.
-- ----------------------------------------------------------------------------
CREATE TABLE loadgen_config (
    id         INTEGER     PRIMARY KEY DEFAULT 1,
    running    BOOLEAN     NOT NULL DEFAULT true,
    rps        INTEGER     NOT NULL DEFAULT 3,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT loadgen_config_single_row CHECK (id = 1)
);

INSERT INTO loadgen_config (id, running, rps) VALUES (1, true, 3);
