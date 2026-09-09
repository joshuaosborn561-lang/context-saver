/**
 * ingest_csv — free pass-through of vendor CSV/XLSX URLs into
 * lp.{client_tag}_ingested_leads. Counts only; no enrichment.
 */

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import {
  downloadIngestFile,
  parseTabularFile,
} from "../../lib/csv_download.js";
import {
  mapRawRow,
  resolveColumnMap,
  rowPassesFilters,
  type CanonicalRow,
} from "../../lib/csv_headers.js";
import {
  ingestedLeadsTableName,
  validateIngestCsvParams,
  type IngestCsvParams,
} from "../../lib/ingest_csv_params.js";

type FileSummary = {
  url_hash: string;
  url_host: string;
  ok: boolean;
  error?: string;
  content_hash?: string;
  format?: string;
  dialect?: string;
  /** Optional geo/firmographic fields that did not resolve from headers. */
  unresolved_optional?: Array<"city" | "state" | "industry" | "employee_range">;
  rows_read: number;
  rows_inserted: number;
  dupes_dropped: number;
  filtered_out: number;
  truncated?: boolean;
};

export const runIngestCsv: JobHandler = {
  async seed(ctx) {
    const v = validateIngestCsvParams(
      (ctx.job.params ?? {}) as Record<string, unknown>,
    );
    if (!v.ok) throw new Error(v.error);

    const keys = v.params.urls.map((_, i) => `url:${i}`);
    await seedEntityKeys(ctx.db, ctx.job.id, keys);
    return { rows_total: keys.length };
  },

  async processRow(ctx, entityKey) {
    const v = validateIngestCsvParams(
      (ctx.job.params ?? {}) as Record<string, unknown>,
    );
    if (!v.ok) throw new Error(v.error);
    const params = v.params;

    const idx = Number(entityKey.replace(/^url:/, ""));
    const url = params.urls[idx];
    if (!url || !Number.isFinite(idx)) {
      throw new Error(`Bad entity_key ${entityKey}`);
    }

    const url_hash = sha256Hex(url).slice(0, 32);
    const url_host = safeHost(url);

    const downloaded = await downloadIngestFile(url);
    if (!downloaded.ok) {
      await storeRawPayload(ctx.db, {
        job_id: ctx.job.id,
        vendor: "ingest_csv",
        entity_key: entityKey,
        payload: {
          url_hash,
          url_host,
          error: downloaded.error,
          status: downloaded.status ?? null,
        },
      });
      // Per-file failure — mark row done but not useful; job continues.
      return {
        useful: false,
        cost_usd: 0,
        summary: {
          url_hash,
          url_host,
          ok: false,
          error: downloaded.error,
          rows_read: 0,
          rows_inserted: 0,
          dupes_dropped: 0,
          filtered_out: 0,
        } satisfies FileSummary,
      };
    }

    const parsed = parseTabularFile(downloaded.bytes, {
      filename_hint: downloaded.filename_hint,
      content_type: downloaded.content_type,
    });
    if (!parsed.ok) {
      return {
        useful: false,
        cost_usd: 0,
        summary: {
          url_hash,
          url_host,
          ok: false,
          error: parsed.error,
          content_hash: downloaded.content_hash,
          rows_read: 0,
          rows_inserted: 0,
          dupes_dropped: 0,
          filtered_out: 0,
        } satisfies FileSummary,
      };
    }

    const resolved = resolveColumnMap(parsed.headers, params.column_map);
    if (!resolved.ok) {
      // Header failure is fatal for this file; clear message with headers.
      throw new Error(resolved.error);
    }

    const table = ingestedLeadsTableName(ctx.job.client_tag);
    await ensureIngestedLeadsTable(
      ctx.config.supabaseUrl,
      ctx.config.supabaseServiceKey,
      ctx.job.client_tag,
      params.dedupe_key,
    );

    const publicDb = createClient(
      ctx.config.supabaseUrl,
      ctx.config.supabaseServiceKey,
      { auth: { persistSession: false }, db: { schema: "lp" } },
    );

    let filtered_out = 0;
    const batchKeys = new Set<string>();
    const candidates: Array<CanonicalRow & {
      source_label: string;
      source_url_hash: string;
      content_hash: string;
    }> = [];

    for (const raw of parsed.rows) {
      const row = mapRawRow(raw, resolved.map);
      if (!rowPassesFilters(row, params.exclude_name_patterns, params.exclude_domain_list)) {
        filtered_out += 1;
        continue;
      }
      const key = dedupeValue(row, params.dedupe_key);
      if (!key) {
        filtered_out += 1;
        continue;
      }
      if (batchKeys.has(key)) {
        continue; // within-batch dupe; counted later vs inserted
      }
      batchKeys.add(key);
      candidates.push({
        ...row,
        source_label: params.source_label,
        source_url_hash: url_hash,
        content_hash: downloaded.content_hash,
      });
    }

    const withinBatchDupes = parsed.rows.length - filtered_out - candidates.length;

    const existing = await loadExistingKeys(
      publicDb,
      table,
      params.dedupe_key,
      [...batchKeys],
    );

    const toInsert = candidates.filter((r) => {
      const key = dedupeValue(r, params.dedupe_key);
      return key != null && !existing.has(key);
    });
    const dupes_dropped = withinBatchDupes + (candidates.length - toInsert.length);

    const chunkSize = 500;
    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize).map((r) => ({
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        title: r.title,
        company_name: r.company_name,
        company_domain: r.company_domain,
        city: r.city,
        state: r.state,
        industry: r.industry,
        employee_range: r.employee_range,
        source_label: r.source_label,
        source_url_hash: r.source_url_hash,
        content_hash: r.content_hash,
        ingested_at: new Date().toISOString(),
      }));
      const { error } = await publicDb.from(table).upsert(chunk, {
        onConflict: params.dedupe_key,
        ignoreDuplicates: true,
      });
      if (error) {
        throw new Error(`${table} write failed: ${error.message}`);
      }
    }
    const rows_inserted = toInsert.length;

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "ingest_csv",
      entity_key: entityKey,
      payload: {
        url_hash,
        url_host,
        content_hash: downloaded.content_hash,
        format: parsed.format,
        dialect: resolved.dialect,
        headers: resolved.headers.slice(0, 40),
        unresolved_optional: resolved.unresolved_optional,
        rows_read: parsed.rows.length,
        rows_inserted,
        dupes_dropped,
        filtered_out,
        truncated: parsed.truncated,
      },
    });

    return {
      useful: rows_inserted > 0,
      cost_usd: 0,
      summary: {
        url_hash,
        url_host,
        ok: true,
        content_hash: downloaded.content_hash,
        format: parsed.format,
        dialect: resolved.dialect,
        unresolved_optional: resolved.unresolved_optional,
        rows_read: parsed.rows.length,
        rows_inserted,
        dupes_dropped,
        filtered_out,
        truncated: parsed.truncated,
      } satisfies FileSummary,
    };
  },

  async summarize(ctx) {
    const params = (ctx.job.params ?? {}) as IngestCsvParams;
    const { data: rows, error } = await ctx.db
      .from("job_rows")
      .select("status, result_summary")
      .eq("job_id", ctx.job.id);
    if (error) throw new Error(error.message);

    const per_file: FileSummary[] = [];
    let rows_read = 0;
    let rows_inserted = 0;
    let dupes_dropped = 0;
    let filtered_out = 0;
    let files_ok = 0;
    let files_failed = 0;
    const unresolvedSeen = new Set<"city" | "state" | "industry" | "employee_range">();

    for (const r of rows ?? []) {
      const s = (r.result_summary ?? {}) as FileSummary;
      per_file.push({
        url_hash: s.url_hash ?? "",
        url_host: s.url_host ?? "",
        ok: Boolean(s.ok),
        error: s.error,
        content_hash: s.content_hash,
        format: s.format,
        dialect: s.dialect,
        unresolved_optional: s.unresolved_optional,
        rows_read: Number(s.rows_read ?? 0),
        rows_inserted: Number(s.rows_inserted ?? 0),
        dupes_dropped: Number(s.dupes_dropped ?? 0),
        filtered_out: Number(s.filtered_out ?? 0),
        truncated: s.truncated,
      });
      for (const f of s.unresolved_optional ?? []) unresolvedSeen.add(f);
      rows_read += Number(s.rows_read ?? 0);
      rows_inserted += Number(s.rows_inserted ?? 0);
      dupes_dropped += Number(s.dupes_dropped ?? 0);
      filtered_out += Number(s.filtered_out ?? 0);
      if (s.ok) files_ok += 1;
      else files_failed += 1;
    }

    const table = ingestedLeadsTableName(ctx.job.client_tag);
    const stats = await tableStats(
      ctx.config.supabaseUrl,
      ctx.config.supabaseServiceKey,
      table,
      params.source_label,
    );

    const unresolved_optional = [...unresolvedSeen];

    return {
      useful_output_count: rows_inserted,
      files_processed: (rows ?? []).length,
      files_ok,
      files_failed,
      rows_read,
      rows_inserted,
      dupes_dropped,
      filtered_out,
      unique_company_domains: stats.unique_company_domains,
      contacts_with_valid_email: stats.contacts_with_valid_email,
      table,
      source_label: params.source_label,
      unresolved_optional,
      per_file,
      note:
        unresolved_optional.length > 0
          ? `Pass-through CSV/XLSX ingest — counts only. WARNING: optional fields not mapped from headers: ${unresolved_optional.join(", ")}. Pass column_map or fix aliases.`
          : "Pass-through CSV/XLSX ingest — counts only; use lp_sample(table=ingested_leads).",
    };
  },
};

function dedupeValue(
  row: CanonicalRow,
  key: "email" | "company_domain",
): string | null {
  if (key === "email") {
    const e = (row.email ?? "").trim().toLowerCase();
    return e.includes("@") ? e : null;
  }
  const d = (row.company_domain ?? "").trim().toLowerCase();
  return d.includes(".") ? d : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

async function ensureIngestedLeadsTable(
  supabaseUrl: string,
  serviceKey: string,
  clientTag: string,
  dedupeKey: "email" | "company_domain",
): Promise<void> {
  const publicDb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { error } = await publicDb.rpc("lp_ensure_ingested_leads_table", {
    p_client_tag: clientTag,
    p_dedupe_key: dedupeKey,
  });
  if (error) {
    throw new Error(
      `ensure ingested_leads table failed: ${error.message}. ` +
        `Apply migration lp_ingest_csv_tables.`,
    );
  }
}

async function loadExistingKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  table: string,
  dedupeKey: "email" | "company_domain",
  keys: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!keys.length) return out;
  const chunkSize = 200;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const { data, error } = await db
      .from(table)
      .select(dedupeKey)
      .in(dedupeKey, chunk);
    if (error) {
      // Table may be empty / just created — treat as no existing
      if (/schema cache|does not exist|PGRST/i.test(error.message)) {
        continue;
      }
      throw new Error(`loadExistingKeys: ${error.message}`);
    }
    for (const row of data ?? []) {
      const v = String((row as Record<string, unknown>)[dedupeKey] ?? "")
        .trim()
        .toLowerCase();
      if (v) out.add(v);
    }
  }
  return out;
}

async function tableStats(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  sourceLabel: string,
): Promise<{
  unique_company_domains: number;
  contacts_with_valid_email: number;
}> {
  const publicDb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await publicDb.rpc("lp_ingested_leads_stats", {
    p_table: table,
    p_source_label: sourceLabel,
  });
  if (!error && data) {
    const d = data as {
      unique_company_domains?: number;
      contacts_with_valid_email?: number;
    };
    return {
      unique_company_domains: Number(d.unique_company_domains ?? 0),
      contacts_with_valid_email: Number(d.contacts_with_valid_email ?? 0),
    };
  }
  // Fallback via schema lp client
  const lp = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    db: { schema: "lp" },
  });
  const { count: emailCount } = await lp
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("source_label", sourceLabel)
    .not("email", "is", null);
  return {
    unique_company_domains: 0,
    contacts_with_valid_email: emailCount ?? 0,
  };
}
