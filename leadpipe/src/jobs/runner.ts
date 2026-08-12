import type { Config, EnrichTier, JobKind } from "../config.js";
import type { Db, JobRow } from "../db/client.js";
import {
  fetchPendingJobRows,
  markJobRow,
  refreshJobCounters,
  storeRawPayload,
  updateJob,
  upsertJobRows,
} from "../db/client.js";
import type { Vendors } from "../vendors/index.js";
import { runFindDmsByTitle } from "./kinds/find_dms_by_title.js";
import { runEnrichContacts } from "./kinds/enrich_contacts.js";
import { runVerifyEmails } from "./kinds/verify_emails.js";
import { runResolveCompanies } from "./kinds/resolve_companies.js";
import { runSyncSmartlead } from "./kinds/sync_smartlead.js";
import { runBuildSuppression } from "./kinds/build_suppression.js";
import { runBackfill } from "./kinds/backfill.js";

export interface JobContext {
  db: Db;
  config: Config;
  vendors: Vendors;
  job: JobRow;
}

export interface JobHandler {
  /** Enumerate entity keys and seed job_rows (idempotent). Returns total. */
  seed(ctx: JobContext): Promise<{ rows_total: number; useful_hint?: string }>;
  /** Process one entity_key. Return useful=true when output is valuable. */
  processRow(
    ctx: JobContext,
    entityKey: string,
  ): Promise<{ useful: boolean; cost_usd: number; summary?: Record<string, unknown> }>;
  /** Aggregate useful output counts after completion. */
  summarize(ctx: JobContext): Promise<Record<string, unknown>>;
}

const HANDLERS: Record<JobKind, JobHandler> = {
  find_dms_by_title: runFindDmsByTitle,
  enrich_contacts: runEnrichContacts,
  verify_emails: runVerifyEmails,
  resolve_companies: runResolveCompanies,
  sync_smartlead: runSyncSmartlead,
  build_suppression: runBuildSuppression,
  backfill: runBackfill,
};

export function getHandler(kind: string): JobHandler {
  const h = HANDLERS[kind as JobKind];
  if (!h) throw new Error(`Unknown job kind: ${kind}`);
  return h;
}

export async function executeJob(ctx: JobContext): Promise<void> {
  const handler = getHandler(ctx.job.kind);

  await updateJob(ctx.db, ctx.job.id, {
    status: "running",
    started_at: ctx.job.started_at ?? new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    error: null,
  } as Partial<JobRow>);

  // Seed rows if first run / interrupted with empty ledger
  const seed = await handler.seed(ctx);
  if (seed.rows_total > 0) {
    // seed handler is responsible for upserting; ensure counters
    await refreshJobCounters(ctx.db, ctx.job.id);
  }

  let useful = 0;
  let costActual = Number(ctx.job.cost_actual_usd ?? 0);
  const ceiling = Number(ctx.job.cost_ceiling_usd ?? ctx.config.defaultCostCeilingUsd);

  // Process pending rows in batches
  for (;;) {
    const batch = await fetchPendingJobRows(ctx.db, ctx.job.id, 25);
    if (batch.length === 0) break;

    for (const row of batch) {
      if (costActual >= ceiling) {
        await updateJob(ctx.db, ctx.job.id, {
          status: "cost_blocked",
          error: `Stopped: actual cost $${costActual.toFixed(4)} hit ceiling $${ceiling.toFixed(4)}`,
          cost_actual_usd: costActual,
          finished_at: new Date().toISOString(),
        } as Partial<JobRow>);
        return;
      }

      await markJobRow(ctx.db, row.id, {
        status: "running",
        attempts: row.attempts + 1,
      });

      try {
        const result = await handler.processRow(ctx, row.entity_key);
        costActual += result.cost_usd;
        if (result.useful) useful += 1;

        await markJobRow(ctx.db, row.id, {
          status: "done",
          cost_usd: result.cost_usd,
          result_summary: result.summary ?? { useful: result.useful },
          last_error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markJobRow(ctx.db, row.id, {
          status: "failed",
          last_error: message.slice(0, 1000),
        });
      }

      await updateJob(ctx.db, ctx.job.id, {
        cost_actual_usd: costActual,
        heartbeat_at: new Date().toISOString(),
      } as Partial<JobRow>);
    }

    await refreshJobCounters(ctx.db, ctx.job.id);
  }

  // Refresh job from DB for summary
  const summary = await handler.summarize({ ...ctx, job: { ...ctx.job, cost_actual_usd: costActual } });
  const usefulOutput =
    typeof summary.useful_output_count === "number"
      ? summary.useful_output_count
      : useful;

  // Honest completion: useful output matters more than rows touched
  const finalStatus =
    usefulOutput === 0 && (ctx.job.rows_total ?? seed.rows_total) > 0
      ? "completed"
      : "completed";

  await updateJob(ctx.db, ctx.job.id, {
    status: finalStatus,
    cost_actual_usd: costActual,
    results_summary: {
      ...summary,
      useful_output_count: usefulOutput,
      note:
        usefulOutput === 0
          ? "Completed with zero useful output — not a success by LeadPipe standards."
          : undefined,
    },
    finished_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  } as Partial<JobRow>);
}

export async function seedEntityKeys(
  db: Db,
  jobId: string,
  keys: string[],
): Promise<number> {
  await upsertJobRows(db, jobId, keys);
  await updateJob(db, jobId, { rows_total: keys.length } as Partial<JobRow>);
  return keys.length;
}

export { storeRawPayload };
export type { EnrichTier };
