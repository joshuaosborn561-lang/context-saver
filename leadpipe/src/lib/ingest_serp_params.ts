/**
 * Param validation for ingest_serp — unknown keys rejected (same discipline as backfill).
 */

export const INGEST_SERP_ALLOWED_KEYS = [
  "apify_run_ids",
  "run_ids",
  "target_titles",
  "persona",
  "require_company_match",
  "write_client_schema",
  "write_lp",
] as const;

export type IngestSerpParams = {
  apify_run_ids: string[];
  target_titles: string | string[];
  persona: string;
  require_company_match?: boolean;
  /** Also write client_<tag>.contacts (default true). */
  write_client_schema?: boolean;
  /** Write lp.contacts (default true). */
  write_lp?: boolean;
};

export type IngestSerpValidation =
  | { ok: true; params: IngestSerpParams }
  | { ok: false; error: string };

export function validateIngestSerpParams(
  raw: Record<string, unknown>,
): IngestSerpValidation {
  const unknown = Object.keys(raw).filter(
    (k) =>
      !(INGEST_SERP_ALLOWED_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length) {
    return {
      ok: false,
      error:
        `Unknown ingest_serp params: ${unknown.join(", ")}. ` +
        `Allowed: ${INGEST_SERP_ALLOWED_KEYS.join(", ")}.`,
    };
  }

  const idsRaw = raw.apify_run_ids ?? raw.run_ids;
  let apify_run_ids: string[] = [];
  if (Array.isArray(idsRaw)) {
    apify_run_ids = idsRaw.map((x) => String(x).trim()).filter(Boolean);
  } else if (typeof idsRaw === "string") {
    apify_run_ids = idsRaw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!apify_run_ids.length) {
    return {
      ok: false,
      error:
        "ingest_serp requires apify_run_ids (array or comma-separated string of Apify actor run IDs).",
    };
  }

  const target_titles = raw.target_titles;
  if (
    target_titles == null ||
    (typeof target_titles === "string" && !target_titles.trim()) ||
    (Array.isArray(target_titles) && target_titles.length === 0)
  ) {
    return {
      ok: false,
      error:
        "ingest_serp requires target_titles (comma-separated string or string[]). " +
        "Example: 'Service Director,Service Manager,Warranty Administrator'.",
    };
  }

  const persona = String(raw.persona ?? "").trim();
  if (!persona) {
    return {
      ok: false,
      error:
        "ingest_serp requires persona (e.g. 'service_side'). Stored on each contact.",
    };
  }

  return {
    ok: true,
    params: {
      apify_run_ids,
      target_titles: target_titles as string | string[],
      persona,
      require_company_match: raw.require_company_match !== false,
      write_client_schema: raw.write_client_schema !== false,
      write_lp: raw.write_lp !== false,
    },
  };
}
