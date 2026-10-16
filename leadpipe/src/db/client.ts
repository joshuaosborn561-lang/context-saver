import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.js";

// Schema is `lp` (not public); loosen generics so callers stay simple.
export type Db = SupabaseClient<any, "lp", any>;

export function createDb(config: Config): Db {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "lp" },
  }) as Db;
}

/** Stable hash for idempotent job attachment. */
export function hashParams(params: unknown): string {
  const normalized = JSON.stringify(sortKeys(params));
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeys(obj[k]);
    }
    return out;
  }
  return value;
}

export interface JobRow {
  id: string;
  client_tag: string;
  kind: string;
  params: Record<string, unknown>;
  params_hash: string;
  status: string;
  rows_total: number;
  rows_done: number;
  rows_failed: number;
  results_summary: Record<string, unknown>;
  cost_estimate_usd: number | null;
  cost_actual_usd: number | null;
  credits_used: number | null;
  cost_ceiling_usd: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
}

export interface JobProgressRow {
  id: string;
  job_id: string;
  entity_key: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result_summary: Record<string, unknown>;
  cost_usd: number;
}

export async function findIdempotentJob(
  db: Db,
  clientTag: string,
  kind: string,
  paramsHash: string,
): Promise<JobRow | null> {
  const { data, error } = await db
    .from("jobs")
    .select("*")
    .eq("client_tag", clientTag)
    .eq("kind", kind)
    .eq("params_hash", paramsHash)
    .in("status", ["queued", "running", "interrupted", "completed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`findIdempotentJob: ${error.message}`);
  return data as JobRow | null;
}

export async function insertJob(
  db: Db,
  input: {
    client_tag: string;
    kind: string;
    params: Record<string, unknown>;
    params_hash: string;
    cost_estimate_usd: number;
    cost_ceiling_usd: number;
    status?: string;
    error?: string;
  },
): Promise<JobRow> {
  const { data, error } = await db
    .from("jobs")
    .insert({
      client_tag: input.client_tag,
      kind: input.kind,
      params: input.params,
      params_hash: input.params_hash,
      cost_estimate_usd: input.cost_estimate_usd,
      cost_ceiling_usd: input.cost_ceiling_usd,
      status: input.status ?? "queued",
      error: input.error ?? null,
    })
    .select("*")
    .single();

  if (error) throw new Error(`insertJob: ${error.message}`);
  return data as JobRow;
}

export async function getJob(db: Db, jobId: string): Promise<JobRow | null> {
  const { data, error } = await db
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`getJob: ${error.message}`);
  return data as JobRow | null;
}

export async function updateJob(
  db: Db,
  jobId: string,
  patch: Partial<JobRow>,
): Promise<void> {
  const { error } = await db.from("jobs").update(patch).eq("id", jobId);
  if (error) throw new Error(`updateJob: ${error.message}`);
}

export async function claimQueuedJobs(
  db: Db,
  limit = 1,
): Promise<JobRow[]> {
  // Prefer interrupted/queued; revive stale heartbeats as interrupted
  const staleBefore = new Date(Date.now() - 90_000).toISOString();
  await db
    .from("jobs")
    .update({ status: "interrupted" })
    .eq("status", "running")
    .lt("heartbeat_at", staleBefore);

  const { data, error } = await db
    .from("jobs")
    .select("*")
    .in("status", ["queued", "interrupted"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`claimQueuedJobs: ${error.message}`);
  return (data ?? []) as JobRow[];
}

export async function upsertJobRows(
  db: Db,
  jobId: string,
  entityKeys: string[],
): Promise<number> {
  if (entityKeys.length === 0) return 0;
  const rows = entityKeys.map((entity_key) => ({
    job_id: jobId,
    entity_key,
    status: "pending",
  }));
  // Insert ignoring conflicts so resume keeps done rows
  const { error } = await db.from("job_rows").upsert(rows, {
    onConflict: "job_id,entity_key",
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`upsertJobRows: ${error.message}`);
  return entityKeys.length;
}

export async function fetchPendingJobRows(
  db: Db,
  jobId: string,
  limit: number,
): Promise<JobProgressRow[]> {
  const { data, error } = await db
    .from("job_rows")
    .select("*")
    .eq("job_id", jobId)
    .in("status", ["pending", "failed"])
    .lt("attempts", 3)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`fetchPendingJobRows: ${error.message}`);
  return (data ?? []) as JobProgressRow[];
}

export async function markJobRow(
  db: Db,
  rowId: string,
  patch: Partial<JobProgressRow> & { status: string },
): Promise<void> {
  const { error } = await db
    .from("job_rows")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", rowId);
  if (error) throw new Error(`markJobRow: ${error.message}`);
}

export async function storeRawPayload(
  db: Db,
  input: {
    job_id: string;
    vendor: string;
    entity_key: string;
    payload: unknown;
  },
): Promise<void> {
  const { error } = await db.from("raw_payloads").insert({
    job_id: input.job_id,
    vendor: input.vendor,
    entity_key: input.entity_key,
    payload: input.payload,
  });
  if (error) throw new Error(`storeRawPayload: ${error.message}`);
}

export async function refreshJobCounters(db: Db, jobId: string): Promise<void> {
  const { data, error } = await db
    .from("job_rows")
    .select("status")
    .eq("job_id", jobId);
  if (error) throw new Error(`refreshJobCounters: ${error.message}`);

  const rows = data ?? [];
  const rows_total = rows.length;
  const rows_done = rows.filter((r) => r.status === "done" || r.status === "skipped").length;
  const rows_failed = rows.filter((r) => r.status === "failed").length;

  await updateJob(db, jobId, {
    rows_total,
    rows_done,
    rows_failed,
    heartbeat_at: new Date().toISOString(),
  } as Partial<JobRow>);
}
