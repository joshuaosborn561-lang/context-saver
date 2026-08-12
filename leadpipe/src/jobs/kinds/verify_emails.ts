import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";

const AMBIGUOUS = new Set([
  "unknown",
  "catch_all",
  "catch-all",
  "risky",
  "ambiguous",
]);

/**
 * verify_emails — MillionVerifier then No2Bounce on ambiguous results.
 */
export const runVerifyEmails: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as {
      contact_ids?: string[];
      unverified_only?: boolean;
    };

    let q = ctx.db
      .from("contacts")
      .select("id")
      .eq("client_tag", ctx.job.client_tag)
      .not("email", "is", null)
      .neq("email", "");

    if (params.contact_ids?.length) {
      q = q.in("id", params.contact_ids);
    } else if (params.unverified_only !== false) {
      q = q.or("email_status.is.null,email_status.eq.,email_status.eq.found,email_status.eq.provided");
    }

    const { data, error } = await q.limit(50_000);
    if (error) throw new Error(error.message);
    const keys = (data ?? []).map((r) => r.id as string);
    await seedEntityKeys(ctx.db, ctx.job.id, keys);
    return { rows_total: keys.length };
  },

  async processRow(ctx, contactId) {
    const { data: contact, error } = await ctx.db
      .from("contacts")
      .select("email")
      .eq("id", contactId)
      .single();
    if (error || !contact?.email) {
      return { useful: false, cost_usd: 0, summary: { skipped: true } };
    }

    let cost = 0;
    const mvUnit = ctx.config.costs.millionverifier ?? 0.002;
    const n2Unit = ctx.config.costs.no2bounce ?? 0.003;

    const mv = await ctx.vendors.millionVerify(contact.email);
    cost += mvUnit;
    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "millionverifier",
      entity_key: contactId,
      payload: mv.raw,
    });

    let status = normalizeStatus(mv.result);

    if (AMBIGUOUS.has(status)) {
      try {
        const n2 = await ctx.vendors.no2bounce(contact.email);
        cost += n2Unit;
        await storeRawPayload(ctx.db, {
          job_id: ctx.job.id,
          vendor: "no2bounce",
          entity_key: contactId,
          payload: n2.raw,
        });
        status = normalizeStatus(n2.result);
      } catch {
        // keep MV status
      }
    }

    const useful = status === "valid" || status === "ok";
    await ctx.db
      .from("contacts")
      .update({
        email_status: status,
        email_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", contactId);

    return {
      useful,
      cost_usd: +cost.toFixed(4),
      summary: { email_status: status },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    const byStatus: Record<string, number> = {};
    let valid = 0;
    for (const r of data ?? []) {
      const s = String((r.result_summary as { email_status?: string })?.email_status ?? "unknown");
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      if (s === "valid" || s === "ok") valid += 1;
    }

    return {
      useful_output_count: valid,
      valid_emails: valid,
      by_status: byStatus,
    };
  },
};

function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (["ok", "valid", "good", "deliverable"].includes(s)) return "valid";
  if (["invalid", "bad", "undeliverable", "bounce"].includes(s)) return "invalid";
  if (["catch_all", "catch-all", "accept_all"].includes(s)) return "catch_all";
  return s || "unknown";
}
