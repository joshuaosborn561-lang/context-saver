/**
 * Header dialect auto-detection → canonical field map.
 * Dialects: getleads, AI Ark, Smartlead, generic snake_case / Title Case.
 */

import {
  CANONICAL_FIELDS,
  type CanonicalField,
  normalizeDomain,
} from "./ingest_csv_params.js";

export type ColumnResolution =
  | {
      ok: true;
      map: Record<CanonicalField, string | null>;
      dialect: string;
      headers: string[];
    }
  | {
      ok: false;
      error: string;
      headers: string[];
    };

/** Lowercased header → canonical field aliases (first match wins per field). */
const ALIASES: Record<CanonicalField, string[]> = {
  first_name: [
    "first_name",
    "firstname",
    "first name",
    "first",
    "given_name",
    "given name",
  ],
  last_name: [
    "last_name",
    "lastname",
    "last name",
    "last",
    "surname",
    "family_name",
    "family name",
  ],
  email: [
    "email",
    "email_address",
    "email address",
    "work_email",
    "work email",
    "business_email",
    "business email",
    "e-mail",
  ],
  title: [
    "title",
    "job_title",
    "job title",
    "current job title",
    "current_job_title",
    "position",
    "role",
    "job_role",
    "job role",
  ],
  company_name: [
    "company_name",
    "company name",
    "company",
    "organization",
    "organisation",
    "account_name",
    "account name",
    "employer",
  ],
  company_domain: [
    "company_domain",
    "company domain",
    "domain",
    "website",
    "company_website",
    "company website",
    "website_domain",
    "website domain",
    "primary_domain",
    "primary domain",
  ],
  state: ["state", "region", "province", "st"],
  industry: ["industry", "sector", "vertical"],
  employee_range: [
    "employee_range",
    "employee range",
    "employees",
    "employee_count",
    "employee count",
    "company_size",
    "company size",
    "headcount",
    "size",
  ],
};

function normHeader(h: string): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
}

function detectDialect(headers: string[]): string {
  const n = new Set(headers.map(normHeader));
  if (
    n.has("company domain") ||
    n.has("current job title") ||
    n.has("email verification status")
  ) {
    return "getleads";
  }
  if (
    n.has("person linkedin url") ||
    n.has("company linkedin url") ||
    (n.has("full name") && n.has("company name"))
  ) {
    return "ai_ark";
  }
  if (n.has("campaign_id") || n.has("lead_category") || n.has("custom_fields")) {
    return "smartlead";
  }
  if ([...n].some((h) => h.includes("_"))) return "snake_case";
  return "generic";
}

/**
 * Resolve headers → canonical map.
 * `explicit` overrides (values are source header names as they appear in the file).
 */
export function resolveColumnMap(
  headers: string[],
  explicit?: Partial<Record<CanonicalField, string>>,
): ColumnResolution {
  const headersList = headers.map((h) => String(h ?? ""));
  const byNorm = new Map<string, string>();
  for (const h of headersList) {
    const n = normHeader(h);
    if (n && !byNorm.has(n)) byNorm.set(n, h);
  }

  const map = {} as Record<CanonicalField, string | null>;
  for (const field of CANONICAL_FIELDS) {
    map[field] = null;
  }

  if (explicit) {
    for (const field of CANONICAL_FIELDS) {
      const want = explicit[field];
      if (!want) continue;
      const hit =
        headersList.find((h) => h === want) ??
        byNorm.get(normHeader(want)) ??
        null;
      if (!hit) {
        return {
          ok: false,
          headers: headersList,
          error:
            `column_map.${field}="${want}" not found in file headers. ` +
            `Headers: ${headersList.join(" | ") || "(none)"}`,
        };
      }
      map[field] = hit;
    }
  }

  for (const field of CANONICAL_FIELDS) {
    if (map[field]) continue;
    for (const alias of ALIASES[field]) {
      const hit = byNorm.get(normHeader(alias));
      if (hit) {
        map[field] = hit;
        break;
      }
    }
  }

  // AI Ark often ships "Full Name" without first/last split
  if (!map.first_name && !map.last_name) {
    const full =
      byNorm.get("full name") ??
      byNorm.get("fullname") ??
      byNorm.get("contact name");
    if (full) {
      map.first_name = full;
      // last_name left null; splitter in row mapper handles "Full Name"
    }
  }

  if (!map.company_domain || !map.email) {
    const missing = [
      !map.email ? "email" : null,
      !map.company_domain ? "company_domain" : null,
    ].filter(Boolean);
    return {
      ok: false,
      headers: headersList,
      error:
        `Cannot resolve required fields (${missing.join(", ")}). ` +
        `Pass column_map or use a known dialect (getleads / AI Ark / Smartlead / snake_case). ` +
        `Headers found (${headersList.length}): ${headersList.join(" | ") || "(none)"}`,
    };
  }

  return {
    ok: true,
    map,
    dialect: detectDialect(headersList),
    headers: headersList,
  };
}

export type CanonicalRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  company_name: string | null;
  company_domain: string | null;
  state: string | null;
  industry: string | null;
  employee_range: string | null;
};

function cell(
  row: Record<string, unknown>,
  header: string | null,
): string | null {
  if (!header) return null;
  const v = row[header];
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function splitFullName(full: string): { first: string | null; last: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

export function mapRawRow(
  row: Record<string, unknown>,
  map: Record<CanonicalField, string | null>,
): CanonicalRow {
  let first_name = cell(row, map.first_name);
  let last_name = cell(row, map.last_name);

  // When first_name header is actually a full-name column and last is empty
  if (first_name && !last_name && map.first_name && !map.last_name) {
    const headerNorm = normHeader(map.first_name);
    if (
      headerNorm === "full name" ||
      headerNorm === "name" ||
      headerNorm === "contact name"
    ) {
      const split = splitFullName(first_name);
      first_name = split.first;
      last_name = split.last;
    }
  }

  const emailRaw = cell(row, map.email);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const domainRaw = cell(row, map.company_domain);
  const company_domain = domainRaw ? normalizeDomain(domainRaw) : null;

  return {
    first_name,
    last_name,
    email,
    title: cell(row, map.title),
    company_name: cell(row, map.company_name),
    company_domain,
    state: cell(row, map.state),
    industry: cell(row, map.industry),
    employee_range: cell(row, map.employee_range),
  };
}

export function rowPassesFilters(
  row: CanonicalRow,
  excludeNamePatterns: string[],
  excludeDomains: string[],
): boolean {
  if (row.company_domain && excludeDomains.includes(row.company_domain)) {
    return false;
  }
  if (excludeNamePatterns.length && row.company_name) {
    const name = row.company_name.toLowerCase();
    if (excludeNamePatterns.some((p) => p && name.includes(p))) return false;
  }
  return true;
}
