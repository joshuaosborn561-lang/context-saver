/**
 * Title filters for DM discovery.
 * `isDecisionMakerTitle` — broad exec titles (SQL generated column parity).
 * `isRoofRelevantTitle` — Peterson/property path proven 2026-08-12.
 */

const DM_POSITIVE =
  /\b(owner|co-?owner|founder|co-?founder|ceo|chief executive|president|co-?president|principal|partner|managing partner|director|vp|v\.p\.|vice[- ]president|head of|general manager|gm|managing director|proprietor|property manager|asset manager)\b/i;

const DM_NEGATIVE =
  /\b(assistant|coordinator|intern|junior|associate to)\b/i;

/** Roof / facilities ICP — include */
const ROOF_POSITIVE =
  /facilit|property\s*manag|asset\s*manag|building\s*manag|maintenance|construction\s*manag|preconstruction|engineering\s*manag|chief\s*engineer|operations\s*manag|director of operations|portfolio\s*manag|community\s*manag|regional\s*manag|district\s*manag/i;

/** Roof / facilities ICP — exclude */
const ROOF_NEGATIVE =
  /human resources|\bhr\b|marketing|recruiting|counsel|\blegal\b|attorney|accountant|bookkeep|tax manager|\bintern\b/i;

export function isDecisionMakerTitle(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return false;
  if (!DM_POSITIVE.test(title)) return false;
  if (DM_NEGATIVE.test(title)) return false;
  return true;
}

/** Proven title filter for property/roof outreach (not CFOs / general counsel). */
export function isRoofRelevantTitle(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return false;
  if (!ROOF_POSITIVE.test(title)) return false;
  if (ROOF_NEGATIVE.test(title)) return false;
  return true;
}

export function isUsPerson(record: {
  country_code?: string | null;
  country?: string | null;
  location?: string | null;
}): boolean {
  const code = (record.country_code ?? "").toString().trim().toUpperCase();
  if (code) return code === "US" || code === "USA" || code === "UNITED STATES";
  const country = (record.country ?? "").toString().trim().toLowerCase();
  if (country) {
    return (
      country === "us" ||
      country === "usa" ||
      country === "united states" ||
      country === "united states of america"
    );
  }
  const loc = (record.location ?? "").toString().trim().toLowerCase();
  if (loc) {
    // Drop obvious non-US locations (Brazil/India staff at DFW companies)
    if (
      /\b(brazil|brasil|india|mexico|canada|uk|united kingdom|philippines|nigeria|pakistan|argentina|colombia|chile|peru)\b/.test(
        loc,
      )
    ) {
      return false;
    }
    if (
      /\b(united states|usa|\bu\.?s\.?a\.?\b|\bus\b)/.test(loc) ||
      /,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/.test(
        loc,
      )
    ) {
      return true;
    }
  }
  // Unknown country → keep (don't drop); only drop explicit non-US
  return true;
}

export const DEFAULT_DM_TITLE_HINTS = [
  "property manager",
  "facilities",
  "asset manager",
  "building manager",
  "maintenance",
  "operations manager",
  "portfolio manager",
];
