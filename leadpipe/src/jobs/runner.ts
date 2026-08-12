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
import { runImportSmartlead } from "./kinds/import_smartlead.js";
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
  import_smartlead: runImportSmartlead,
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

  try {
    const seed = await handler.seed(ctx);
    if (seed.rows_total === 0) {
      await updateJob(ctx.db, ctx.job.id, {
        status: "failed",
        error:
          "Seed produced zero work items (rows_total=0). Refusing silent no-op.",
        rows_total: 0,
        finished_at: new Date().toISOString(),
        results_summary: {
          useful_output_count: 0,
          ok: false,
          note: "Zero source rows / work items — failure.",
        },
      } as Partial<JobRow>);
      return;
    }
    await refreshJobCounters(ctx.db, ctx.job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(ctx.db, ctx.job.id, {
      status: "failed",
      error: message.slice(0, 2000),
      finished_at: new Date().toISOString(),
      results_summary: {
        useful_output_count: 0,
        ok: false,
        note: "Failed during seed — params or source access.",
      },
    } as Partial<JobRow>);
    return;
  }

  let useful = 0;
  let costActual = Number(ctx.job.cost_actual_usd ?? 0);
  const ceiling = Number(ctx.job.cost_ceiling_usd ?? ctx.config.defaultCostCeilingUsd);

  for (;;) {
    const batch = await fetchPendingJobRows(ctx.db, ctx.job.id, 25);
    if (batch.length === 0) break;

    for (const row of batch) {
      // Strict >: approve_cost_usd=0 must allow free work (backfill). >= 0 blocked instantly.
      if (costActual > ceiling) {
        await updateJob(ctx.db, ctx.job.id, {
          status: "cost_blocked",
          error: `Stopped: actual cost $${costActual.toFixed(4)} exceeded ceiling $${ceiling.toFixed(4)}`,
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

  const summary = await handler.summarize({
    ...ctx,
    job: { ...ctx.job, cost_actual_usd: costActual },
  });
  const usefulOutput =
    typeof summary.useful_output_count === "number"
      ? summary.useful_output_count
      : useful;

  // Zero useful output is ALWAYS a failure — never a quiet success.
  const verifyFailed = summary.ok === false;
  const zeroUseful = usefulOutput === 0;
  const finalStatus = verifyFailed || zeroUseful ? "failed" : "completed";
  const errorMsg = verifyFailed
    ? String(
        Array.isArray(summary.verification_failures)
          ? (summary.verification_failures as string[]).join("; ")
          : "Post-run verification failed",
      ).slice(0, 2000)
    : zeroUseful
      ? "Job finished with useful_output_count=0 — treated as failure (no silent success)."
      : null;

  await updateJob(ctx.db, ctx.job.id, {
    status: finalStatus,
    cost_actual_usd: costActual,
    error: errorMsg,
    results_summary: {
      ...summary,
      useful_output_count: usefulOutput,
      ok: finalStatus === "completed",
      note:
        finalStatus === "failed"
          ? errorMsg
          : summary.note,
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
