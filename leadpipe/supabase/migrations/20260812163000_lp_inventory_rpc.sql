-- Inventory aggregate (counts only) + public wrapper for service_role

CREATE OR REPLACE FUNCTION lp.inventory_for(p_client_tag text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT jsonb_build_object(
    'companies', (SELECT count(*) FROM lp.companies WHERE client_tag = p_client_tag),
    'contacts', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag),
    'with_email', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND email IS NOT NULL AND email <> ''),
    'dm_grade', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND is_dm),
    'suppressed', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND suppressed),
    'by_source_tier', COALESCE((
      SELECT jsonb_object_agg(source_tier, cnt)
      FROM (
        SELECT source_tier, count(*)::int AS cnt
        FROM lp.contacts
        WHERE client_tag = p_client_tag AND source_tier IS NOT NULL
        GROUP BY source_tier
      ) t
    ), '{}'::jsonb),
    'gaps', jsonb_build_object(
      'missing_email', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND (email IS NULL OR email = '')),
      'dm_missing_email', (SELECT count(*) FROM lp.contacts WHERE client_tag = p_client_tag AND is_dm AND (email IS NULL OR email = '')),
      'unresolved_companies', (SELECT count(*) FROM lp.companies WHERE client_tag = p_client_tag AND (domain IS NULL OR domain = ''))
    )
  );
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
