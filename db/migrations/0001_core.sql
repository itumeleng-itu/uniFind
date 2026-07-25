-- Core domain tables: institutions, programmes, bursaries, students, and the
-- payment/report pipeline that turns a match into a paid report page.
--
-- pgcrypto is used for gen_random_bytes() when minting unguessable report
-- tokens; UUID primary keys use gen_random_uuid(), which is core to
-- Postgres 13+ and needs no extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE institutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    homepage_url text NOT NULL,
    prospectus_url text,
    application_deadline date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE programmes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    faculty text NOT NULL,
    name text NOT NULL,
    qualification text NOT NULL,
    points_requirement integer NOT NULL,
    -- Only 'verified' rows may ground a paid report. 'pending' and
    -- 'withdrawn' exist so course-sync can stage or retire a row without a
    -- human racing to delete it first.
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'withdrawn')),
    source_url text,
    last_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX programmes_institution_id_idx ON programmes(institution_id);
CREATE INDEX programmes_status_idx ON programmes(status);

CREATE TABLE programme_subject_requirements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_id uuid NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
    subject text NOT NULL,
    -- NSC achievement level, 1-7 (Level 4 = 50-59%).
    min_level integer NOT NULL CHECK (min_level BETWEEN 1 AND 7),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX programme_subject_requirements_programme_id_idx
    ON programme_subject_requirements(programme_id);

CREATE TABLE bursaries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    provider text NOT NULL,
    url text NOT NULL,
    eligibility_criteria text,
    amount text,
    closing_date date,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'expired', 'withdrawn')),
    last_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bursaries_status_idx ON bursaries(status);

CREATE TABLE students (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- No citext (Supabase/Cloud SQL don't enable it by default) -- lowercase
    -- at write time instead.
    email text NOT NULL,
    name text NOT NULL,
    subjects jsonb NOT NULL DEFAULT '{}'::jsonb,
    aps_score integer,
    interests text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX students_email_idx ON students(email);

CREATE TABLE match_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX match_runs_student_id_idx ON match_runs(student_id);

CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_run_id uuid NOT NULL REFERENCES match_runs(id),
    provider text NOT NULL,
    reference text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    amount_cents integer NOT NULL,
    currency text NOT NULL DEFAULT 'ZAR',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- The same (provider, reference) can be delivered by Paystack's webhook
    -- any number of times; this is what makes "on conflict do nothing" a
    -- correct idempotency strategy in the webhook handler. Never drop this.
    UNIQUE (provider, reference)
);

CREATE TABLE reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id uuid NOT NULL REFERENCES payments(id),
    match_run_id uuid NOT NULL REFERENCES match_runs(id),
    -- Unguessable token for the public /r/[token] page; gen_random_bytes
    -- comes from pgcrypto.
    token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
    content text,
    model_name text,
    prompt_tokens integer,
    completion_tokens integer,
    input_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    -- A payment can only ever produce one report row; this is the second
    -- half of webhook idempotency alongside payments' unique (provider,
    -- reference). Never drop this.
    UNIQUE (payment_id)
);

CREATE UNIQUE INDEX reports_token_idx ON reports(token);

CREATE TABLE cost_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Nullable: agents call Gemini too, outside of any single report.
    report_id uuid REFERENCES reports(id),
    source text NOT NULL,
    model_name text NOT NULL,
    prompt_tokens integer NOT NULL,
    completion_tokens integer NOT NULL,
    cost_usd numeric(10, 6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cost_events_report_id_idx ON cost_events(report_id);
CREATE INDEX cost_events_created_at_idx ON cost_events(created_at);
