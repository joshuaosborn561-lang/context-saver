import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import { WRITE_CHUNK_SIZE, chunkItems, writeChunks } from "../../lib/concurrency.js";
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

    const prepared = collectSmartleadContactWrites(leads, {
      client_tag: ctx.job.client_tag,
      campaign_id: campaignId,
      job_id: ctx.job.id,
    });

    const upserted = await writeChunks(prepared.upserts, async (chunk) => {
      const { error } = await ctx.db
        .from("contacts")
        .upsert(chunk, { onConflict: "client_tag,domain,email" });
      return { error };
    });

    let suppressed = 0;
    for (const emails of chunkItems(prepared.suppressEmails, WRITE_CHUNK_SIZE)) {
      const { error } = await ctx.db
        .from("contacts")
        .update({ suppressed: true })
        .eq("client_tag", ctx.job.client_tag)
        .in("email", emails);
      if (!error) suppressed += emails.length;
    }

    return {
      useful: upserted.written > 0,
      cost_usd: 0,
      summary: {
        leads_seen: leads.length,
        contacts_upserted: upserted.written,
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

export function collectSmartleadContactWrites(
  leads: Record<string, unknown>[],
  meta: { client_tag: string; campaign_id: string; job_id: string },
): { upserts: Record<string, unknown>[]; suppressEmails: string[] } {
  const upserts: Record<string, unknown>[] = [];
  const suppressEmails: string[] = [];
  const now = new Date().toISOString();
  for (const lead of leads) {
    const email = extractEmail(lead);
    if (!email) continue;
    const domain = email.split("@")[1]?.toLowerCase() ?? null;
    const status = String(
      lead.status ?? lead.lead_status ?? lead.email_status ?? "synced",
    ).toLowerCase();
    upserts.push({
      client_tag: meta.client_tag,
      domain,
      email,
      first_name: (lead.first_name as string) ?? null,
      last_name: (lead.last_name as string) ?? null,
      email_status: status,
      source_tool: "smartlead",
      source_tier: "smartlead",
      metadata: {
        campaign_id: meta.campaign_id,
        smartlead_stats: sanitizeStats(lead),
        from_job: meta.job_id,
      },
      updated_at: now,
    });
    if (["bounced", "unsubscribed", "complaint"].includes(status)) {
      suppressEmails.push(email);
    }
  }
  return { upserts, suppressEmails };
}

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
