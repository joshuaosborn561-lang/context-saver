import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { JobHandler, JobContext } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import {
  parseClientLeadsTask,
  parseOwnerSegments,
  validateBackfillParams,
  type BackfillParams,
} from "../../lib/backfill_params.js";

export { validateBackfillParams } from "../../lib/backfill_params.js";

/**
 * backfill — copy source data into lp.* for a client_tag.
 * See lib/backfill_params.ts for accepted params.
 * Zero source rows → FAILED (never a quiet success).
 */

const PROJECT_CI = "azpapwtnrbzywlnxxecz";
const PROJECT_MAPS = "kemvxzhcxvynmoutwdrh";

export const runBackfill: JobHandler = {
  async seed(ctx) {
    const raw = (ctx.job.params ?? {}) as Record<string, unknown>;
    const validated = validateBackfillParams(raw);
    if (!validated.ok) throw new Error(validated.error);

    const { tasks, normalized } = validated;
    // Persist normalized task list for processRow
    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "backfill_plan",
      entity_key: "plan",
      payload: { tasks, params: normalized },
    });

    await seedEntityKeys(ctx.db, ctx.job.id, tasks);
    return { rows_total: tasks.length };
  },

  async processRow(ctx, entityKey) {
    const params = (ctx.job.params ?? {}) as BackfillParams;
    let inserted = 0;
    let source_rows = 0;

    const clientLeads = parseClientLeadsTask(entityKey);
    if (entityKey === "gc_companies") {
      const r = await backfillGcCompanies(ctx);
      inserted = r.inserted;
      source_rows = r.source_rows;
    } else if (entityKey === "gc_contacts") {
      const r = await backfillGcContacts(ctx);
      inserted = r.inserted;
      source_rows = r.source_rows;
    } else if (entityKey === "peterson_leads" || clientLeads) {
      // peterson_leads alias + client_<tag>.leads (canonical)
      const schema =
        clientLeads?.schema ??
        (entityKey === "peterson_leads" ? "client_peterson" : "");
      if (!schema) {
        throw new Error(`Could not resolve schema for task ${entityKey}`);
      }
      const r = await backfillClientLeads(ctx, schema, params);
      inserted = r.inserted;
      source_rows = r.source_rows;
    } else if (entityKey === "permit_parcel.operators") {
      const r = await backfillOperators(ctx, params);
      inserted = r.inserted;
      source_rows = r.source_rows;
    } else {
      throw new Error(
        `Unknown backfill task "${entityKey}". Supported: gc_companies, gc_contacts, ` +
          `client_leads:client_<tag>, permit_parcel.operators`,
      );
    }

    if (source_rows === 0) {
      throw new Error(
        `Backfill task ${entityKey} found ZERO source rows. ` +
          `Refusing to succeed silently. Check source project/schema exposure and filters.`,
      );
    }

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "backfill",
      entity_key: entityKey,
      payload: { inserted, source_rows, task: entityKey },
    });

    return {
      useful: inserted > 0,
      cost_usd: 0,
      summary: { inserted, source_rows, task: entityKey },
    };
  },

  async summarize(ctx) {
    const { data } = await ctx.db
      .from("job_rows")
      .select("entity_key, status, result_summary, last_error")
      .eq("job_id", ctx.job.id);

    let inserted = 0;
    let source_rows = 0;
    const failures: string[] = [];
    const by_task: Record<string, unknown> = {};

    for (const r of data ?? []) {
      const s = (r.result_summary ?? {}) as Record<string, number>;
      inserted += Number(s.inserted ?? 0);
      source_rows += Number(s.source_rows ?? 0);
      by_task[String(r.entity_key)] = {
        status: r.status,
        inserted: s.inserted ?? 0,
        source_rows: s.source_rows ?? 0,
        error: r.last_error,
      };
      if (r.status === "failed") {
        failures.push(`${r.entity_key}: ${r.last_error ?? "failed"}`);
      }
    }

    const ok = failures.length === 0 && inserted > 0;
    return {
      useful_output_count: inserted,
      rows_inserted: inserted,
      source_rows_seen: source_rows,
      by_task,
      verification_failures: failures,
      ok,
      note: ok
        ? undefined
        : "Backfill failed or produced zero inserts — not a success.",
    };
  },
};

type Ctx = JobContext;
type CountResult = { inserted: number; source_rows: number };

function gcClient(ctx: Ctx): SupabaseClient<any, any, any> {
  return createClient(ctx.config.supabaseUrl, ctx.config.supabaseServiceKey, {
    auth: { persistSession: false },
    db: { schema: "gc" },
  }) as SupabaseClient<any, any, any>;
}

async function backfillGcCompanies(ctx: Ctx): Promise<CountResult> {
  const publicDb = gcClient(ctx);
  let inserted = 0;
  let source_rows = 0;
  let from = 0;
  const page = 500;

  for (;;) {
    const { data, error } = await publicDb
      .from("companies")
      .select("*")
      .range(from, from + page - 1);
    if (error) {
      throw new Error(
        `gc.companies: ${error.message}. Is schema "gc" exposed in Supabase API settings?`,
      );
    }
    if (!data?.length) break;
    source_rows += data.length;

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
          dm_source_tier: r.dm_source_tier,
          email_source_tier: r.email_source_tier,
          source_tier: r.source_tier,
        },
      }));

    if (rows.length) {
      // upsert in chunks
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error: upErr } = await ctx.db
          .from("companies")
          .upsert(chunk, { onConflict: "client_tag,domain" });
        if (upErr) throw new Error(`lp.companies upsert: ${upErr.message}`);
        inserted += chunk.length;
      }
    }

    if (data.length < page) break;
    from += page;
  }

  return { inserted, source_rows };
}

async function backfillGcContacts(ctx: Ctx): Promise<CountResult> {
  const publicDb = gcClient(ctx);
  let inserted = 0;
  let source_rows = 0;
  let from = 0;
  const page = 500;

  for (;;) {
    const { data, error } = await publicDb
      .from("contacts")
      .select("*")
      .range(from, from + page - 1);
    if (error) {
      throw new Error(
        `gc.contacts: ${error.message}. Is schema "gc" exposed in Supabase API settings?`,
      );
    }
    if (!data?.length) break;
    source_rows += data.length;

    const withEmail: Record<string, unknown>[] = [];
    const withoutEmail: Record<string, unknown>[] = [];

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
        metadata: { from_gc: true, place_id: r.place_id, gc_id: r.id },
      };
      if (row.email) withEmail.push(row);
      else withoutEmail.push(row);
    }

    for (let i = 0; i < withEmail.length; i += 200) {
      const chunk = withEmail.slice(i, i + 200);
      const { error: upErr } = await ctx.db
        .from("contacts")
        .upsert(chunk, { onConflict: "client_tag,domain,email" });
      if (upErr) throw new Error(`lp.contacts upsert: ${upErr.message}`);
      inserted += chunk.length;
    }

    for (const row of withoutEmail) {
      const { error: insErr } = await ctx.db.from("contacts").insert(row);
      if (!insErr) inserted += 1;
    }

    if (data.length < page) break;
    from += page;
  }

  return { inserted, source_rows };
}

/**
 * Backfill from client_<tag>.leads (canonical).
 * public.peterson_leads / public.basco_leads were dropped — do not recreate them.
 */
async function backfillClientLeads(
  ctx: Ctx,
  schema: string,
  params: BackfillParams,
): Promise<CountResult> {
  const clientDb = createClient(
    ctx.config.supabaseUrl,
    ctx.config.supabaseServiceKey,
    {
      auth: { persistSession: false },
      db: { schema },
    },
  ) as SupabaseClient<any, any, any>;

  let inserted = 0;
  let source_rows = 0;
  let from = 0;
  const page = 500;
  const byDomain = new Map<string, Record<string, unknown>>();
  const contactsWithEmail: Record<string, unknown>[] = [];

  for (;;) {
    let q = clientDb
      .from("leads")
      .select("*")
      .not("domain", "is", null)
      .neq("domain", "")
      .range(from, from + page - 1);

    if (params.icp_only === true) {
      q = q.eq("in_icp", true);
    }
    if (params.run_label) {
      q = q.eq("run_label", params.run_label);
    }

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `${schema}.leads: ${error.message}. ` +
          `Is schema "${schema}" exposed to PostgREST (Accept-Profile)?`,
      );
    }
    if (!data?.length) break;
    source_rows += data.length;

    for (const r of data) {
      const domain = String(r.domain ?? "")
        .toLowerCase()
        .trim();
      if (!domain) continue;
      byDomain.set(domain, {
        client_tag: ctx.job.client_tag,
        domain,
        company_name: (r.name ?? r.company_name ?? null) as string | null,
        source: `${schema}.leads`,
        city: (r.city as string) ?? null,
        state: (r.state as string) ?? null,
        website: (r.website as string) ?? null,
        phone: (r.phone as string) ?? null,
        address: (r.address as string) ?? null,
        in_icp: Boolean(r.in_icp),
        metadata: {
          from_client_leads: true,
          schema,
          place_id: r.place_id,
          run_label: r.run_label,
          main_category: r.main_category,
          icp_reason: r.icp_reason,
        },
      });

      const email = r.email ? String(r.email).toLowerCase().trim() : "";
      if (email) {
        const name = String(r.owner_name ?? "").trim();
        const parts = name.split(/\s+/).filter(Boolean);
        contactsWithEmail.push({
          client_tag: ctx.job.client_tag,
          domain,
          first_name: parts[0] ?? null,
          last_name: parts.length > 1 ? parts.slice(1).join(" ") : null,
          job_title: (r.owner_title as string) ?? null,
          email,
          phone: (r.phone as string) ?? null,
          source_tool: `${schema}.leads`,
          source_tier: "maps_owner",
          metadata: { place_id: r.place_id, from_client_leads: true },
        });
      }
    }

    if (data.length < page) break;
    from += page;
  }

  const companyRows = [...byDomain.values()];
  for (let i = 0; i < companyRows.length; i += 200) {
    const chunk = companyRows.slice(i, i + 200);
    const { error: upErr } = await ctx.db
      .from("companies")
      .upsert(chunk, { onConflict: "client_tag,domain" });
    if (upErr) throw new Error(`lp.companies upsert: ${upErr.message}`);
    inserted += chunk.length;
  }

  // Dedupe contacts by domain+email before upsert
  const contactByKey = new Map<string, Record<string, unknown>>();
  for (const c of contactsWithEmail) {
    contactByKey.set(`${c.domain}|${c.email}`, c);
  }
  const contactRows = [...contactByKey.values()];
  for (let i = 0; i < contactRows.length; i += 200) {
    const chunk = contactRows.slice(i, i + 200);
    const { error: upErr } = await ctx.db
      .from("contacts")
      .upsert(chunk, { onConflict: "client_tag,domain,email" });
    if (upErr) throw new Error(`lp.contacts upsert: ${upErr.message}`);
    inserted += chunk.length;
  }

  return { inserted, source_rows };
}

async function backfillOperators(
  ctx: Ctx,
  params: BackfillParams,
): Promise<CountResult> {
  const mapsUrl =
    ctx.config.mapsSupabaseUrl ??
    process.env.MAPS_SUPABASE_URL ??
    process.env.LEADS_SUPABASE_URL;
  const mapsKey =
    ctx.config.mapsSupabaseServiceKey ??
    process.env.MAPS_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.LEADS_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.MAPS_SUPABASE_ANON_KEY ??
    process.env.LEADS_SUPABASE_ANON_KEY;

  if (!mapsUrl || !mapsKey) {
    throw new Error(
      `permit_parcel.operators requires MAPS_SUPABASE_URL and MAPS_SUPABASE_SERVICE_ROLE_KEY ` +
        `(project ${PROJECT_MAPS}). gc backfill uses the primary SUPABASE_* project (${PROJECT_CI}).`,
    );
  }

  if (
    params.source_project &&
    params.source_project !== PROJECT_MAPS &&
    !params.source_project.includes("kemvxzh")
  ) {
    throw new Error(
      `source_project ${params.source_project} is not the maps project (${PROJECT_MAPS}).`,
    );
  }

  const mapsDb = createClient(mapsUrl, mapsKey, {
    auth: { persistSession: false },
    db: { schema: "permit_parcel" },
  }) as SupabaseClient<any, any, any>;

  // Prefer RPC if available (works with anon + SECURITY DEFINER)
  const segments = parseOwnerSegments(params);
  const rpc = await tryOperatorsRpc(mapsUrl, mapsKey, segments);
  if (rpc) return writeOperatorCompanies(ctx, rpc);

  // Direct table read (needs service role + exposed schema)
  let inserted = 0;
  let source_rows = 0;
  let from = 0;
  const page = 500;
  const domainCol = params.domain_column ?? "domain";
  const nameCol = params.name_column ?? "operator_name";

  for (;;) {
    let q = mapsDb
      .from("operators")
      .select("*")
      .not(domainCol, "is", null)
      .neq(domainCol, "")
      .range(from, from + page - 1);

    if (segments?.length) {
      q = q.in("owner_segment", segments);
    }

    const { data, error } = await q;
    if (error) {
      throw new Error(
        `permit_parcel.operators: ${error.message}. ` +
          `Expose schema permit_parcel on ${PROJECT_MAPS}, or set a service role key, ` +
          `or install public.lp_export_operators RPC.`,
      );
    }
    if (!data?.length) break;
    source_rows += data.length;

    const byDomain = new Map<string, Record<string, unknown>>();
    for (const r of data) {
      const domain = String(r[domainCol] ?? "")
        .toLowerCase()
        .trim();
      if (!domain) continue;
      // Last-wins within page; Postgres rejects duplicate conflict targets in one upsert.
      byDomain.set(domain, {
        client_tag: ctx.job.client_tag,
        domain,
        company_name: (r[nameCol] ?? r.business_name ?? null) as string | null,
        source: "permit_parcel.operators",
        portfolio_value: r.portfolio_value ?? null,
        segment: r.owner_segment ?? null,
        phone: r.phone ?? null,
        website: r.website ?? null,
        address: r.operator_address ?? null,
        in_icp: true,
        metadata: {
          from_operators: true,
          confidence: r.confidence,
          resolved: r.resolved,
          distinct_llcs: r.distinct_llcs,
        },
      });
    }
    const rows = [...byDomain.values()];

    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error: upErr } = await ctx.db
        .from("companies")
        .upsert(chunk, { onConflict: "client_tag,domain" });
      if (upErr) throw new Error(`lp.companies upsert: ${upErr.message}`);
      inserted += chunk.length;
    }

    if (data.length < page) break;
    from += page;
  }

  return { inserted, source_rows };
}

async function tryOperatorsRpc(
  mapsUrl: string,
  mapsKey: string,
  segments: string[] | null,
): Promise<Record<string, unknown>[] | null> {
  const publicDb = createClient(mapsUrl, mapsKey, {
    auth: { persistSession: false },
  });
  const token =
    process.env.LEADPIPE_MAPS_EXPORT_TOKEN ??
    process.env.SUPABASE_INGEST_SECRET ??
    "";

  const all: Record<string, unknown>[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const { data, error } = await publicDb.rpc("lp_export_operators", {
      p_token: token,
      p_segments: segments,
      p_offset: offset,
      p_limit: limit,
    });
    if (error) {
      // RPC missing — fall back to direct table
      if (
        /Could not find the function|PGRST202|404|does not exist/i.test(
          error.message,
        )
      ) {
        return null;
      }
      throw new Error(`lp_export_operators: ${error.message}`);
    }
    const batch = Array.isArray(data) ? data : [];
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

async function writeOperatorCompanies(
  ctx: Ctx,
  rows: Record<string, unknown>[],
): Promise<CountResult> {
  const byDomain = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const domain = String(r.domain ?? "")
      .toLowerCase()
      .trim();
    if (!domain) continue;
    byDomain.set(domain, {
      client_tag: ctx.job.client_tag,
      domain,
      company_name: (r.operator_name ?? r.business_name ?? null) as string | null,
      source: "permit_parcel.operators",
      portfolio_value: r.portfolio_value ?? null,
      segment: r.owner_segment ?? null,
      phone: r.phone ?? null,
      website: r.website ?? null,
      address: r.operator_address ?? null,
      in_icp: true,
      metadata: {
        from_operators: true,
        confidence: r.confidence,
        resolved: r.resolved,
      },
    });
  }
  const mapped = [...byDomain.values()];

  let inserted = 0;
  for (let i = 0; i < mapped.length; i += 200) {
    const chunk = mapped.slice(i, i + 200);
    const { error } = await ctx.db
      .from("companies")
      .upsert(chunk, { onConflict: "client_tag,domain" });
    if (error) throw new Error(error.message);
    inserted += chunk.length;
  }
  return { inserted, source_rows: rows.length };
}

function parseEmployeeRange(range: unknown): number | null {
  if (typeof range !== "string") return null;
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
