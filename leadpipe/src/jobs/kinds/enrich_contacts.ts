import type { EnrichTier } from "../../config.js";
import { tiersUpTo } from "../../lib/cost.js";
import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import type { EmailResult } from "../../vendors/index.js";

/**
 * enrich_contacts — waterfall getleads → AI Ark → LeadMagic → FullEnrich
 * with max_tier cap. Writes source_tier per contact.
 */
export const runEnrichContacts: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as {
      contact_ids?: string[];
      missing_email_only?: boolean;
      is_dm?: boolean;
      domains?: string[];
    };

    let q = ctx.db
      .from("contacts")
      .select("id")
      .eq("client_tag", ctx.job.client_tag)
      .eq("suppressed", false);

    if (params.contact_ids?.length) {
      q = q.in("id", params.contact_ids);
    } else {
      if (params.missing_email_only !== false) {
        q = q.or("email.is.null,email.eq.");
      }
      if (params.is_dm) q = q.eq("is_dm", true);
      if (params.domains?.length) q = q.in("domain", params.domains);
    }

    const { data, error } = await q.limit(50_000);
    if (error) throw new Error(error.message);
    const keys = (data ?? []).map((r) => r.id as string);
    await seedEntityKeys(ctx.db, ctx.job.id, keys);
    return { rows_total: keys.length };
  },

  async processRow(ctx, contactId) {
    const params = ctx.job.params as { max_tier?: EnrichTier };
    const maxTier = (params.max_tier ?? "leadmagic") as EnrichTier;
    const tiers = tiersUpTo(maxTier);

    const { data: contact, error } = await ctx.db
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .single();
    if (error || !contact) throw new Error(error?.message ?? "contact not found");

    if (contact.email) {
      return {
        useful: true,
        cost_usd: 0,
        summary: { skipped: true, reason: "already_has_email" },
      };
    }

    const domain = contact.domain as string | null;
    if (!domain) {
      return {
        useful: false,
        cost_usd: 0,
        summary: { skipped: true, reason: "no_domain" },
      };
    }

    let cost = 0;
    let found: EmailResult | null = null;
    let usedTier: EnrichTier | null = null;

    for (const tier of tiers) {
      try {
        if (tier === "getleads") {
          const unit = ctx.config.costs.getleads_work_email_finder ?? 0.05;
          found = await ctx.vendors.getleadsWorkEmailFinder({
            domain,
            first_name: contact.first_name ?? "",
            last_name: contact.last_name ?? "",
          });
          cost += unit;
        } else if (tier === "aiark") {
          const unit = ctx.config.costs.aiark_enrich ?? 0.08;
          found = await ctx.vendors.aiarkEnrich({
            domain,
            first_name: contact.first_name ?? undefined,
            last_name: contact.last_name ?? undefined,
            linkedin_url: contact.linkedin_url ?? undefined,
          });
          cost += unit;
        } else if (tier === "leadmagic") {
          const unit = ctx.config.costs.leadmagic_enrich ?? 0.04;
          found = await ctx.vendors.leadmagicEnrich({
            domain,
            first_name: contact.first_name ?? undefined,
            last_name: contact.last_name ?? undefined,
            linkedin_url: contact.linkedin_url ?? undefined,
          });
          cost += unit;
        } else if (tier === "fullenrich") {
          const unit = ctx.config.costs.fullenrich_enrich ?? 0.12;
          found = await ctx.vendors.fullenrichEnrich({
            domain,
            first_name: contact.first_name ?? undefined,
            last_name: contact.last_name ?? undefined,
            linkedin_url: contact.linkedin_url ?? undefined,
          });
          cost += unit;
        }

        await storeRawPayload(ctx.db, {
          job_id: ctx.job.id,
          vendor: tier,
          entity_key: `enrich:${contactId}`,
          payload: found,
        });

        if (found?.email) {
          usedTier = tier;
          break;
        }
      } catch (err) {
        await storeRawPayload(ctx.db, {
          job_id: ctx.job.id,
          vendor: tier,
          entity_key: `enrich_error:${contactId}`,
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    if (found?.email && usedTier) {
      await ctx.db
        .from("contacts")
        .update({
          email: found.email,
          email_status: found.status ?? "found",
          source_tool: usedTier,
          source_tier: usedTier,
          confidence: found.confidence ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contactId);

      return {
        useful: true,
        cost_usd: +cost.toFixed(4),
        summary: { email_found: true, source_tier: usedTier },
      };
    }

    await ctx.db
      .from("contacts")
      .update({
        email_status: "not_found",
        source_tier: maxTier,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contactId);

    return {
      useful: false,
      cost_usd: +cost.toFixed(4),
      summary: { email_found: false, max_tier_tried: maxTier },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let found = 0;
    const byTier: Record<string, number> = {};
    for (const r of data ?? []) {
      const s = (r.result_summary ?? {}) as Record<string, unknown>;
      if (s.email_found) {
        found += 1;
        const t = String(s.source_tier ?? "unknown");
        byTier[t] = (byTier[t] ?? 0) + 1;
      }
    }

    return {
      useful_output_count: found,
      emails_found: found,
      by_source_tier: byTier,
    };
  },
};
