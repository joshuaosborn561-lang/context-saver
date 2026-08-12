import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";

/**
 * backfill — copy existing gc.contacts / permit_parcel.operators into lp.*.
 * Uses the public schema via a separate client path (rpc / raw SQL through REST).
 *
 * Params:
 *   source: "gc_contacts" | "gc_companies" | "peterson_leads"
 *   client_tag: required (already on job)
 */
export const runBackfill: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as { source: string; batch_key?: string };
    if (!params.source) throw new Error("backfill requires params.source");

    // Single entity key representing the backfill batch — processRow does the copy
    const key = params.batch_key ?? `${params.source}:full`;
    await seedEntityKeys(ctx.db, ctx.job.id, [key]);
    return { rows_total: 1 };
  },

  async processRow(ctx, entityKey) {
    const source = entityKey.split(":")[0];
    let inserted = 0;

    if (source === "gc_companies") {
      inserted = await backfillGcCompanies(ctx);
    } else if (source === "gc_contacts") {
      inserted = await backfillGcContacts(ctx);
    } else if (source === "peterson_leads") {
      inserted = await backfillPetersonLeads(ctx);
    } else {
      throw new Error(
        `Unknown backfill source: ${source}. Supported: gc_companies, gc_contacts, peterson_leads`,
      );
    }

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "backfill",
      entity_key: entityKey,
      payload: { inserted, source },
    });

    return {
      useful: inserted > 0,
      cost_usd: 0,
      summary: { inserted, source },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let inserted = 0;
    for (const r of data ?? []) {
      inserted += Number((r.result_summary as { inserted?: number })?.inserted ?? 0);
    }

    return { useful_output_count: inserted, rows_inserted: inserted };
  },
};

type Ctx = Parameters<JobHandler["processRow"]>[0];

/**
 * Backfill via Postgres foreign schema isn't available cross-project.
 * We read from public/gc using the service role with schema override.
 */
async function backfillGcCompanies(ctx: Ctx): Promise<number> {
  const { createClient } = await import("@supabase/supabase-js");
  const publicDb = createClient(ctx.config.supabaseUrl, ctx.config.supabaseServiceKey, {
    auth: { persistSession: false },
    db: { schema: "gc" },
  });

  let inserted = 0;
  let from = 0;
  const page = 500;

  for (;;) {
    const { data, error } = await publicDb
      .from("companies")
      .select("*")
      .range(from, from + page - 1);
    if (error) throw new Error(`gc.companies: ${error.message}`);
    if (!data?.length) break;

    const rows = data
      .filter((r) => r.domain)
      .map((r) => ({
        client_tag: ctx.job.client_tag,
        domain: String(r.domain).toLowerCase().trim(),
        company_name: r.company_name ?? null,
        source: r.source ?? "gc.companies",
        employee_count: parseEmployeeRange(r.employee_range),
        city: r.address_city ?? null,
        state: r.address_state ?? null,
        website: r.website ?? null,
        in_icp: Boolean(r.in_maps_icp),
        metadata: {
          from_gc: true,
          permit_count: r.permit_count,
          dm_lookup_status: r.dm_lookup_status,
        },
      }));

    if (rows.length) {
      const { error: upErr } = await ctx.db
        .from("companies")
        .upsert(rows, { onConflict: "client_tag,domain" });
      if (upErr) throw new Error(upErr.message);
      inserted += rows.length;
    }

    if (data.length < page) break;
    from += page;
  }

  return inserted;
}

async function backfillGcContacts(ctx: Ctx): Promise<number> {
  const { createClient } = await import("@supabase/supabase-js");
  const publicDb = createClient(ctx.config.supabaseUrl, ctx.config.supabaseServiceKey, {
    auth: { persistSession: false },
    db: { schema: "gc" },
  });

  let inserted = 0;
  let from = 0;
  const page = 500;

  for (;;) {
    const { data, error } = await publicDb
      .from("contacts")
      .select("*")
      .range(from, from + page - 1);
    if (error) throw new Error(`gc.contacts: ${error.message}`);
    if (!data?.length) break;

    for (const r of data) {
      if (!r.email && !r.domain) continue;
      const row = {
        client_tag: ctx.job.client_tag,
        domain: r.domain ? String(r.domain).toLowerCase().trim() : null,
        first_name: r.first_name ?? null,
        last_name: r.last_name ?? null,
        job_title: r.job_title ?? null,
        job_level: r.job_level ?? null,
        email: r.email ? String(r.email).toLowerCase().trim() : null,
        email_status: r.email_status ?? null,
        phone: r.cellphone ?? null,
        linkedin_url: r.linkedin_url ?? null,
        source_tool: r.source_tool ?? "gc.contacts",
        source_tier: r.source_tier ?? null,
        confidence: r.confidence ?? null,
        metadata: { from_gc: true, place_id: r.place_id },
      };

      if (row.email) {
        const { error: upErr } = await ctx.db
          .from("contacts")
          .upsert(row, { onConflict: "client_tag,domain,email" });
        if (!upErr) inserted += 1;
      } else {
        const { error: insErr } = await ctx.db.from("contacts").insert(row);
        if (!insErr) inserted += 1;
      }
    }

    if (data.length < page) break;
    from += page;
  }

  return inserted;
}

async function backfillPetersonLeads(ctx: Ctx): Promise<number> {
  const { createClient } = await import("@supabase/supabase-js");
  const publicDb = createClient(ctx.config.supabaseUrl, ctx.config.supabaseServiceKey, {
    auth: { persistSession: false },
  });

  let inserted = 0;
  let from = 0;
  const page = 500;

  for (;;) {
    const { data, error } = await publicDb
      .from("peterson_leads")
      .select("*")
      .range(from, from + page - 1);
    if (error) throw new Error(`peterson_leads: ${error.message}`);
    if (!data?.length) break;

    const companyRows = data
      .map((r) => {
        const domain =
          (r.domain as string) ||
          (typeof r.website === "string"
            ? r.website.replace(/^https?:\/\//, "").split("/")[0]
            : null);
        if (!domain) return null;
        return {
          client_tag: ctx.job.client_tag,
          domain: domain.toLowerCase().trim(),
          company_name: (r.company_name ?? r.name ?? r.business_name) as string | null,
          source: "peterson_leads",
          city: (r.city as string) ?? null,
          state: (r.state as string) ?? null,
          website: (r.website as string) ?? null,
          metadata: { from_peterson_leads: true },
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);

    if (companyRows.length) {
      const { error: upErr } = await ctx.db
        .from("companies")
        .upsert(companyRows, { onConflict: "client_tag,domain" });
      if (upErr) throw new Error(upErr.message);
      inserted += companyRows.length;
    }

    if (data.length < page) break;
    from += page;
  }

  return inserted;
}

function parseEmployeeRange(range: unknown): number | null {
  if (typeof range !== "string") return null;
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
