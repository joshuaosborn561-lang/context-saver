/**
 * Param validation for ingest_serp — unknown keys rejected (same discipline as backfill).
 */

export const INGEST_SERP_ALLOWED_KEYS = [
  "apify_run_ids",
  "run_ids",
  "apify_dataset_ids",
  "dataset_ids",
  "storage_paths",
  "target_titles",
  "persona",
  "require_company_match",
  "write_client_schema",
  "write_lp",
] as const;

export type IngestSerpParams = {
  /** Entity keys seeded as run:<id> / dataset:<id> / storage:<path> */
  entity_keys: string[];
  apify_run_ids: string[];
  apify_dataset_ids: string[];
  storage_paths: string[];
  target_titles: string | string[];
  persona: string;
  require_company_match?: boolean;
  /** Also write client_<tag>.contacts (default true). */
  write_client_schema?: boolean;
  /** Write lp.contacts (default true). */
  write_lp?: boolean;
};

function asStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

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

  const apify_run_ids = asStringList(raw.apify_run_ids ?? raw.run_ids);
  const apify_dataset_ids = asStringList(
    raw.apify_dataset_ids ?? raw.dataset_ids,
  );
  const storage_paths = asStringList(raw.storage_paths);

  const entity_keys = [
    ...apify_run_ids.map((id) => `run:${id}`),
    ...apify_dataset_ids.map((id) => `dataset:${id}`),
    ...storage_paths.map((p) => `storage:${p}`),
  ];

  if (!entity_keys.length) {
    return {
      ok: false,
      error:
        "ingest_serp requires one of: apify_run_ids, apify_dataset_ids, or storage_paths " +
        "(JSON arrays of google-search-scraper items staged in Supabase storage).",
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
      entity_keys,
      apify_run_ids,
      apify_dataset_ids,
      storage_paths,
      target_titles: target_titles as string | string[],
      persona,
      require_company_match: raw.require_company_match !== false,
      write_client_schema: raw.write_client_schema !== false,
      write_lp: raw.write_lp !== false,
    },
  };
}
