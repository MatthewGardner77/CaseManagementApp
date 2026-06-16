-- ============================================================================
-- Seed ~300 realistic cases spread across types, statuses, priorities and
-- dates (last ~200 days). A meaningful slice of open cases is past its SLA
-- so the dashboard shows real breaches, and terminal cases have a closed_at
-- so "avg time to close" is meaningful.
-- ============================================================================

WITH base AS (
    SELECT
        gs                                            AS n,
        now() - (random() * 200) * interval '1 day'   AS created_at,
        random() AS r_status,
        random() AS r_type,
        random() AS r_priority,
        random() AS r_officer,
        random() AS r_close,
        random() AS r_fn,
        random() AS r_ln
    FROM generate_series(1, 300) AS gs
),
typed AS (
    SELECT
        b.*,
        (ARRAY['Benefits Claim','FOIA Request','Permit Application','Appeal'])[1 + floor(r_type * 4)::int]      AS case_type,
        (ARRAY['Low','Medium','High','Urgent'])[1 + floor(r_priority * 4)::int]                                 AS priority,
        CASE
            WHEN b.r_status < 0.15 THEN 'New'
            WHEN b.r_status < 0.42 THEN 'In Review'
            WHEN b.r_status < 0.57 THEN 'Pending Info'
            WHEN b.r_status < 0.72 THEN 'Approved'
            WHEN b.r_status < 0.82 THEN 'Denied'
            ELSE 'Closed'
        END AS status
    FROM base b
),
finalized AS (
    SELECT
        t.*,
        -- SLA window shrinks with priority; older open cases naturally breach.
        t.created_at + (CASE t.priority
                            WHEN 'Urgent' THEN 5
                            WHEN 'High'   THEN 12
                            WHEN 'Medium' THEN 21
                            ELSE 30
                        END) * interval '1 day' AS sla_due_date,
        -- Terminal cases close somewhere between creation and now.
        CASE WHEN t.status IN ('Approved','Denied','Closed')
             THEN t.created_at + t.r_close * (now() - t.created_at)
             ELSE NULL
        END AS closed_at
    FROM typed t
)
INSERT INTO cases
    (case_number, citizen_name, case_type, status, priority,
     assigned_officer, sla_due_date, created_at, updated_at, closed_at)
SELECT
    'CSA-2026-' || lpad(n::text, 6, '0'),
    (ARRAY['James','Maria','Robert','Linda','David','Patricia','Michael','Jennifer',
           'William','Elizabeth','Carlos','Aisha','John','Susan','Wei','Fatima',
           'Daniel','Nancy','Joseph','Karen'])[1 + floor(r_fn * 20)::int]
        || ' ' ||
    (ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
           'Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson',
           'Nguyen','Patel','Kim','Okafor','Thompson'])[1 + floor(r_ln * 20)::int]
        AS citizen_name,
    case_type,
    status,
    priority,
    CASE WHEN status = 'New' THEN NULL
         ELSE (ARRAY['Officer J. Martinez','Officer P. Reynolds','Officer S. Okafor',
                     'Officer L. Chen','Officer R. Donnelly','Officer A. Whitfield',
                     'Officer M. Delgado','Officer T. Brooks','Officer K. Iverson',
                     'Officer D. Abrams','Officer N. Caldwell','Officer G. Petrova'])[1 + floor(r_officer * 12)::int]
    END AS assigned_officer,
    sla_due_date,
    created_at,
    COALESCE(closed_at, created_at) AS updated_at,
    closed_at
FROM finalized;

-- An intake note on every case that has moved past "New".
INSERT INTO case_notes (case_id, author, body, created_at)
SELECT
    c.id,
    COALESCE(c.assigned_officer, 'Intake System'),
    (ARRAY[
        'Case received and validated. Routed to review queue.',
        'Identity and supporting documents confirmed.',
        'Initial eligibility screening complete.',
        'Assigned for adjudication per intake policy.',
        'Attachments processed; no anomalies detected.'
    ])[1 + floor(random() * 5)::int],
    c.created_at + interval '6 hours'
FROM cases c
WHERE c.status <> 'New';

-- A follow-up note explaining the outcome on terminal cases.
INSERT INTO case_notes (case_id, author, body, created_at)
SELECT
    c.id,
    COALESCE(c.assigned_officer, 'Adjudication System'),
    CASE c.status
        WHEN 'Approved' THEN 'Determination: APPROVED. Notice of decision issued to applicant.'
        WHEN 'Denied'   THEN 'Determination: DENIED. Applicant advised of appeal rights.'
        ELSE 'Case closed. No further action required.'
    END,
    c.closed_at
FROM cases c
WHERE c.status IN ('Approved','Denied','Closed') AND c.closed_at IS NOT NULL;

-- A "waiting on applicant" note for Pending Info cases.
INSERT INTO case_notes (case_id, author, body, created_at)
SELECT
    c.id,
    c.assigned_officer,
    'Additional information requested from applicant. Awaiting response before adjudication.',
    c.created_at + interval '3 days'
FROM cases c
WHERE c.status = 'Pending Info';
