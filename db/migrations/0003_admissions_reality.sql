-- Not every institution scores admission the same way -- UCT, Stellenbosch,
-- and Rhodes each run their own composite in place of the standard APS, and
-- some faculties (e.g. medicine) close earlier than the rest of the
-- institution. This migration makes both facts queryable instead of leaving
-- them for the prompt to get right.
ALTER TABLE institutions
    ADD COLUMN scoring_system text NOT NULL DEFAULT 'aps'
        CHECK (scoring_system IN (
            'aps', 'uct_fps', 'stellenbosch', 'rhodes', 'nbt_composite', 'open'
        ));

CREATE TABLE faculty_deadlines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    faculty text NOT NULL,
    deadline date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (institution_id, faculty)
);

-- The single source of truth for "is this programme still open". A faculty
-- deadline overrides the institution-wide one when both exist; a programme
-- with neither is treated as open. Filtering happens here, in SQL, so a
-- prompt instruction is never the only thing standing between a closed
-- programme and a paying customer.
CREATE VIEW open_programmes AS
SELECT
    p.*,
    i.scoring_system,
    coalesce(fd.deadline, i.application_deadline) AS effective_deadline
FROM programmes p
JOIN institutions i ON i.id = p.institution_id
LEFT JOIN faculty_deadlines fd
    ON fd.institution_id = p.institution_id AND fd.faculty = p.faculty
WHERE coalesce(fd.deadline, i.application_deadline) IS NULL
   OR coalesce(fd.deadline, i.application_deadline) >= current_date;
