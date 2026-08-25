import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import { stripHtmlFields } from "../../vendors/index.js";

/**
 * sync_smartlead — pull campaign stats WITHOUT email bodies.
 * Explicitly strips HTML server-side (Aug 12 failure).
 */
export const runSyncSmartlead: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as { campaign_ids: string[] };
    if (!params.campaign_ids?.length) {
      throw new Error("sync_smartlead requires params.campaign_ids");
    }
    await seedEntityKeys(ctx.db, ctx.job.id, params.campaign_ids.map(String));
    return { rows_total: params.campaign_ids.length };
  },

  async processRow(ctx, campaignId) {
    const { leads, stripped_fields } =
      await ctx.vendors.smartleadCampaignStats(campaignId);

    // Store stripped payloads only — never raw HTML bodies
    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "smartlead",
      entity_key: `campaign:${campaignId}`,
      payload: {
        campaign_id: campaignId,
        lead_count: leads.length,
        stripped_fields,
        leads: leads.map((l) => stripHtmlFields(l)),
      },
    });

    let upserted = 0;
    let suppressed = 0;

    for (const lead of leads) {
      const email = extractEmail(lead);
      if (!email) continue;
      const domain = email.split("@")[1]?.toLowerCase() ?? null;
      const status = String(
        lead.status ?? lead.lead_status ?? lead.email_status ?? "synced",
      ).toLowerCase();

      const { error } = await ctx.db.from("contacts").upsert(
        {
          client_tag: ctx.job.client_tag,
          domain,
          email,
          first_name: (lead.first_name as string) ?? null,
          last_name: (lead.last_name as string) ?? null,
          email_status: status,
          source_tool: "smartlead",
          source_tier: "smartlead",
          metadata: {
            campaign_id: campaignId,
            smartlead_stats: sanitizeStats(lead),
            from_job: ctx.job.id,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_tag,domain,email" },
      );
      if (!error) {
        upserted += 1;
        if (["bounced", "unsubscribed", "complaint"].includes(status)) {
          suppressed += 1;
          await ctx.db
            .from("contacts")
            .update({ suppressed: true })
            .eq("client_tag", ctx.job.client_tag)
            .eq("email", email);
        }
      }
    }

    return {
      useful: upserted > 0,
      cost_usd: 0,
      summary: {
        leads_seen: leads.length,
        contacts_upserted: upserted,
        auto_suppressed: suppressed,
        html_fields_stripped: stripped_fields,
      },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let upserted = 0;
    let seen = 0;
    for (const r of data ?? []) {
      const s = (r.result_summary ?? {}) as Record<string, number>;
      upserted += s.contacts_upserted ?? 0;
      seen += s.leads_seen ?? 0;
    }

    return {
      useful_output_count: upserted,
      contacts_upserted: upserted,
      leads_seen: seen,
      note: "HTML/email bodies stripped server-side; never returned to chat.",
    };
  },
};

function extractEmail(lead: Record<string, unknown>): string | null {
  const candidates = [lead.email, lead.Email, lead.lead_email, lead.to_email];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c.toLowerCase().trim();
  }
  return null;
}

function sanitizeStats(lead: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    "status",
    "lead_status",
    "email_status",
    "opened",
    "clicked",
    "replied",
    "bounced",
    "unsubscribed",
    "sent_count",
    "open_count",
    "click_count",
    "reply_count",
    "category",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in lead) out[k] = lead[k];
  }
  return out;
}
