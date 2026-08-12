-- Widen DM title detection for property/asset managers

DROP VIEW IF EXISTS lp.inventory_counts;

ALTER TABLE lp.contacts DROP COLUMN IF EXISTS is_dm;
ALTER TABLE lp.contacts ADD COLUMN is_dm boolean GENERATED ALWAYS AS (
  CASE
    WHEN job_title IS NULL OR btrim(job_title) = '' THEN false
    WHEN job_title ~* '\m(owner|co-?owner|founder|co-?founder|ceo|chief executive|president|co-?president|principal|partner|managing partner|director|vp|v\.p\.|vice[- ]president|head of|general manager|gm|managing director|proprietor|property manager|asset manager)\M'
      AND job_title !~* '\m(assistant|coordinator|intern|junior|associate to)\M'
    THEN true
    ELSE false
  END
) STORED;

CREATE INDEX IF NOT EXISTS contacts_dm_idx ON lp.contacts (client_tag, is_dm) WHERE is_dm = true;

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
