import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";

/**
 * resolve_companies — address/name → business + domain.
 * SERP-first (Maps returns buildings, not businesses — proven ~40% vs 0.4%).
 * Without a SERP vendor key this job records candidates for manual/external resolve
 * and marks useful only when domain is written.
 */
export const runResolveCompanies: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as {
      company_ids?: string[];
      unresolved_only?: boolean;
    };

    let q = ctx.db
      .from("companies")
      .select("id")
      .eq("client_tag", ctx.job.client_tag);

    if (params.company_ids?.length) {
      q = q.in("id", params.company_ids);
    } else if (params.unresolved_only !== false) {
      q = q.or("domain.is.null,domain.eq.");
    }

    const { data, error } = await q.limit(50_000);
    if (error) throw new Error(error.message);
    const keys = (data ?? []).map((r) => r.id as string);
    await seedEntityKeys(ctx.db, ctx.job.id, keys);
    return { rows_total: keys.length };
  },

  async processRow(ctx, companyId) {
    const { data: company, error } = await ctx.db
      .from("companies")
      .select("*")
      .eq("id", companyId)
      .single();
    if (error || !company) throw new Error(error?.message ?? "company not found");

    if (company.domain) {
      return {
        useful: true,
        cost_usd: 0,
        summary: { skipped: true, reason: "already_resolved", domain: company.domain },
      };
    }

    const unit = ctx.config.costs.resolve_serp ?? 0.01;
    const query = buildResolveQuery(company);

    // Placeholder SERP resolve — stores intent; production wires SerpAPI / custom resolver.
    // Useful output requires an actual domain; guessing is forbidden.
    const payload = {
      query,
      method: "serp_first",
      note: "Wire SERP_API_KEY / resolver endpoint. Maps-only resolution is disabled (0.4% useful rate).",
      resolved_domain: null as string | null,
      business_name: null as string | null,
    };

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "serp_resolve",
      entity_key: companyId,
      payload,
    });

    // If metadata already has a candidate domain from prior offline work, accept it
    const meta = (company.metadata ?? {}) as Record<string, unknown>;
    const candidate =
      typeof meta.candidate_domain === "string" ? meta.candidate_domain : null;

    if (candidate) {
      await ctx.db
        .from("companies")
        .update({
          domain: candidate.toLowerCase().trim(),
          company_name: company.company_name ?? (meta.candidate_name as string) ?? null,
          updated_at: new Date().toISOString(),
          metadata: { ...meta, resolved_via: "candidate_domain", resolve_job: ctx.job.id },
        })
        .eq("id", companyId);

      return {
        useful: true,
        cost_usd: unit,
        summary: { domain: candidate, method: "candidate_domain" },
      };
    }

    return {
      useful: false,
      cost_usd: unit,
      summary: {
        domain: null,
        method: "serp_first_pending",
        query,
        note: "No domain written — useful_output stays 0 until SERP resolver is wired or candidate_domain is set.",
      },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let resolved = 0;
    for (const r of data ?? []) {
      const s = r.result_summary as { domain?: string | null };
      if (s?.domain) resolved += 1;
    }

    return {
      useful_output_count: resolved,
      domains_resolved: resolved,
      note: "Success = domains resolved, not rows touched.",
    };
  },
};

function buildResolveQuery(company: Record<string, unknown>): string {
  const parts = [
    company.company_name,
    company.address,
    company.city,
    company.state,
  ].filter((p) => typeof p === "string" && p.trim());
  return parts.join(" ");
}
