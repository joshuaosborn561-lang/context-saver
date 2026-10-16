/**
 * Client tag normalization + validation.
 * Any new snake_case tag is allowed — call ensure_client to provision schema.
 */

export const CLIENT_TAG_RE = /^[a-z][a-z0-9_]{0,46}$/;

export function normalizeClientTag(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function assertClientTag(raw: string): string {
  const tag = normalizeClientTag(raw);
  if (!CLIENT_TAG_RE.test(tag)) {
    throw new Error(
      `Invalid client_tag "${raw}". Use lowercase snake_case starting with a letter ` +
        `(e.g. basco, culture_fits, acme_roofing). Max 47 chars.`,
    );
  }
  // reserved schema prefixes / names
  if (
    tag === "lp" ||
    tag === "public" ||
    tag === "gc" ||
    tag === "storage" ||
    tag === "auth" ||
    tag === "extensions" ||
    tag === "graphql_public" ||
    tag === "master" ||
    tag === "permit_parcel" ||
    tag.startsWith("pg_")
  ) {
    throw new Error(`client_tag "${tag}" is reserved`);
  }
  return tag;
}

export function clientSchemaName(clientTag: string): string {
  return `client_${assertClientTag(clientTag)}`;
}
