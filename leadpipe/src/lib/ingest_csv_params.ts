/**
 * Param validation for ingest_csv — unknown keys rejected.
 */

export const INGEST_CSV_ALLOWED_KEYS = [
  "urls",
  "source_label",
  "column_map",
  "dedupe_key",
  "exclude_name_patterns",
  "exclude_domain_list",
] as const;

export const CANONICAL_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "title",
  "company_name",
  "company_domain",
  "city",
  "state",
  "industry",
  "employee_range",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export type IngestCsvParams = {
  urls: string[];
  source_label: string;
  column_map?: Partial<Record<CanonicalField, string>>;
  dedupe_key: "email" | "company_domain";
  exclude_name_patterns: string[];
  exclude_domain_list: string[];
};

function asStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export type IngestCsvValidation =
  | { ok: true; params: IngestCsvParams }
  | { ok: false; error: string };

export function validateIngestCsvParams(
  raw: Record<string, unknown>,
): IngestCsvValidation {
  const unknown = Object.keys(raw).filter(
    (k) => !(INGEST_CSV_ALLOWED_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length) {
    return {
      ok: false,
      error:
        `Unknown ingest_csv params: ${unknown.join(", ")}. ` +
        `Allowed: ${INGEST_CSV_ALLOWED_KEYS.join(", ")}.`,
    };
  }

  const urls = asStringList(raw.urls);
  if (!urls.length) {
    return {
      ok: false,
      error:
        "ingest_csv requires urls: string[] of downloadable https links " +
        "(presigned S3 or public). csv and xlsx supported.",
    };
  }
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: `ingest_csv url must be http(s): ${u.slice(0, 80)}` };
      }
    } catch {
      return { ok: false, error: `ingest_csv invalid url: ${u.slice(0, 80)}` };
    }
  }

  const source_label = String(raw.source_label ?? "").trim();
  if (!source_label) {
    return {
      ok: false,
      error:
        'ingest_csv requires source_label (e.g. "getleads_crowdstrike_20260814"). ' +
        "Stamped on every row.",
    };
  }

  let column_map: Partial<Record<CanonicalField, string>> | undefined;
  if (raw.column_map != null) {
    if (typeof raw.column_map !== "object" || Array.isArray(raw.column_map)) {
      return { ok: false, error: "ingest_csv column_map must be an object" };
    }
    column_map = {};
    for (const [k, v] of Object.entries(raw.column_map as Record<string, unknown>)) {
      if (!(CANONICAL_FIELDS as readonly string[]).includes(k)) {
        return {
          ok: false,
          error:
            `Unknown column_map field "${k}". Canonical: ${CANONICAL_FIELDS.join(", ")}.`,
        };
      }
      if (typeof v !== "string" || !v.trim()) {
        return { ok: false, error: `column_map.${k} must be a non-empty string header name` };
      }
      column_map[k as CanonicalField] = v.trim();
    }
  }

  const dedupeRaw = String(raw.dedupe_key ?? "email").trim().toLowerCase();
  if (dedupeRaw !== "email" && dedupeRaw !== "company_domain") {
    return {
      ok: false,
      error: 'ingest_csv dedupe_key must be "email" (default) or "company_domain".',
    };
  }

  return {
    ok: true,
    params: {
      urls,
      source_label,
      column_map,
      dedupe_key: dedupeRaw,
      exclude_name_patterns: asStringList(raw.exclude_name_patterns).map((s) =>
        s.toLowerCase(),
      ),
      exclude_domain_list: asStringList(raw.exclude_domain_list).map((s) =>
        normalizeDomain(s),
      ),
    },
  };
}

export function normalizeDomain(raw: string): string {
  let d = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0] ?? d;
  d = d.split("?")[0] ?? d;
  return d.replace(/\.+$/, "");
}

export function ingestedLeadsTableName(clientTag: string): string {
  const safe = clientTag.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!safe || !/^[a-z]/.test(safe)) {
    throw new Error(
      `Invalid client_tag for ingested_leads table: ${clientTag}`,
    );
  }
  return `${safe}_ingested_leads`;
}
