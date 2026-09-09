/**
 * Shared filter shape used by plan / inventory / sample / export.
 * Filters compile to Supabase query constraints — never pull then filter in JS at scale.
 */

export interface LeadFilter {
  client_tag: string;
  domain?: string;
  domains?: string[];
  has_email?: boolean;
  missing_email?: boolean;
  is_dm?: boolean;
  suppressed?: boolean;
  source_tier?: string;
  source_tool?: string;
  in_icp?: boolean;
  segment?: string;
  email_status?: string;
  unresolved_domain?: boolean;
  job_title_ilike?: string;
}

export type FilterableTable = "contacts" | "companies";

/** Apply filter to a supabase query builder-like object. */
export function applyContactFilter<T extends { eq: Function; in: Function; is: Function; or: Function; ilike: Function; not: Function }>(
  q: T,
  filter: LeadFilter,
): T {
  let query = q.eq("client_tag", filter.client_tag);

  if (filter.domain) query = query.eq("domain", filter.domain);
  if (filter.domains?.length) query = query.in("domain", filter.domains);
  if (filter.has_email === true) {
    query = query.not("email", "is", null).neq("email", "");
  }
  if (filter.missing_email === true) {
    query = query.or("email.is.null,email.eq.");
  }
  if (filter.is_dm !== undefined) query = query.eq("is_dm", filter.is_dm);
  if (filter.suppressed !== undefined) query = query.eq("suppressed", filter.suppressed);
  if (filter.source_tier) query = query.eq("source_tier", filter.source_tier);
  if (filter.source_tool) query = query.eq("source_tool", filter.source_tool);
  if (filter.email_status) query = query.eq("email_status", filter.email_status);
  if (filter.job_title_ilike) query = query.ilike("job_title", filter.job_title_ilike);
  if (filter.unresolved_domain === true) {
    query = query.or("domain.is.null,domain.eq.");
  }

  return query;
}

export function applyCompanyFilter<T extends { eq: Function; in: Function; is: Function; or: Function }>(
  q: T,
  filter: LeadFilter,
): T {
  let query = q.eq("client_tag", filter.client_tag);
  if (filter.domain) query = query.eq("domain", filter.domain);
  if (filter.domains?.length) query = query.in("domain", filter.domains);
  if (filter.in_icp !== undefined) query = query.eq("in_icp", filter.in_icp);
  if (filter.segment) query = query.eq("segment", filter.segment);
  if (filter.unresolved_domain === true) {
    query = query.or("domain.is.null,domain.eq.");
  }
  return query;
}
