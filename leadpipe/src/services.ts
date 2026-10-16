import type { Config, JobKind } from "./config.js";
import { JOB_KINDS } from "./config.js";
import type { Db, JobRow } from "./db/client.js";
import {
  findIdempotentJob,
  getJob,
  hashParams,
  insertJob,
} from "./db/client.js";
import { applyCompanyFilter, applyContactFilter, type LeadFilter } from "./lib/filters.js";
import { validateBackfillParams } from "./lib/backfill_params.js";
import { validateIngestSerpParams } from "./lib/ingest_serp_params.js";
import {
  ingestedLeadsTableName,
  validateIngestCsvParams,
} from "./lib/ingest_csv_params.js";
import { resolveExportWhere, toCsv } from "./lib/csv_format.js";
import { assertClientTag } from "./lib/client_tag.js";
import { createClient } from "@supabase/supabase-js";

const SAMPLE_MAX = 10;

export interface Services {
  plan(input: {
    client_tag: string;
    goal: string;
    filters?: Partial<LeadFilter>;
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
    /** Bypass idempotency — always enqueue a new job (same params_hash). */
    force?: boolean;
  }): Promise<{
    job_id: string;
    status: string;
    estimated_cost_usd: number;
    attached_existing?: boolean;
    error?: string;
    client_ensured?: Record<string, unknown>;
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
    notes?: string[];
  }>;

  sample(input: {
    client_tag: string;
    filter?: Partial<LeadFilter>;
    n?: number;
    table?: "contacts" | "companies" | "ingested_leads";
  }): Promise<{ rows: Record<string, unknown>[]; n: number; capped_at: number }>;

  export(input: {
    client_tag: string;
    filter?: Partial<LeadFilter>;
    format?: "csv" | "jsonl";
    table?: "contacts" | "ingested_leads";
    /** Exact columns to export. Omit = every live column on the table. */
    columns?: string[];
    /** Equality predicates, e.g. { ev_status: "sendable" }. */
    where?: Record<string, unknown>;
    /** Simple filter_sql: "ev_status = 'sendable'" (AND-chained equalities). */
    filter_sql?: string;
  }): Promise<{ signed_url: string; row_count: number; export_id: string; expires_at: string }>;

  /** Provision client_<tag> schema + registry row. Idempotent. */
  ensureClient(input: {
    client_tag: string;
    display_name?: string;
  }): Promise<Record<string, unknown>>;

  /** List registered clients (tags only — no lead payloads). */
  listClients(): Promise<{ clients: Array<Record<string, unknown>>; n: number }>;
}

export function createServices(db: Db, config: Config): Services {
  const publicDb = () =>
    createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false },
    });

  return {
    async ensureClient(input) {
      const tag = assertClientTag(input.client_tag);
      return ensureClientRpc(config, tag, input.display_name);
    },

    async listClients() {
      const { data, error } = await publicDb().rpc("lp_list_clients");
      if (error) {
        // Fallback: distinct tags from lp.companies / contacts
        const tags = new Set<string>();
        for (const table of ["companies", "contacts"] as const) {
          const { data: rows } = await db.from(table).select("client_tag");
          for (const r of rows ?? []) {
            if (r?.client_tag) tags.add(String(r.client_tag));
          }
        }
        const clients = [...tags].sort().map((client_tag) => ({ client_tag }));
        return { clients, n: clients.length };
      }
      const clients = Array.isArray(data) ? data : [];
      return {
        clients: clients as Array<Record<string, unknown>>,
        n: clients.length,
      };
    },

    async plan(input) {
      const client_tag = assertClientTag(input.client_tag);
      const filters: LeadFilter = {
        client_tag,
        ...input.filters,
      };
      const goal = input.goal.toLowerCase();
      const notes: string[] = [
        "LeadPipe is a pass-through: jobs move data server-side so chat never carries payloads.",
        "No enrichment strategy. No paid vendor lookups.",
        `Job kinds: ${JOB_KINDS.join(", ")}.`,
        "New client? lp_ensure_client({ client_tag }) — also auto-runs on lp_run.",
      ];
      let recommended: JobKind | null = null;
      let candidate_count = 0;

      if (
        goal.includes("new client") ||
        goal.includes("ensure client") ||
        goal.includes("add client") ||
        goal.includes("create client")
      ) {
        notes.push(
          "Use lp_ensure_client — not a job. Creates client_<tag> schema (leads/companies/contacts).",
        );
      } else if (
        goal.includes("requeue") ||
        goal.includes("import_smartlead") ||
        (goal.includes("import") && goal.includes("smartlead")) ||
        goal.includes("restore")
      ) {
        recommended = "import_smartlead";
        const campaigns =
          (input.filters as { campaigns?: unknown[] } | undefined)?.campaigns ??
          [];
        candidate_count = Array.isArray(campaigns) ? campaigns.length : 0;
        notes.push("Pass campaigns[{ campaign_id, storage_path, expected_upload, expected_final_count }].");
      } else if (goal.includes("suppress")) {
        recommended = "build_suppression";
      } else if (goal.includes("smartlead") || goal.includes("sync")) {
        recommended = "sync_smartlead";
      } else if (goal.includes("backfill")) {
        recommended = "backfill";
        notes.push(
          "source: client tag (e.g. 'basco') → client_<tag>.leads, or 'gc' / 'permit_parcel.operators'.",
        );
      } else if (
        goal.includes("csv") ||
        goal.includes("xlsx") ||
        goal.includes("spreadsheet") ||
        goal.includes("ingest_csv") ||
        (goal.includes("ingest") &&
          (goal.includes("url") ||
            goal.includes("getleads") ||
            goal.includes("file") ||
            goal.includes("export")))
      ) {
        recommended = "ingest_csv";
        notes.push(
          "Params: urls[] + source_label. Optional column_map, dedupe_key, exclude_* filters.",
        );
      } else if (
        goal.includes("ingest") ||
        goal.includes("apify") ||
        goal.includes("serp") ||
        goal.includes("linkedin") ||
        goal.includes("persona")
      ) {
        recommended = "ingest_serp";
        notes.push("Params: storage_paths|apify_run_ids + target_titles + persona.");
      } else {
        notes.push("Could not map goal — pass job_kind explicitly to lp_run.");
        candidate_count = await countContacts(db, filters);
      }

      return {
        candidate_count,
        estimated_cost_usd: 0,
        breakdown: {},
        recommended_kind: recommended,
        notes,
      };
    },

    async run(input) {
      if (!JOB_KINDS.includes(input.job_kind)) {
        throw new Error(`Unknown job_kind: ${input.job_kind}`);
      }

      const client_tag = assertClientTag(input.client_tag);
      // Auto-provision client schema so new tags work without a manual step.
      const client_ensured = await ensureClientRpc(config, client_tag);

      const params = sanitizeParams(input.job_kind, input.params ?? {});
      const params_hash = hashParams({ ...params, client_tag });

      if (!input.force) {
        const existing = await findIdempotentJob(
          db,
          client_tag,
          input.job_kind,
          params_hash,
        );
        if (existing && existing.status !== "failed" && existing.status !== "cost_blocked") {
          return {
            job_id: existing.id,
            status: existing.status,
            estimated_cost_usd: Number(existing.cost_estimate_usd ?? 0),
            attached_existing: true,
            client_ensured,
          };
        }
      }

      const estimate = await estimateForKind(
        db,
        config,
        input.job_kind,
        client_tag,
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
        client_tag,
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
        client_ensured,
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
      const tag = assertClientTag(clientTag);
      // Prefer SQL aggregate — never pull contact rows into the worker for counts
      const { data, error } = await publicDb().rpc("lp_inventory_for", {
        p_client_tag: tag,
      });
      const freePathNotes = [
        "Counts only. LeadPipe does not look up or enrich people.",
        "To load SERP/Apify people: lp_run(ingest_serp). CSV/XLSX URLs: lp_run(ingest_csv). Rooftops: lp_run(backfill).",
        "New client: lp_ensure_client({ client_tag }) — also auto on lp_run.",
      ];
      if (!error && data) {
        return {
          ...(data as {
            companies: number;
            contacts: number;
            with_email: number;
            dm_grade: number;
            suppressed: number;
            ingested_leads?: number;
            by_source_tier: Record<string, number>;
            gaps: Record<string, number>;
          }),
          notes: freePathNotes,
        };
      }

      // Fallback count queries if RPC missing
      const companies = await countCompanies(db, { client_tag: tag });
      const contacts = await countContacts(db, { client_tag: tag });
      const with_email = await countContacts(db, {
        client_tag: tag,
        has_email: true,
      });
      const dm_grade = await countContacts(db, {
        client_tag: tag,
        is_dm: true,
      });
      const suppressed = await countContacts(db, {
        client_tag: tag,
        suppressed: true,
      });
      const missing_email = await countContacts(db, {
        client_tag: tag,
        missing_email: true,
      });
      const dm_missing_email = await countContacts(db, {
        client_tag: tag,
        is_dm: true,
        missing_email: true,
      });
      const unresolved = await countCompanies(db, {
        client_tag: tag,
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
        notes: freePathNotes,
      };
    },

    async sample(input) {
      const client_tag = assertClientTag(input.client_tag);
      const n = Math.min(Math.max(input.n ?? 5, 1), SAMPLE_MAX);
      const table = input.table ?? "contacts";
      const filter: LeadFilter = {
        client_tag,
        ...input.filter,
      };

      if (table === "ingested_leads") {
        const tname = ingestedLeadsTableName(client_tag);
        const { data, error } = await db
          .from(tname)
          .select(
            "first_name, last_name, email, title, company_name, company_domain, city, state, industry, employee_range, source_label, ingested_at",
          )
          .order("ingested_at", { ascending: false })
          .limit(n);
        if (error) throw new Error(error.message);
        return { rows: data ?? [], n: (data ?? []).length, capped_at: SAMPLE_MAX };
      }

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
      const client_tag = assertClientTag(input.client_tag);
      const format = input.format ?? "csv";
      const filter: LeadFilter = {
        client_tag,
        ...input.filter,
      };
      const exportTable = input.table ?? "contacts";
      const tname =
        exportTable === "ingested_leads"
          ? ingestedLeadsTableName(client_tag)
          : "contacts";

      const liveColumns = await listTableColumns(config, "lp", tname);
      if (!liveColumns.length) {
        throw new Error(`No columns found for lp.${tname}`);
      }

      let columns: string[];
      if (input.columns != null) {
        if (!Array.isArray(input.columns) || input.columns.length === 0) {
          throw new Error(
            "lp_export columns must be a non-empty string array when provided",
          );
        }
        columns = input.columns.map((c) => String(c).trim()).filter(Boolean);
        const liveSet = new Set(liveColumns);
        const missing = columns.filter((c) => !liveSet.has(c));
        if (missing.length) {
          throw new Error(
            `lp_export columns not found on lp.${tname}: ${missing.join(", ")}. ` +
              `Live columns: ${liveColumns.join(", ")}`,
          );
        }
      } else {
        columns = liveColumns;
      }

      const whereRes = resolveExportWhere(input.where, input.filter_sql);
      if (!whereRes.ok) throw new Error(whereRes.error);
      const wherePreds = whereRes.preds;
      if (Object.keys(wherePreds).length) {
        const liveSet = new Set(liveColumns);
        const bad = Object.keys(wherePreds).filter((c) => !liveSet.has(c));
        if (bad.length) {
          throw new Error(
            `lp_export where/filter_sql columns not found on lp.${tname}: ${bad.join(", ")}`,
          );
        }
      }

      const selectList = columns.join(", ");

      // Stream rows in pages into a string — never return content to MCP caller
      const rows: Record<string, unknown>[] = [];
      let from = 0;
      const page = 1000;
      for (;;) {
        let q = db.from(tname).select(selectList);
        if (exportTable === "ingested_leads") {
          q = q.order("ingested_at", { ascending: false });
        } else {
          q = applyContactFilter(q, filter);
        }
        for (const [col, val] of Object.entries(wherePreds)) {
          if (val === null) q = q.is(col, null);
          else q = q.eq(col, val);
        }
        const res = await q.range(from, from + page - 1);
        if (res.error) throw new Error(res.error.message);
        const data =
          (res.data as unknown as Record<string, unknown>[] | null) ?? null;
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < page) break;
        from += page;
      }

      const body =
        format === "jsonl"
          ? rows.map((r) => JSON.stringify(pickColumns(r, columns))).join("\n")
          : toCsv(rows, columns);

      const exportId = crypto.randomUUID();
      const path = `${client_tag}/${exportId}.${format === "jsonl" ? "jsonl" : "csv"}`;
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
          client_tag,
          filter: {
            ...filter,
            columns,
            where: wherePreds,
            table: exportTable,
          },
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
        client_tag,
        filter: {
          ...filter,
          columns,
          where: wherePreds,
          table: exportTable,
        },
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

async function listTableColumns(
  config: Config,
  schema: string,
  table: string,
): Promise<string[]> {
  const publicDb = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await publicDb.rpc("lp_table_columns", {
    p_schema: schema,
    p_table: table,
  });
  if (error) {
    throw new Error(
      `lp_table_columns failed: ${error.message}. Apply migration ingested_leads_city_and_export_columns.`,
    );
  }
  if (!Array.isArray(data)) return [];
  return data.map((c) => String(c));
}

function pickColumns(
  row: Record<string, unknown>,
  columns: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

async function ensureClientRpc(
  config: Config,
  clientTag: string,
  displayName?: string,
): Promise<Record<string, unknown>> {
  const db = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.rpc("lp_ensure_client", {
    p_client_tag: clientTag,
    p_display_name: displayName ?? null,
  });
  if (error) {
    throw new Error(
      `lp_ensure_client failed: ${error.message}. Apply migration ensure_client.`,
    );
  }
  return (data as Record<string, unknown>) ?? { client_tag: clientTag, ok: true };
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

function sanitizeParams(
  kind: JobKind,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...params };
  if (kind === "backfill") {
    const v = validateBackfillParams(out);
    if (!v.ok) throw new Error(v.error);
  }
  if (kind === "ingest_serp") {
    const v = validateIngestSerpParams(out);
    if (!v.ok) throw new Error(v.error);
    out.apify_run_ids = v.params.apify_run_ids;
    out.apify_dataset_ids = v.params.apify_dataset_ids;
    out.storage_paths = v.params.storage_paths;
    out.target_titles = v.params.target_titles;
    out.persona = v.params.persona;
    out.require_company_match = v.params.require_company_match !== false;
    delete out.run_ids;
    delete out.dataset_ids;
  }
  if (kind === "ingest_csv") {
    const v = validateIngestCsvParams(out);
    if (!v.ok) throw new Error(v.error);
    out.urls = v.params.urls;
    out.source_label = v.params.source_label;
    out.dedupe_key = v.params.dedupe_key;
    out.exclude_name_patterns = v.params.exclude_name_patterns;
    out.exclude_domain_list = v.params.exclude_domain_list;
    if (v.params.column_map) out.column_map = v.params.column_map;
    else delete out.column_map;
  }
  return out;
}

async function estimateForKind(
  _db: Db,
  _config: Config,
  _kind: JobKind,
  _clientTag: string,
  _params: Record<string, unknown>,
): Promise<{ estimated_cost_usd: number }> {
  return { estimated_cost_usd: 0 };
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
