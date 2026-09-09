-- Bug fixes 2026-09-09:
-- 1) Add city to every lp.*_ingested_leads table + ensure function
-- 2) lp_table_columns RPC so export can read live column lists

-- Backfill city onto every existing ingested_leads table
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'lp'
      AND c.relkind = 'r'
      AND c.relname ~ '^[a-z][a-z0-9_]*_ingested_leads$'
  LOOP
    EXECUTE format(
      'ALTER TABLE lp.%I ADD COLUMN IF NOT EXISTS city text',
      r.tablename
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION lp.ensure_ingested_leads_table(
  p_client_tag text,
  p_dedupe_key text DEFAULT 'email'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = lp, public
AS $$
DECLARE
  safe text;
  tname text;
  dedupe text;
BEGIN
  safe := lower(regexp_replace(coalesce(p_client_tag, ''), '[^a-z0-9_]', '', 'g'));
  IF safe IS NULL OR safe = '' OR safe !~ '^[a-z]' THEN
    RAISE EXCEPTION 'invalid client_tag for ingested_leads: %', p_client_tag;
  END IF;
  tname := safe || '_ingested_leads';
  dedupe := lower(coalesce(p_dedupe_key, 'email'));
  IF dedupe NOT IN ('email', 'company_domain') THEN
    RAISE EXCEPTION 'dedupe_key must be email or company_domain';
  END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS lp.%I (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name text,
      last_name text,
      email text,
      title text,
      company_name text,
      company_domain text,
      city text,
      state text,
      industry text,
      employee_range text,
      source_label text NOT NULL,
      source_url_hash text,
      content_hash text,
      ingested_at timestamptz NOT NULL DEFAULT now()
    )
  $f$, tname);

  -- Existing tables created before city existed
  EXECUTE format(
    'ALTER TABLE lp.%I ADD COLUMN IF NOT EXISTS city text',
    tname
  );

  -- Full unique indexes (NULL distinct in PG) so PostgREST onConflict works.
  IF dedupe = 'email' THEN
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON lp.%I (email)',
      tname || '_email_uidx',
      tname
    );
  ELSE
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON lp.%I (company_domain)',
      tname || '_domain_uidx',
      tname
    );
  END IF;

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON lp.%I (source_label)',
    tname || '_source_label_idx',
    tname
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON lp.%I (company_domain)',
    tname || '_domain_idx',
    tname
  );

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON lp.%I TO service_role', tname);
  PERFORM pg_notify('pgrst', 'reload schema');

  RETURN tname;
END;
$$;

GRANT EXECUTE ON FUNCTION lp.ensure_ingested_leads_table(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.lp_ensure_ingested_leads_table(
  p_client_tag text,
  p_dedupe_key text DEFAULT 'email'
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT lp.ensure_ingested_leads_table(p_client_tag, p_dedupe_key);
$$;

REVOKE ALL ON FUNCTION public.lp_ensure_ingested_leads_table(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_ensure_ingested_leads_table(text, text) TO service_role;

-- Live column list for lp_export (no hardcoded selects)
CREATE OR REPLACE FUNCTION lp.table_columns(
  p_schema text,
  p_table text
)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = lp, public, information_schema
AS $$
DECLARE
  sch text;
  tbl text;
  cols text[];
BEGIN
  sch := lower(regexp_replace(coalesce(p_schema, ''), '[^a-z0-9_]', '', 'g'));
  tbl := lower(regexp_replace(coalesce(p_table, ''), '[^a-z0-9_]', '', 'g'));
  IF sch IS NULL OR sch = '' OR tbl IS NULL OR tbl = '' THEN
    RAISE EXCEPTION 'invalid schema/table for lp.table_columns';
  END IF;
  -- Only expose lp schema tables (ingested_leads / contacts / companies)
  IF sch <> 'lp' THEN
    RAISE EXCEPTION 'lp.table_columns only allows schema lp (got %)', p_schema;
  END IF;
  IF to_regclass(format('%I.%I', sch, tbl)) IS NULL THEN
    RAISE EXCEPTION 'table not found: %.%', sch, tbl;
  END IF;

  SELECT coalesce(array_agg(c.column_name::text ORDER BY c.ordinal_position), '{}'::text[])
  INTO cols
  FROM information_schema.columns c
  WHERE c.table_schema = sch
    AND c.table_name = tbl;

  RETURN cols;
END;
$$;

GRANT EXECUTE ON FUNCTION lp.table_columns(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.lp_table_columns(
  p_schema text,
  p_table text
)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT lp.table_columns(p_schema, p_table);
$$;

REVOKE ALL ON FUNCTION public.lp_table_columns(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_table_columns(text, text) TO service_role;
