-- ingest_csv: per-client ingested_leads tables + inventory tier

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
      state text,
      industry text,
      employee_range text,
      source_label text NOT NULL,
      source_url_hash text,
      content_hash text,
      ingested_at timestamptz NOT NULL DEFAULT now()
    )
  $f$, tname);

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

  -- Expose to PostgREST
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

CREATE OR REPLACE FUNCTION lp.ingested_leads_stats(
  p_table text,
  p_source_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
DECLARE
  safe text;
  sql text;
  result jsonb;
BEGIN
  safe := lower(regexp_replace(coalesce(p_table, ''), '[^a-z0-9_]', '', 'g'));
  IF safe IS NULL OR safe = '' OR safe !~ '^[a-z].*_ingested_leads$' THEN
    RAISE EXCEPTION 'invalid ingested_leads table: %', p_table;
  END IF;
  IF to_regclass(format('lp.%I', safe)) IS NULL THEN
    RETURN jsonb_build_object(
      'unique_company_domains', 0,
      'contacts_with_valid_email', 0,
      'total', 0
    );
  END IF;

  IF p_source_label IS NULL OR btrim(p_source_label) = '' THEN
    sql := format(
      $q$
      SELECT jsonb_build_object(
        'unique_company_domains',
          (SELECT count(DISTINCT company_domain) FROM lp.%I
            WHERE company_domain IS NOT NULL AND btrim(company_domain) <> ''),
        'contacts_with_valid_email',
          (SELECT count(*) FROM lp.%I
            WHERE email IS NOT NULL AND position('@' in email) > 1),
        'total', (SELECT count(*) FROM lp.%I)
      )
      $q$, safe, safe, safe
    );
  ELSE
    sql := format(
      $q$
      SELECT jsonb_build_object(
        'unique_company_domains',
          (SELECT count(DISTINCT company_domain) FROM lp.%I
            WHERE source_label = %L
              AND company_domain IS NOT NULL AND btrim(company_domain) <> ''),
        'contacts_with_valid_email',
          (SELECT count(*) FROM lp.%I
            WHERE source_label = %L
              AND email IS NOT NULL AND position('@' in email) > 1),
        'total',
          (SELECT count(*) FROM lp.%I WHERE source_label = %L)
      )
      $q$, safe, p_source_label, safe, p_source_label, safe, p_source_label
    );
  END IF;

  EXECUTE sql INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION lp.ingested_leads_stats(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.lp_ingested_leads_stats(
  p_table text,
  p_source_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT lp.ingested_leads_stats(p_table, p_source_label);
$$;

REVOKE ALL ON FUNCTION public.lp_ingested_leads_stats(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_ingested_leads_stats(text, text) TO service_role;

CREATE OR REPLACE FUNCTION lp.count_ingested_leads(p_client_tag text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
DECLARE
  safe text;
  tname text;
  n integer;
BEGIN
  safe := lower(regexp_replace(coalesce(p_client_tag, ''), '[^a-z0-9_]', '', 'g'));
  IF safe IS NULL OR safe = '' OR safe !~ '^[a-z]' THEN
    RETURN 0;
  END IF;
  tname := safe || '_ingested_leads';
  IF to_regclass(format('lp.%I', tname)) IS NULL THEN
    RETURN 0;
  END IF;
  EXECUTE format('SELECT count(*)::int FROM lp.%I', tname) INTO n;
  RETURN coalesce(n, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION lp.count_ingested_leads(text) TO service_role;

-- Inventory: include ingested tier
CREATE OR REPLACE FUNCTION lp.inventory_for(p_client_tag text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
DECLARE
  tiers jsonb;
  ingested_n integer;
BEGIN
  ingested_n := lp.count_ingested_leads(p_client_tag);

  SELECT COALESCE(jsonb_object_agg(source_tier, cnt), '{}'::jsonb)
  INTO tiers
  FROM (
    SELECT source_tier, count(*)::int AS cnt
    FROM lp.contacts
    WHERE client_tag = p_client_tag AND source_tier IS NOT NULL
    GROUP BY source_tier
  ) t;

  tiers := tiers || jsonb_build_object('ingested', ingested_n);

  RETURN jsonb_build_object(
    'companies', (SELECT count(*) FROM lp.companies WHERE client_tag = p_client_tag),
    'contacts', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag),
    'with_email', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND email IS NOT NULL AND email <> ''),
    'dm_grade', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND is_dm),
    'suppressed', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND suppressed),
    'ingested_leads', ingested_n,
    'by_source_tier', tiers,
    'gaps', jsonb_build_object(
      'missing_email', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND (email IS NULL OR email = '')),
      'dm_missing_email', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND is_dm AND (email IS NULL OR email = '')),
      'unresolved_companies', (SELECT count(*) FROM lp.companies WHERE client_tag = p_client_tag AND (domain IS NULL OR domain = ''))
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION lp.inventory_for(text) TO service_role;

CREATE OR REPLACE FUNCTION public.lp_inventory_for(p_client_tag text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT lp.inventory_for(p_client_tag);
$$;

REVOKE ALL ON FUNCTION public.lp_inventory_for(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_inventory_for(text) TO service_role;
