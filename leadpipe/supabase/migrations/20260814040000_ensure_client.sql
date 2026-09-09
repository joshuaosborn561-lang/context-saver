-- Ensure Claude can provision new clients without a deploy/manual SQL.

CREATE TABLE IF NOT EXISTS lp.clients (
  client_tag text PRIMARY KEY,
  display_name text,
  schema_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON lp.clients TO service_role;

CREATE OR REPLACE FUNCTION lp.append_pgrst_schema(p_schema text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, lp
AS $$
DECLARE
  cfg text;
  current_list text;
  parts text[];
  found boolean := false;
  p text;
  new_list text;
BEGIN
  IF p_schema IS NULL OR p_schema !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid schema name %', p_schema;
  END IF;

  SELECT c INTO cfg
  FROM unnest(coalesce((SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator'), ARRAY[]::text[])) AS c
  WHERE c LIKE 'pgrst.db_schemas=%'
  LIMIT 1;

  IF cfg IS NULL THEN
    current_list := 'public';
  ELSE
    current_list := substr(cfg, length('pgrst.db_schemas=') + 1);
  END IF;

  parts := string_to_array(replace(current_list, ' ', ''), ',');
  FOREACH p IN ARRAY parts LOOP
    IF p = p_schema THEN
      found := true;
      EXIT;
    END IF;
  END LOOP;

  IF NOT found THEN
    new_list := current_list || ', ' || p_schema;
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', new_list);
    PERFORM pg_notify('pgrst', 'reload config');
  END IF;

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$$;

GRANT EXECUTE ON FUNCTION lp.append_pgrst_schema(text) TO service_role;

CREATE OR REPLACE FUNCTION lp.ensure_client(
  p_client_tag text,
  p_display_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = lp, public
AS $$
DECLARE
  safe text;
  schema_name text;
  created_schema boolean := false;
  created_tables boolean := false;
BEGIN
  safe := lower(regexp_replace(coalesce(p_client_tag, ''), '[^a-z0-9_]', '', 'g'));
  IF safe IS NULL OR safe = '' OR safe !~ '^[a-z][a-z0-9_]{0,46}$' THEN
    RAISE EXCEPTION 'invalid client_tag: %', p_client_tag;
  END IF;
  IF safe IN (
    'lp','public','gc','storage','auth','extensions','graphql_public',
    'master','permit_parcel','information_schema'
  ) OR safe LIKE 'pg_%' THEN
    RAISE EXCEPTION 'client_tag reserved: %', safe;
  END IF;

  schema_name := 'client_' || safe;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = schema_name) THEN
    EXECUTE format('CREATE SCHEMA %I', schema_name);
    created_schema := true;
  END IF;

  -- leads (maps / rooftop source of truth for backfill)
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %I.leads (
      place_id text NOT NULL,
      run_label text NOT NULL DEFAULT 'default',
      name text,
      owner_name text,
      owner_title text,
      owner_source text,
      email text,
      all_emails text,
      phone text,
      website text,
      domain text,
      address text,
      city text,
      state text,
      zip text,
      source_zip text,
      rating double precision,
      reviews integer,
      main_category text,
      types text,
      latitude double precision,
      longitude double precision,
      maps_url text,
      in_icp boolean DEFAULT false,
      icp_confidence double precision,
      icp_reason text,
      source_category text,
      permit_count integer,
      source text,
      client_tag text NOT NULL DEFAULT %L,
      plan_id text,
      run_id text,
      synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (place_id, run_label)
    )
  $f$, schema_name, safe);

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %I.companies (
      domain text PRIMARY KEY,
      company_name text,
      source text,
      website text,
      address_city text,
      address_state text,
      employee_range text,
      client_tag text NOT NULL DEFAULT %L,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  $f$, schema_name, safe);

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %I.contacts (
      id bigserial PRIMARY KEY,
      domain text NOT NULL,
      first_name text,
      last_name text,
      job_title text,
      job_level text,
      email text,
      email_status text,
      cellphone text,
      linkedin_url text,
      contact_city text,
      contact_state text,
      source_tool text,
      source_tier text,
      source_url text,
      confidence double precision,
      place_id text,
      persona text,
      client_tag text NOT NULL DEFAULT %L,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  $f$, schema_name, safe);

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.contacts (domain)',
    safe || '_contacts_domain_idx',
    schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.contacts (email)',
    safe || '_contacts_email_idx',
    schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.leads (domain)',
    safe || '_leads_domain_idx',
    schema_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.leads (client_tag)',
    safe || '_leads_client_tag_idx',
    schema_name
  );

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role, authenticator, postgres', schema_name);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role', schema_name);
  EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO service_role', schema_name);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON TABLES TO service_role',
    schema_name
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON SEQUENCES TO service_role',
    schema_name
  );

  created_tables := true;

  PERFORM lp.append_pgrst_schema(schema_name);

  -- ingested_leads table for ingest_csv
  PERFORM lp.ensure_ingested_leads_table(safe, 'email');

  INSERT INTO lp.clients (client_tag, display_name, schema_name, updated_at)
  VALUES (safe, coalesce(nullif(btrim(p_display_name), ''), safe), schema_name, now())
  ON CONFLICT (client_tag) DO UPDATE
    SET display_name = coalesce(nullif(btrim(EXCLUDED.display_name), ''), lp.clients.display_name),
        updated_at = now();

  RETURN jsonb_build_object(
    'client_tag', safe,
    'schema_name', schema_name,
    'display_name', coalesce(nullif(btrim(p_display_name), ''), safe),
    'created_schema', created_schema,
    'ok', true,
    'tables', jsonb_build_array('leads', 'companies', 'contacts') ||
      jsonb_build_array(safe || '_ingested_leads')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION lp.ensure_client(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.lp_ensure_client(
  p_client_tag text,
  p_display_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT lp.ensure_client(p_client_tag, p_display_name);
$$;

REVOKE ALL ON FUNCTION public.lp_ensure_client(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_ensure_client(text, text) TO service_role;

CREATE OR REPLACE FUNCTION lp.list_clients()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'client_tag', c.client_tag,
        'display_name', c.display_name,
        'schema_name', c.schema_name,
        'created_at', c.created_at
      )
      ORDER BY c.client_tag
    ),
    '[]'::jsonb
  )
  FROM lp.clients c;
$$;

GRANT EXECUTE ON FUNCTION lp.list_clients() TO service_role;

CREATE OR REPLACE FUNCTION public.lp_list_clients()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT lp.list_clients();
$$;

REVOKE ALL ON FUNCTION public.lp_list_clients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_list_clients() TO service_role;

-- Seed known clients already present as schemas
INSERT INTO lp.clients (client_tag, display_name, schema_name)
SELECT
  substr(n.nspname, length('client_') + 1),
  substr(n.nspname, length('client_') + 1),
  n.nspname
FROM pg_namespace n
WHERE n.nspname LIKE 'client_%'
ON CONFLICT (client_tag) DO NOTHING;
