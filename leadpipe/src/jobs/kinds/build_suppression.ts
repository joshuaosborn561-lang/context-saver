import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";

/**
 * build_suppression — mark prior campaign contacts as suppressed=true
 * so dedupe is a join, not a session rebuild.
 */
export const runBuildSuppression: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as {
      emails?: string[];
      campaign_ids?: string[];
      source?: string;
    };

    let keys: string[] = [];

    if (params.emails?.length) {
      keys = params.emails.map((e) => e.toLowerCase().trim());
    } else if (params.campaign_ids?.length) {
      // Pull emails from raw_payloads of prior smartlead syncs (already stripped)
      for (const cid of params.campaign_ids) {
        keys.push(`campaign:${cid}`);
      }
    } else {
      throw new Error(
        "build_suppression requires params.emails or params.campaign_ids",
      );
    }

    await seedEntityKeys(ctx.db, ctx.job.id, keys);
    return { rows_total: keys.length };
  },

  async processRow(ctx, entityKey) {
    const params = ctx.job.params as { source?: string };

    if (entityKey.startsWith("campaign:")) {
      const campaignId = entityKey.slice("campaign:".length);
      const { data: payloads } = await ctx.db
        .from("raw_payloads")
        .select("payload")
        .eq("vendor", "smartlead")
        .eq("entity_key", `campaign:${campaignId}`)
        .order("fetched_at", { ascending: false })
        .limit(1);

      const payload = payloads?.[0]?.payload as {
        leads?: Array<Record<string, unknown>>;
      } | undefined;

      const emails = (payload?.leads ?? [])
        .map((l) => {
          const e = l.email ?? l.Email ?? l.lead_email;
          return typeof e === "string" ? e.toLowerCase().trim() : null;
        })
        .filter((e): e is string => !!e);

      let marked = 0;
      for (const email of emails) {
        marked += await suppressEmail(ctx, email, params.source ?? "smartlead");
      }

      await storeRawPayload(ctx.db, {
        job_id: ctx.job.id,
        vendor: "suppression",
        entity_key: entityKey,
        payload: { emails_considered: emails.length, marked },
      });

      return {
        useful: marked > 0,
        cost_usd: 0,
        summary: { suppressed: marked, emails_considered: emails.length },
      };
    }

    const marked = await suppressEmail(ctx, entityKey, params.source ?? "manual");
    return {
      useful: marked > 0,
      cost_usd: 0,
      summary: { suppressed: marked, email: entityKey },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let suppressed = 0;
    for (const r of data ?? []) {
      suppressed += Number(
        (r.result_summary as { suppressed?: number })?.suppressed ?? 0,
      );
    }

    const { count } = await ctx.db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("client_tag", ctx.job.client_tag)
      .eq("suppressed", true);

    return {
      useful_output_count: suppressed,
      newly_suppressed: suppressed,
      suppressed_total: count ?? 0,
    };
  },
};

async function suppressEmail(
  ctx: { db: import("../../db/client.js").Db; job: { client_tag: string; id: string } },
  email: string,
  source: string,
): Promise<number> {
  const domain = email.split("@")[1] ?? null;

  const { data: existing } = await ctx.db
    .from("contacts")
    .select("id, suppressed")
    .eq("client_tag", ctx.job.client_tag)
    .eq("email", email)
    .limit(1);

  if (existing?.[0]) {
    if (existing[0].suppressed) return 0;
    await ctx.db
      .from("contacts")
      .update({
        suppressed: true,
        updated_at: new Date().toISOString(),
        metadata: { suppressed_via: source, from_job: ctx.job.id },
      })
      .eq("id", existing[0].id);
    return 1;
  }

  await ctx.db.from("contacts").insert({
    client_tag: ctx.job.client_tag,
    domain,
    email,
    suppressed: true,
    source_tool: source,
    source_tier: "suppression",
    metadata: { from_job: ctx.job.id },
  });
  return 1;
}
