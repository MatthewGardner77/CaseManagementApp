-- ============================================================================
-- Performance migration: reduce Postgres CPU on an existing deployment.
--
-- db/init/ only runs against an empty pgdata volume, so a running stack never
-- picks these up. Apply by hand:
--
--   docker exec -i csa-postgres psql -U casemgmt -d casemgmt \
--     -f /dev/stdin < db/migrations/001_perf_indexes.sql
--
-- Every index here is built CONCURRENTLY, so reads and writes continue during
-- the build. CONCURRENTLY cannot run inside a transaction block; psql is in
-- autocommit by default, so do not wrap this file in BEGIN/COMMIT.
--
-- Expect the builds to take minutes on a large cases table, and to add load
-- while they run. Run them one at a time if the host is already saturated.
-- ============================================================================

-- --- Trigram indexes for the ILIKE search path -------------------------------
-- Without these, `citizen_name ILIKE '%term%' OR case_number ILIKE '%term%'`
-- scans every row, twice. Search is ~10% of the load mix and fires two such
-- queries per request (count + page).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_citizen_name_trgm
    ON cases USING gin (citizen_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_case_number_trgm
    ON cases USING gin (case_number gin_trgm_ops);

-- --- Expression indexes matching the queue sort -------------------------------
-- The listing queries order by a CASE expression over priority. No plain column
-- index can satisfy that, so Postgres sorts the entire matching set before
-- applying LIMIT. These match the ORDER BY exactly, letting it walk the index
-- in order and stop at LIMIT. Browsing the queue is ~30% of the load mix.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_priority_rank_sla
    ON cases (
        (CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END),
        sla_due_date ASC NULLS LAST
    );

-- Same sort prefixed by status, covering the filtered browse path.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cases_status_priority_rank_sla
    ON cases (
        status,
        (CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END),
        sla_due_date ASC NULLS LAST
    );

-- --- Refresh planner statistics ----------------------------------------------
-- New expression indexes need stats before the planner will favour them.
ANALYZE cases;
