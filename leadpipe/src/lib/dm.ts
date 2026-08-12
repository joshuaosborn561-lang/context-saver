/**
 * Title-based DM detection — mirrors the SQL generated column.
 * Keep in sync with lp.contacts.is_dm.
 */

const DM_POSITIVE =
  /\b(owner|co-?owner|founder|co-?founder|ceo|chief executive|president|co-?president|principal|partner|managing partner|director|vp|v\.p\.|vice[- ]president|head of|general manager|gm|managing director|proprietor|property manager|asset manager)\b/i;

const DM_NEGATIVE =
  /\b(assistant|coordinator|intern|junior|associate to)\b/i;

export function isDecisionMakerTitle(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return false;
  if (!DM_POSITIVE.test(title)) return false;
  if (DM_NEGATIVE.test(title)) return false;
  return true;
}

/** Default roof / property-manager relevant titles for Peterson-style ICP. */
export const DEFAULT_DM_TITLE_HINTS = [
  "owner",
  "founder",
  "ceo",
  "president",
  "principal",
  "partner",
  "director",
  "vp",
  "vice president",
  "general manager",
  "property manager",
  "managing",
];
