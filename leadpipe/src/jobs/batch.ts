import type { JobProgressRow, JobRowWrite } from "../db/client.js";
import {
  ROW_CONCURRENCY_CAP,
  ROW_CONCURRENCY_DEFAULT,
  clampInt,
  runPool,
} from "../lib/concurrency.js";
import { AtomicCostGate } from "../lib/cost.js";

export interface BatchProcessOptions {
  costActual: number;
  ceiling: number;
  rowConcurrency: number;
}

export interface BatchProcessResult {
  costActual: number;
  useful: number;
  blocked: boolean;
  writes: JobRowWrite[];
}

export interface BatchRowResult {
  useful: boolean;
  cost_usd: number;
  summary?: Record<string, unknown>;
}

type RowOutcome =
  | { kind: "done"; row: JobProgressRow; useful: boolean; cost_usd: number; summary: Record<string, unknown> }
  | { kind: "failed"; row: JobProgressRow; error: string }
  | { kind: "skipped"; row: JobProgressRow };

/**
 * Process one 25-row fetch with a worker pool. Ceiling is checked before
 * each row; cost is accumulated atomically (overshoot of at most one row).
 * Status writes are returned for a single bulk upsert.
 */
export async function processJobBatch(
  batch: JobProgressRow[],
  processRow: (entityKey: string) => Promise<BatchRowResult>,
  opts: BatchProcessOptions,
): Promise<BatchProcessResult> {
  const gate = new AtomicCostGate(opts.costActual, opts.ceiling);
  const width = clampInt(
    opts.rowConcurrency,
    ROW_CONCURRENCY_DEFAULT,
    1,
    ROW_CONCURRENCY_CAP,
  );

  const outcomes = await runPool(
    batch,
    width,
    async (row): Promise<RowOutcome> => {
      if (!(await gate.canStart())) return { kind: "skipped", row };
      try {
        const result = await processRow(row.entity_key);
        const charged = await gate.tryCharge(result.cost_usd);
        if (!charged) return { kind: "skipped", row };
        return {
          kind: "done",
          row,
          useful: result.useful,
          cost_usd: result.cost_usd,
          summary: result.summary ?? { useful: result.useful },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "failed", row, error: message.slice(0, 1000) };
      }
    },
    { shouldStop: () => gate.isBlocked },
  );

  const writes: JobRowWrite[] = [];
  let useful = 0;
  for (const outcome of outcomes) {
    if (!outcome || outcome.kind === "skipped") continue;
    if (outcome.kind === "done") {
      if (outcome.useful) useful += 1;
      writes.push({
        id: outcome.row.id,
        job_id: outcome.row.job_id,
        entity_key: outcome.row.entity_key,
        status: "done",
        attempts: outcome.row.attempts + 1,
        last_error: null,
        result_summary: outcome.summary,
        cost_usd: outcome.cost_usd,
        created_at: outcome.row.created_at,
      });
    } else {
      writes.push({
        id: outcome.row.id,
        job_id: outcome.row.job_id,
        entity_key: outcome.row.entity_key,
        status: "failed",
        attempts: outcome.row.attempts + 1,
        last_error: outcome.error,
        result_summary: {},
        cost_usd: 0,
        created_at: outcome.row.created_at,
      });
    }
  }

  return {
    costActual: gate.costActual,
    useful,
    blocked: gate.isBlocked,
    writes,
  };
}
