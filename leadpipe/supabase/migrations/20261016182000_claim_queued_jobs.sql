-- Atomically claim queued/interrupted jobs (FOR UPDATE SKIP LOCKED).
-- Worker calls lp.claim_queued_jobs(p_limit) so two pollers never take the same row.

CREATE OR REPLACE FUNCTION lp.claim_queued_jobs(p_limit integer DEFAULT 1)
RETURNS SETOF lp.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = lp, public
AS $$
DECLARE
  n integer := GREATEST(0, LEAST(COALESCE(p_limit, 1), 4));
BEGIN
  UPDATE lp.jobs
  SET status = 'interrupted'
  WHERE status = 'running'
    AND heartbeat_at IS NOT NULL
    AND heartbeat_at < now() - interval '90 seconds';

  IF n = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE lp.jobs j
  SET
    status = 'running',
    started_at = COALESCE(j.started_at, now()),
    heartbeat_at = now()
  WHERE j.id IN (
    SELECT c.id
    FROM lp.jobs c
    WHERE c.status IN ('queued', 'interrupted')
    ORDER BY c.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT n
  )
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION lp.claim_queued_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lp.claim_queued_jobs(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.lp_claim_queued_jobs(p_limit integer DEFAULT 1)
RETURNS SETOF lp.jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = lp, public
AS $$
  SELECT * FROM lp.claim_queued_jobs(p_limit);
$$;

REVOKE ALL ON FUNCTION public.lp_claim_queued_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lp_claim_queued_jobs(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
