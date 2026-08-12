import type { Config, EnrichTier, JobKind } from "./config.js";
import { ENRICH_TIER_ORDER, JOB_KINDS } from "./config.js";
import type { Db, JobRow } from "./db/client.js";
import {
  findIdempotentJob,
  getJob,
  hashParams,
  insertJob,
} from "./db/client.js";
import {
  estimateEnrichCost,
  estimateFindDmsCost,
  estimateVerifyCost,
} from "./lib/cost.js";
import { applyCompanyFilter, applyContactFilter, type LeadFilter } from "./lib/filters.js";
import { validateBackfillParams } from "./lib/backfill_params.js";

const SAMPLE_MAX = 10;

export interface Services {
  plan(input: {
    client_tag: string;
    goal: string;
    filters?: Partial<LeadFilter>;
    max_tier?: EnrichTier;
  }): Promise<{
    candidate_count: number;
    estimated_cost_usd: number;
    breakdown: Record<string, unknown>;
    recommended_kind: JobKind | null;
    notes: string[];
  }>;

  run(input: {
    job_kind: JobKind;
    client_tag: string;
    params?: Record<string, unknown>;
    approve_cost_usd?: number;
  }): Promise<{
    job_id: string;
    status: string;
    estimated_cost_usd: number;
    attached_existing?: boolean;
    error?: string;
  }>;

  status(jobId: string): Promise<{
    status: string;
    rows_done: number;
    rows_total: number;
    rows_failed: number;
    pct: number;
    eta_seconds: number | null;
    useful_output_count: number | null;
    cost_actual_usd: number | null;
    cost_estimate_usd: number | null;
    results_summary: Record<string, unknown>;
    error: string | null;
  }>;

  inventory(
    clientTag: string,
    scope?: string,
  ): Promise<{
    companies: number;
    contacts: number;
    with_email: number;
    dm_grade: number;
    suppressed: number;
    by_source_tier: Record<string, number>;
    gaps: Record<string, number>;
  }>;

  sample(input: {
    client_tag: string;
    filter?: Partial<LeadFilter>;
    n?: number;
    table?: "contacts" | "companies";
  }): Promise<{ rows: Record<string, unknown>[]; n: number; capped_at: number }>;

  export(input: {
    client_tag: string;
    filter?: Partial<LeadFilter>;
    format?: "csv" | "jsonl";
  }): Promise<{ signed_url: string; row_count: number; export_id: string; expires_at: string }>;
}

export function createServices(db: Db, config: Config): Services {
  return {
    async plan(input) {
      const filters: LeadFilter = {
        client_tag: input.client_tag,
        ...input.filters,
      };
      const goal = input.goal.toLowerCase();
      const notes: string[] = [];
      let recommended: JobKind | null = null;
      let candidate_count = 0;
      let estimate = {
        estimated_cost_usd: 0,
        breakdown: {} as Record<string, unknown>,
        notes: [] as string[],
      };

      if (goal.includes("dm") || goal.includes("decision") || goal.includes("title")) {
        recommended = "find_dms_by_title";
        candidate_count = await countCompaniesMissingDm(db, input.client_tag);
        const e = estimateFindDmsCost(config, candidate_count);
        estimate = { ...e, breakdown: e.breakdown };
        notes.push(...e.notes);
        notes.push(
          "candidate_count = companies lacking a DM-grade contact with email.",
        );
      } else if (goal.includes("enrich") || goal.includes("email")) {
        recommended = "enrich_contacts";
        const f = { ...filters, missing_email: true };
        candidate_count = await countContacts(db, f);
        const maxTier = input.max_tier ?? "leadmagic";
        const e = estimateEnrichCost(config, candidate_count, maxTier);
        estimate = { ...e, breakdown: e.breakdown };
        notes.push(...e.notes);
      } else if (goal.includes("verif")) {
        recommended = "verify_emails";
        const f = { ...filters, has_email: true };
        candidate_count = await countContacts(db, f);
        const e = estimateVerifyCost(config, candidate_count);
        estimate = { ...e, breakdown: e.breakdown };
        notes.push(...e.notes);
      } else if (goal.includes("resolv") || goal.includes("domain")) {
        recommended = "resolve_companies";
        candidate_count = await countCompanies(db, {
          ...filters,
          unresolved_domain: true,
        });
        const unit = config.costs.resolve_serp ?? 0.01;
        estimate = {
          estimated_cost_usd: +(candidate_count * unit).toFixed(4),
          breakdown: {
            serp_resolve: {
              count: candidate_count,
              unit_cost_usd: unit,
              subtotal_usd: +(candidate_count * unit).toFixed(4),
            },
          },
          notes: ["SERP-first resolution; Maps-only is disabled."],
        };
        notes.push(...estimate.notes);
      } else if (
        goal.includes("requeue") ||
        goal.includes("import") ||
        goal.includes("restore")
      ) {
        recommended = "import_smartlead";
        const campaigns =
          (input.filters as { campaigns?: unknown[] } | undefined)?.campaigns ??
          [];
        candidate_count = Array.isArray(campaigns) ? campaigns.length : 0;
        estimate = {
          estimated_cost_usd: 0,
          breakdown: {},
          notes: [
            "Upload _clean.json files to storage first.",
            "Pass campaigns[{ campaign_id, storage_path, expected_upload, expected_final_count }].",
            "Asserts upload_count===sent, block_count===0, then live membership===expected_final_count.",
            "Leads never enter chat context.",
          ],
        };
        notes.push(...estimate.notes);
      } else if (goal.includes("suppress") || goal.includes("smartlead")) {
        recommended = goal.includes("suppress") ? "build_suppression" : "sync_smartlead";
        candidate_count = 0;
        estimate = {
          estimated_cost_usd: 0,
          breakdown: {},
          notes: ["Pass campaign_ids / emails in lp_run params."],
        };
        notes.push(...estimate.notes);
      } else {
        notes.push(
          `Could not map goal to a job kind. Valid kinds: ${JOB_KINDS.join(", ")}`,
        );
        candidate_count = await countContacts(db, filters);
      }

      return {
        candidate_count,
        estimated_cost_usd: estimate.estimated_cost_usd,
        breakdown: estimate.breakdown,
        recommended_kind: recommended,
        notes,
      };
    },

    async run(input) {
      if (!JOB_KINDS.includes(input.job_kind)) {
        throw new Error(`Unknown job_kind: ${input.job_kind}`);
      }

      const params = sanitizeParams(input.job_kind, input.params ?? {});
      const params_hash = hashParams({ ...params, client_tag: input.client_tag });

      const existing = await findIdempotentJob(
        db,
        input.client_tag,
        input.job_kind,
        params_hash,
      );
      if (existing && existing.status !== "failed" && existing.status !== "cost_blocked") {
        return {
          job_id: existing.id,
          status: existing.status,
          estimated_cost_usd: Number(existing.cost_estimate_usd ?? 0),
          attached_existing: true,
        };
      }

      const estimate = await estimateForKind(
        db,
        config,
        input.job_kind,
        input.client_tag,
        params,
      );

      // approve_cost_usd is a hard spend ceiling during execution, not a
      // "must cover the full-universe estimate" gate. Jobs start and stop
      // when actual spend exceeds the ceiling (runner uses strict >).
      const ceiling =
        input.approve_cost_usd ?? config.defaultCostCeilingUsd;
      if (!(ceiling >= 0) || !Number.isFinite(ceiling)) {
        throw new Error(`Invalid approve_cost_usd / ceiling: ${ceiling}`);
      }

      const job = await insertJob(db, {
        client_tag: input.client_tag,
        kind: input.job_kind,
        params,
        params_hash,
        cost_estimate_usd: estimate.estimated_cost_usd,
        cost_ceiling_usd: ceiling,
        status: "queued",
      });

      return {
        job_id: job.id,
        status: job.status,
        estimated_cost_usd: estimate.estimated_cost_usd,
        ...(estimate.estimated_cost_usd > ceiling
          ? {
              error:
                `Note: estimate $${estimate.estimated_cost_usd.toFixed(4)} > ceiling $${ceiling.toFixed(4)}; ` +
                `job will run until the ceiling is hit then stop as cost_blocked.`,
            }
          : {}),
      };
    },

    async status(jobId) {
      const job = await getJob(db, jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);

      const pct =
        job.rows_total > 0
          ? Math.min(100, +((job.rows_done / job.rows_total) * 100).toFixed(2))
          : job.status === "completed"
            ? 100
            : 0;

      const useful =
        typeof job.results_summary?.useful_output_count === "number"
          ? (job.results_summary.useful_output_count as number)
          : null;

      const eta = estimateEta(job);

      return {
        status: job.status,
        rows_done: job.rows_done,
        rows_total: job.rows_total,
        rows_failed: job.rows_failed,
        pct,
        eta_seconds: eta,
        useful_output_count: useful,
        cost_actual_usd: job.cost_actual_usd,
        cost_estimate_usd: job.cost_estimate_usd,
        results_summary: job.results_summary ?? {},
        error: job.error,
      };
    },

    async inventory(clientTag, _scope) {
      // Prefer SQL aggregate — never pull contact rows into the worker for counts
      const { createClient } = await import("@supabase/supabase-js");
      const publicDb = createClient(config.supabaseUrl, config.supabaseServiceKey, {
        auth: { persistSession: false },
      });
      const { data, error } = await publicDb.rpc("lp_inventory_for", {
        p_client_tag: clientTag,
      });
      if (!error && data) {
        return data as {
          companies: number;
          contacts: number;
          with_email: number;
          dm_grade: number;
          suppressed: number;
          by_source_tier: Record<string, number>;
          gaps: Record<string, number>;
        };
      }

      // Fallback count queries if RPC missing
      const companies = await countCompanies(db, { client_tag: clientTag });
      const contacts = await countContacts(db, { client_tag: clientTag });
      const with_email = await countContacts(db, {
        client_tag: clientTag,
        has_email: true,
      });
      const dm_grade = await countContacts(db, {
        client_tag: clientTag,
        is_dm: true,
      });
      const suppressed = await countContacts(db, {
        client_tag: clientTag,
        suppressed: true,
      });
      const missing_email = await countContacts(db, {
        client_tag: clientTag,
        missing_email: true,
      });
      const dm_missing_email = await countContacts(db, {
        client_tag: clientTag,
        is_dm: true,
        missing_email: true,
      });
      const unresolved = await countCompanies(db, {
        client_tag: clientTag,
        unresolved_domain: true,
      });

      return {
        companies,
        contacts,
        with_email,
        dm_grade,
        suppressed,
        by_source_tier: {},
        gaps: {
          missing_email,
          dm_missing_email,
          unresolved_companies: unresolved,
        },
      };
    },

    async sample(input) {
      const n = Math.min(Math.max(input.n ?? 5, 1), SAMPLE_MAX);
      const table = input.table ?? "contacts";
      const filter: LeadFilter = {
        client_tag: input.client_tag,
        ...input.filter,
      };

      if (table === "companies") {
        let q = db.from("companies").select(
          "id, domain, company_name, source, segment, in_icp, employee_count, city, state",
        );
        q = applyCompanyFilter(q, filter);
        const { data, error } = await q.limit(n);
        if (error) throw new Error(error.message);
        return { rows: data ?? [], n: (data ?? []).length, capped_at: SAMPLE_MAX };
      }

      let q = db.from("contacts").select(
        "id, domain, first_name, last_name, job_title, email, email_status, source_tier, source_tool, is_dm, suppressed",
      );
      q = applyContactFilter(q, filter);
      const { data, error } = await q.limit(n);
      if (error) throw new Error(error.message);
      return { rows: data ?? [], n: (data ?? []).length, capped_at: SAMPLE_MAX };
    },

    async export(input) {
      const format = input.format ?? "csv";
      const filter: LeadFilter = {
        client_tag: input.client_tag,
        ...input.filter,
      };

      // Stream contacts in pages into a string — never return content to MCP caller
      const rows: Record<string, unknown>[] = [];
      let from = 0;
      const page = 1000;
      for (;;) {
        let q = db
          .from("contacts")
          .select(
            "domain, first_name, last_name, job_title, email, email_status, phone, linkedin_url, source_tier, source_tool, is_dm, suppressed",
          );
        q = applyContactFilter(q, filter);
        const { data, error } = await q.range(from, from + page - 1);
        if (error) throw new Error(error.message);
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < page) break;
        from += page;
      }

      const body =
        format === "jsonl"
          ? rows.map((r) => JSON.stringify(r)).join("\n")
          : toCsv(rows);

      const exportId = crypto.randomUUID();
      const path = `${input.client_tag}/${exportId}.${format === "jsonl" ? "jsonl" : "csv"}`;
      const expiresAt = new Date(
        Date.now() + config.exportTtlSeconds * 1000,
      ).toISOString();

      // Ensure bucket exists (ignore error if already present)
      await db.storage.createBucket(config.exportBucket, { public: false }).catch(() => undefined);

      const { error: upErr } = await db.storage
        .from(config.exportBucket)
        .upload(path, body, {
          contentType: format === "jsonl" ? "application/x-ndjson" : "text/csv",
          upsert: true,
        });

      if (upErr) {
        // Fallback: store path reference even if storage upload fails in local/dev
        await db.from("exports").insert({
          id: exportId,
          client_tag: input.client_tag,
          filter,
          format,
          row_count: rows.length,
          storage_path: path,
          expires_at: expiresAt,
        });
        throw new Error(
          `Export upload failed (${upErr.message}). Ensure storage bucket '${config.exportBucket}' exists. Row count would have been ${rows.length}.`,
        );
      }

      const { data: signed, error: signErr } = await db.storage
        .from(config.exportBucket)
        .createSignedUrl(path, config.exportTtlSeconds);

      if (signErr || !signed?.signedUrl) {
        throw new Error(signErr?.message ?? "Failed to create signed URL");
      }

      await db.from("exports").insert({
        id: exportId,
        client_tag: input.client_tag,
        filter,
        format,
        row_count: rows.length,
        storage_path: path,
        expires_at: expiresAt,
      });

      return {
        signed_url: signed.signedUrl,
        row_count: rows.length,
        export_id: exportId,
        expires_at: expiresAt,
      };
    },
  };
}

async function countContacts(db: Db, filter: LeadFilter): Promise<number> {
  let q = db.from("contacts").select("id", { count: "exact", head: true });
  q = applyContactFilter(q, filter);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function countCompanies(db: Db, filter: LeadFilter): Promise<number> {
  let q = db.from("companies").select("id", { count: "exact", head: true });
  q = applyCompanyFilter(q, filter);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Companies with no DM-grade emailed contact — what find_dms_by_title will seed. */
async function countCompaniesMissingDm(
  db: Db,
  clientTag: string,
): Promise<number> {
  const { data: companies, error } = await db
    .from("companies")
    .select("domain")
    .eq("client_tag", clientTag)
    .not("domain", "is", null);
  if (error) throw new Error(error.message);
  const { data: haveDm, error: e2 } = await db
    .from("contacts")
    .select("domain")
    .eq("client_tag", clientTag)
    .eq("is_dm", true)
    .not("email", "is", null);
  if (e2) throw new Error(e2.message);
  const have = new Set(
    (haveDm ?? []).map((r) => String(r.domain ?? "").toLowerCase()),
  );
  return (companies ?? []).filter(
    (c) => c.domain && !have.has(String(c.domain).toLowerCase()),
  ).length;
}

function sanitizeParams(
  kind: JobKind,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...params };
  if (kind === "enrich_contacts") {
    const max = String(out.max_tier ?? "leadmagic");
    if (!ENRICH_TIER_ORDER.includes(max as EnrichTier)) {
      throw new Error(`Invalid max_tier: ${max}`);
    }
    out.max_tier = max;
    if (String(out.vendor ?? "").toLowerCase().includes("pdl")) {
      throw new Error("People Data Labs is forbidden");
    }
  }
  if (kind === "backfill") {
    const v = validateBackfillParams(out);
    if (!v.ok) throw new Error(v.error);
  }
  return out;
}

async function estimateForKind(
  db: Db,
  config: Config,
  kind: JobKind,
  clientTag: string,
  params: Record<string, unknown>,
): Promise<{ estimated_cost_usd: number }> {
  switch (kind) {
    case "find_dms_by_title": {
      const domains = (params.domains as string[] | undefined) ?? [];
      const count =
        domains.length || (await countCompaniesMissingDm(db, clientTag));
      return estimateFindDmsCost(config, count);
    }
    case "enrich_contacts": {
      let count = 0;
      if (Array.isArray(params.contact_ids)) {
        count = params.contact_ids.length;
      } else {
        count = await countContacts(db, {
          client_tag: clientTag,
          missing_email: true,
          is_dm: params.is_dm === true ? true : undefined,
          domains: params.domains as string[] | undefined,
        });
      }
      return estimateEnrichCost(
        config,
        count,
        (params.max_tier as EnrichTier) ?? "leadmagic",
      );
    }
    case "verify_emails": {
      const count = Array.isArray(params.contact_ids)
        ? params.contact_ids.length
        : await countContacts(db, { client_tag: clientTag, has_email: true });
      return estimateVerifyCost(config, count);
    }
    case "resolve_companies": {
      const count = Array.isArray(params.company_ids)
        ? params.company_ids.length
        : await countCompanies(db, {
            client_tag: clientTag,
            unresolved_domain: true,
          });
      const unit = config.costs.resolve_serp ?? 0.01;
      return { estimated_cost_usd: +(count * unit).toFixed(4) };
    }
    case "sync_smartlead":
    case "import_smartlead":
    case "build_suppression":
    case "backfill":
      return { estimated_cost_usd: 0 };
    default:
      return { estimated_cost_usd: 0 };
  }
}

function estimateEta(job: JobRow): number | null {
  if (!job.started_at || job.rows_done <= 0 || job.rows_total <= job.rows_done) {
    return job.status === "completed" ? 0 : null;
  }
  const elapsed = Date.now() - new Date(job.started_at).getTime();
  const perRow = elapsed / job.rows_done;
  const remaining = job.rows_total - job.rows_done;
  return Math.round((remaining * perRow) / 1000);
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => escape(r[c])).join(",")),
  ].join("\n");
}
