/**
 * Company + title filters for LinkedIn SERP (apify/google-search-scraper) ingest.
 * Ported from googlemaps-scraper parse_contacts_openai — keeps ~70% past-employer noise out.
 */

const COMPANY_GENERIC = new Set([
  "nissan",
  "toyota",
  "honda",
  "ford",
  "chevy",
  "chevrolet",
  "gmc",
  "bmw",
  "audi",
  "acura",
  "lexus",
  "hyundai",
  "kia",
  "subaru",
  "volkswagen",
  "vw",
  "mazda",
  "dodge",
  "jeep",
  "chrysler",
  "buick",
  "cadillac",
  "lincoln",
  "volvo",
  "mercedes",
  "benz",
  "auto",
  "group",
  "motors",
  "automotive",
  "dealership",
  "car",
  "cars",
]);

const TITLE_ALIASES: Record<string, string[]> = {
  "service director": [
    "service director",
    "director of service",
    "director of service operations",
    "serivce director",
  ],
  "fixed operations director": [
    "fixed operations director",
    "director of fixed operations",
    "director fixed operations",
    "vp of fixed operations",
    "fixed operations leader",
  ],
  "service manager": ["service manager", "automotive service manager"],
  "assistant service manager": [
    "assistant service manager",
    "asst service manager",
    "automotive service assistant manager",
    "assistant service manger",
  ],
  "warranty administrator": ["warranty administrator", "warranty admin"],
  "parts and service director": [
    "parts and service director",
    "service and parts director",
    "parts service director",
    "service parts director",
    "service and part director",
  ],
};

const TITLE_NEGATIVES =
  /\b(customer\s+service\s+manager|service\s+advisor|service\s+consultant|service\s+technician|service\s+writer|service\s+dispatcher|field\s+service\s+)\b/i;

export function normalizeCompany(name: string): string {
  let s = (name || "").toLowerCase();
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(
    /\b(llc|inc|corp|ltd|co|company|the|of|and|&)\b/g,
    " ",
  );
  return s.replace(/\s+/g, " ").trim();
}

export function companyMatches(candidate: string, queried: string): boolean {
  const a = normalizeCompany(candidate);
  const b = normalizeCompany(queried);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return false;
  const distA = [...ta].filter((t) => !COMPANY_GENERIC.has(t));
  const distB = [...tb].filter((t) => !COMPANY_GENERIC.has(t));
  if (distA.length && distB.length) {
    return distA.some((t) => distB.includes(t));
  }
  if (distA.length) return distA.every((t) => tb.has(t));
  if (distB.length) return distB.every((t) => ta.has(t));
  if (ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

export function normTitlePhrase(s: string): string {
  let t = (s || "").toLowerCase().replace(/&/g, " and ");
  t = t.replace(/[|/]+/g, " ");
  t = t.replace(/[^a-z0-9\s.+]/g, " ");
  t = t.replace(/\bassistant\b/g, "asst");
  t = t.replace(/\basst\./g, "asst");
  t = t.replace(/\bfixed\s+ops\b/g, "fixed operations");
  return t.replace(/\s+/g, " ").trim();
}

export function titleMatches(
  title: string,
  targetTitles: string[] | null | undefined,
): boolean {
  if (!targetTitles?.length) return true;
  const t = normTitlePhrase(title);
  if (!t) return false;
  if (TITLE_NEGATIVES.test(t)) return false;
  for (const key of targetTitles) {
    const k = normTitlePhrase(key);
    if (!k) continue;
    const aliases = TITLE_ALIASES[k] ?? [k];
    const phrases = aliases.includes(k) ? aliases : [k, ...aliases];
    for (const phrase of phrases) {
      if (phrase && t.includes(phrase)) return true;
    }
  }
  return false;
}

export function queriedCompanyFromTerm(term: string): string {
  if (!term) return "";
  const m1 = term.match(/site:linkedin\.com\/in\s+"([^"]+)"/i);
  if (m1?.[1]) return m1[1].trim();
  const m2 = term.match(/"([^"]+)"/);
  return m2?.[1]?.trim() ?? "";
}

export function parseLinkedinTitle(
  title: string,
): { fullName: string; jobTitle: string; companyHint: string } {
  const t = (title || "").trim();
  if (!t) return { fullName: "", jobTitle: "", companyHint: "" };
  let name = t;
  let rest = "";
  if (t.includes(" - ")) {
    const i = t.indexOf(" - ");
    name = t.slice(0, i);
    rest = t.slice(i + 3);
  }
  name = name.trim().replace(/^"|"$/g, "");
  rest = rest.trim();
  let job = rest;
  let company = "";
  for (const sep of [" at ", " | ", ", "]) {
    if (rest.includes(sep)) {
      const i = rest.indexOf(sep);
      job = rest.slice(0, i);
      company = rest.slice(i + sep.length);
      break;
    }
  }
  return {
    fullName: name.trim(),
    jobTitle: job.trim(),
    companyHint: company.trim(),
  };
}

export function splitName(full: string): { first: string; last: string } {
  const parts = (full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  return { first: parts[0]!, last: parts[parts.length - 1]! };
}

export function looksLikePerson(first: string, last: string): boolean {
  const name = `${first} ${last}`.trim();
  if (name.length < 3) return false;
  if (
    /^(project\s+manager|manager|president|ceo|owner|director|estimator)/i.test(
      name,
    )
  ) {
    return false;
  }
  if (
    /\b(llc|inc\.?|corp\.?|ltd\.?|company|group|construction)\b/i.test(name)
  ) {
    return false;
  }
  return /[A-Za-z]{2,}/.test(first) || /[A-Za-z]{2,}/.test(last);
}

export interface SerpPerson {
  first_name: string;
  last_name: string;
  job_title: string;
  company_name: string;
  queried_company: string;
  linkedin_url: string;
  confidence: number;
  location: string;
  source_url: string;
}

type Organic = {
  title?: string;
  url?: string;
  description?: string;
  emphasizedKeywords?: unknown[];
  personalInfo?: {
    companyName?: string;
    jobTitle?: string;
    location?: string;
  };
};

export function extractSerpPeople(
  items: unknown[],
  opts: {
    targetTitles?: string[] | null;
    requireCompanyMatch?: boolean;
  } = {},
): SerpPerson[] {
  const targetTitles = opts.targetTitles ?? null;
  const requireCompanyMatch = opts.requireCompanyMatch !== false;
  const out: SerpPerson[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      searchQuery?: { term?: string };
      organicResults?: Organic[];
      suggestedResults?: Organic[];
    };
    const term = row.searchQuery?.term ?? "";
    const queried = queriedCompanyFromTerm(String(term));
    const results = [
      ...(row.organicResults ?? []),
      ...(row.suggestedResults ?? []),
    ];

    for (const org of results) {
      if (!org || typeof org !== "object") continue;
      const pi = org.personalInfo ?? {};
      const titleRaw = String(org.title ?? "");
      const parsed = parseLinkedinTitle(titleRaw);
      let jobTitle = String(pi.jobTitle || parsed.jobTitle || "").trim();
      let companyName = String(
        pi.companyName || parsed.companyHint || "",
      ).trim();

      if (requireCompanyMatch && queried) {
        if (pi.companyName) {
          if (!companyMatches(String(pi.companyName), queried)) continue;
        } else {
          const blob = [titleRaw, String(org.description ?? ""), parsed.companyHint]
            .join(" ");
          if (!companyMatches(blob, queried)) continue;
          companyName = companyName || queried;
        }
      }

      if (!titleMatches(jobTitle, targetTitles)) {
        const desc = [
          titleRaw,
          String(org.description ?? ""),
          ...(org.emphasizedKeywords ?? []).map(String),
        ].join(" ");
        const re =
          /(Parts and Service Director|Fixed Operations Director|Assistant Service Manager|ASST\.?\s*SERVICE\s*MANAGER|Service Director|Warranty Administrator|Service Manager|Automotive service director)/gi;
        let alt = "";
        let m: RegExpExecArray | null;
        while ((m = re.exec(desc))) {
          if (titleMatches(m[1]!, targetTitles)) {
            alt = m[1]!;
            break;
          }
        }
        if (!alt) continue;
        jobTitle = alt;
      }

      if (
        /\b(technician|retired|sales\s+manager|real\s+estate|field\s+service\s+engineer|investor)\b/i.test(
          jobTitle,
        )
      ) {
        continue;
      }

      const fullName = parsed.fullName;
      if (!fullName) continue;
      const { first, last } = splitName(fullName);
      if (!looksLikePerson(first, last)) continue;

      const linkedin = String(org.url ?? "").trim();
      const key = `${first.toLowerCase()}|${last.toLowerCase()}|${normalizeCompany(companyName || queried)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        first_name: first,
        last_name: last,
        job_title: jobTitle,
        company_name: companyName || queried,
        queried_company: queried,
        linkedin_url: linkedin,
        confidence: pi.companyName ? 0.75 : 0.55,
        location: String(pi.location ?? ""),
        source_url: linkedin,
      });
    }
  }
  return out;
}

export function parseTargetTitles(
  raw: string | string[] | undefined | null,
): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
