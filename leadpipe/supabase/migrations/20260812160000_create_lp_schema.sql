-- LeadPipe schema: context-free lead pipeline
-- Applied to campaignintelligence (azpapwtnrbzywlnxxecz)
-- Data lives here; LLM tools return counts/IDs only.

CREATE SCHEMA IF NOT EXISTS lp;

CREATE TABLE IF NOT EXISTS lp.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag text NOT NULL,
  domain text NOT NULL,
  company_name text,
  source text,
  source_run_id text,
  employee_count integer,
  portfolio_value bigint,
  segment text,
  in_icp boolean DEFAULT false,
  icp_reason text,
  address text,
  city text,
  state text,
  website text,
  phone text,
  place_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_tag, domain)
);

CREATE INDEX IF NOT EXISTS companies_client_tag_idx ON lp.companies (client_tag);
CREATE INDEX IF NOT EXISTS companies_in_icp_idx ON lp.companies (client_tag, in_icp) WHERE in_icp = true;
CREATE INDEX IF NOT EXISTS companies_source_idx ON lp.companies (client_tag, source);

CREATE TABLE IF NOT EXISTS lp.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag text NOT NULL,
  domain text,
  first_name text,
  last_name text,
  job_title text,
  job_level text,
  job_function text,
  email text,
  email_status text,
  email_verified_at timestamptz,
  phone text,
  linkedin_url text,
  source_tool text,
  source_tier text,
  confidence double precision,
  is_dm boolean GENERATED ALWAYS AS (
    CASE
      WHEN job_title IS NULL OR btrim(job_title) = '' THEN false
      WHEN job_title ~* '\m(owner|co-?owner|founder|co-?founder|ceo|chief executive|president|co-?president|principal|partner|managing partner|director|vp|v\.p\.|vice[- ]president|head of|general manager|gm|managing director|proprietor|property manager|asset manager)\M'
        AND job_title !~* '\m(assistant|coordinator|intern|junior|associate to)\M'
      THEN true
      ELSE false
    END
  ) STORED,
  suppressed boolean NOT NULL DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_tag, domain, email)
);

CREATE INDEX IF NOT EXISTS contacts_client_tag_idx ON lp.contacts (client_tag);
CREATE INDEX IF NOT EXISTS contacts_domain_idx ON lp.contacts (client_tag, domain);
CREATE INDEX IF NOT EXISTS contacts_email_idx ON lp.contacts (client_tag, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_dm_idx ON lp.contacts (client_tag, is_dm) WHERE is_dm = true;
CREATE INDEX IF NOT EXISTS contacts_suppressed_idx ON lp.contacts (client_tag, suppressed) WHERE suppressed = true;
CREATE INDEX IF NOT EXISTS contacts_source_tier_idx ON lp.contacts (client_tag, source_tier);
CREATE INDEX IF NOT EXISTS contacts_no_email_idx ON lp.contacts (client_tag) WHERE email IS NULL OR email = '';

CREATE TABLE IF NOT EXISTS lp.raw_payloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  vendor text NOT NULL,
  entity_key text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raw_payloads_job_idx ON lp.raw_payloads (job_id);
CREATE INDEX IF NOT EXISTS raw_payloads_vendor_entity_idx ON lp.raw_payloads (vendor, entity_key);
CREATE INDEX IF NOT EXISTS raw_payloads_fetched_idx ON lp.raw_payloads (fetched_at DESC);

CREATE TABLE IF NOT EXISTS lp.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag text NOT NULL,
  kind text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  params_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','interrupted','cost_blocked')),
  rows_total integer NOT NULL DEFAULT 0,
  rows_done integer NOT NULL DEFAULT 0,
  rows_failed integer NOT NULL DEFAULT 0,
  results_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_estimate_usd numeric(12,4),
  cost_actual_usd numeric(12,4) DEFAULT 0,
  credits_used numeric(12,4) DEFAULT 0,
  cost_ceiling_usd numeric(12,4),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_client_status_idx ON lp.jobs (client_tag, status);
CREATE INDEX IF NOT EXISTS jobs_kind_idx ON lp.jobs (kind);
CREATE INDEX IF NOT EXISTS jobs_params_hash_idx ON lp.jobs (client_tag, kind, params_hash);
CREATE INDEX IF NOT EXISTS jobs_heartbeat_idx ON lp.jobs (status, heartbeat_at) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS lp.job_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES lp.jobs(id) ON DELETE CASCADE,
  entity_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  result_summary jsonb DEFAULT '{}'::jsonb,
  cost_usd numeric(12,4) DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, entity_key)
);

CREATE INDEX IF NOT EXISTS job_rows_pending_idx ON lp.job_rows (job_id, status) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS job_rows_job_idx ON lp.job_rows (job_id);

ALTER TABLE lp.raw_payloads
  ADD CONSTRAINT raw_payloads_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES lp.jobs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS lp.exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag text NOT NULL,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  format text NOT NULL DEFAULT 'csv',
  row_count integer NOT NULL DEFAULT 0,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS exports_client_idx ON lp.exports (client_tag, created_at DESC);

CREATE OR REPLACE FUNCTION lp.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_set_updated_at ON lp.companies;
CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON lp.companies
  FOR EACH ROW EXECUTE FUNCTION lp.set_updated_at();

DROP TRIGGER IF EXISTS contacts_set_updated_at ON lp.contacts;
CREATE TRIGGER contacts_set_updated_at
  BEFORE UPDATE ON lp.contacts
  FOR EACH ROW EXECUTE FUNCTION lp.set_updated_at();

DROP TRIGGER IF EXISTS job_rows_set_updated_at ON lp.job_rows;
CREATE TRIGGER job_rows_set_updated_at
  BEFORE UPDATE ON lp.job_rows
  FOR EACH ROW EXECUTE FUNCTION lp.set_updated_at();

CREATE OR REPLACE VIEW lp.inventory_counts
WITH (security_invoker = true)
AS
SELECT
  c.client_tag,
  (SELECT count(*) FROM lp.companies co WHERE co.client_tag = c.client_tag) AS companies,
  count(*) AS contacts,
  count(*) FILTER (WHERE c.email IS NOT NULL AND c.email <> '') AS with_email,
  count(*) FILTER (WHERE c.is_dm) AS dm_grade,
  count(*) FILTER (WHERE c.suppressed) AS suppressed,
  count(*) FILTER (WHERE c.email IS NULL OR c.email = '') AS missing_email
FROM lp.contacts c
GROUP BY c.client_tag;

ALTER TABLE lp.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp.raw_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp.job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp.exports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA lp FROM PUBLIC;
GRANT USAGE ON SCHEMA lp TO postgres, service_role, authenticator;
GRANT ALL ON ALL TABLES IN SCHEMA lp TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA lp TO postgres, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lp TO postgres, service_role;

-- Dashboard: Settings → API → Exposed schemas → add `lp`
NOTIFY pgrst, 'reload schema';
