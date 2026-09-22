-- ============================================================================
-- One-time backfill: clear the historical New backlog.
--
-- OPTIONAL. The loadgen ageing change fixes the inflow, but an existing
-- deployment can carry a very large New backlog (858k rows, 99.96% New at the
-- time this was written). Left alone that drains at roughly 15k/day, so this
-- statement exists to normalise the distribution immediately.
--
-- Run it REPEATEDLY until it reports UPDATE 0. Each run is a separate
-- transaction touching at most 20k rows, so locks stay short and WAL growth
-- stays bounded. Do not wrap it in a DO loop: that would hold row locks on the
-- entire backlog in a single transaction.
--
--   docker exec -i csa-postgres psql -U casemgmt -d casemgmt \
--     -f /dev/stdin < db/migrations/002_backfill_aged_cases.sql
--
-- Track progress between runs with:
--   SELECT status, count(*) FROM cases GROUP BY status ORDER BY 2 DESC;
--
-- The id % 8 split mirrors the loadgen next-status weighting: 3/8 In Review,
-- 2/8 Pending Info, 1/8 each Approved / Denied / Closed.
-- ============================================================================

UPDATE cases
   SET status = CASE (id % 8)
                  WHEN 0 THEN 'In Review'
                  WHEN 1 THEN 'In Review'
                  WHEN 2 THEN 'In Review'
                  WHEN 3 THEN 'Pending Info'
                  WHEN 4 THEN 'Pending Info'
                  WHEN 5 THEN 'Approved'
                  WHEN 6 THEN 'Denied'
                  ELSE        'Closed'
                END,
       updated_at = now(),
       -- Terminal states need closed_at or avg_days_to_close stays null on the
       -- dashboard. Derive a plausible value from created_at rather than now(),
       -- so the metric reflects the case age spread instead of the backfill run.
       closed_at = CASE
                     WHEN (id % 8) >= 5
                       THEN created_at + (random() * interval '30 days')
                     ELSE closed_at
                   END
 WHERE id IN (
     SELECT id
       FROM cases
      WHERE status = 'New'
        AND created_at < now() - interval '24 hours'
      ORDER BY created_at ASC
      LIMIT 20000
 );

ANALYZE cases;
