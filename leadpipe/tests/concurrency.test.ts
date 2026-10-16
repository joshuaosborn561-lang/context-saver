import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_QUEUED_JOBS_RPC,
  claimQueuedJobs,
  type Db,
  type JobProgressRow,
} from "../src/db/client.js";
import { CLAIM_SQL_HINT, claimJobsSkipLocked } from "../src/lib/claim.js";
import {
  AIARK_CONCURRENCY_DEFAULT,
  APIFY_CONCURRENCY_DEFAULT,
  FULLENRICH_CONCURRENCY_DEFAULT,
  GETLEADS_RPS_DEFAULT,
  JOB_CONCURRENCY_CAP,
  JOB_CONCURRENCY_DEFAULT,
  ROW_CONCURRENCY_CAP,
  ROW_CONCURRENCY_DEFAULT,
  WRITE_CHUNK_SIZE,
  backoffMs,
  chunkItems,
  clampInt,
  is429,
  RateLimiter,
  Semaphore,
  with429Retry,
  writeChunks,
} from "../src/lib/concurrency.js";
import { AtomicCostGate } from "../src/lib/cost.js";
import { createJobPoller } from "../src/lib/job_poller.js";
import {
  createVendorLimits,
  vendorLimitConfigFromEnv,
} from "../src/lib/vendor_limits.js";
import {
  processJobBatch,
  type BatchRowResult,
} from "../src/jobs/batch.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRow(i: number, jobId = "job-1"): JobProgressRow {
  return {
    id: `row-${i}`,
    job_id: jobId,
    entity_key: `k${i}`,
    status: "pending",
    attempts: 0,
    last_error: null,
    result_summary: {},
    cost_usd: 0,
  };
}

/** Mirror of today's sequential runner loop (pre-pool). */
async function sequentialToday(
  processRow: (entityKey: string) => Promise<BatchRowResult>,
  batch: JobProgressRow[],
  costActual: number,
  ceiling: number,
): Promise<{
  costActual: number;
  useful: number;
  blocked: boolean;
  writes: { entity_key: string; status: string; cost_usd: number }[];
}> {
  const writes: { entity_key: string; status: string; cost_usd: number }[] = [];
  let useful = 0;
  for (const row of batch) {
    if (costActual > ceiling) {
      return { costActual, useful, blocked: true, writes };
    }
    try {
      const result = await processRow(row.entity_key);
      costActual += result.cost_usd;
      if (result.useful) useful += 1;
      writes.push({
        entity_key: row.entity_key,
        status: "done",
        cost_usd: result.cost_usd,
      });
    } catch {
      writes.push({
        entity_key: row.entity_key,
        status: "failed",
        cost_usd: 0,
      });
    }
  }
  return { costActual, useful, blocked: costActual > ceiling, writes };
}

describe("concurrency clamps", () => {
  it("defaults and caps job/row concurrency", () => {
    assert.equal(
      clampInt(JOB_CONCURRENCY_DEFAULT, JOB_CONCURRENCY_DEFAULT, 1, JOB_CONCURRENCY_CAP),
      2,
    );
    assert.equal(clampInt(99, JOB_CONCURRENCY_DEFAULT, 1, JOB_CONCURRENCY_CAP), 4);
    assert.equal(clampInt(0, ROW_CONCURRENCY_DEFAULT, 1, ROW_CONCURRENCY_CAP), 1);
    assert.equal(clampInt(99, ROW_CONCURRENCY_DEFAULT, 1, ROW_CONCURRENCY_CAP), 12);
    assert.equal(clampInt(Number.NaN, 6, 1, 12), 6);
  });
});

describe("processJobBatch", () => {
  it("concurrency 1 matches today's sequential results", async () => {
    const batch = [0, 1, 2, 3, 4].map((i) => makeRow(i));
    const processRow = async (key: string): Promise<BatchRowResult> => {
      const n = Number(key.slice(1));
      if (n === 3) throw new Error("boom");
      return { useful: n % 2 === 0, cost_usd: n * 0.1, summary: { key } };
    };
    const [serial, today] = await Promise.all([
      processJobBatch(batch, processRow, {
        costActual: 0,
        ceiling: 50,
        rowConcurrency: 1,
      }),
      sequentialToday(processRow, batch, 0, 50),
    ]);

    assert.equal(serial.costActual, today.costActual);
    assert.equal(serial.useful, today.useful);
    assert.equal(serial.blocked, today.blocked);
    assert.deepEqual(
      serial.writes.map((w) => ({
        entity_key: w.entity_key,
        status: w.status,
        cost_usd: w.cost_usd,
      })),
      today.writes,
    );
  });

  it("ceiling holds at 6 rows in parallel (overshoot of one)", async () => {
    const batch = [0, 1, 2, 3, 4, 5].map((i) => makeRow(i));
    let live = 0;
    let maxLive = 0;
    const processRow = async (): Promise<BatchRowResult> => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await delay(25);
      live -= 1;
      return { useful: true, cost_usd: 1 };
    };

    const result = await processJobBatch(batch, processRow, {
      costActual: 0,
      ceiling: 2.5,
      rowConcurrency: 6,
    });

    const done = result.writes.filter((w) => w.status === "done");
    assert.equal(done.length, 3);
    assert.equal(result.writes.length, 3);
    assert.equal(result.costActual, 3);
    assert.equal(result.blocked, true);
    assert.ok(result.costActual > 2.5);
    assert.ok(maxLive >= 2, "expected overlapping row work");
  });
});

describe("job claim SKIP LOCKED", () => {
  it("SQL uses FOR UPDATE SKIP LOCKED", () => {
    const sql = readFileSync(
      join(HERE, "../supabase/migrations/20261016182000_claim_queued_jobs.sql"),
      "utf8",
    );
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /claim_queued_jobs/);
    assert.equal(CLAIM_SQL_HINT, "FOR UPDATE SKIP LOCKED");
    assert.equal(CLAIM_QUEUED_JOBS_RPC, "claim_queued_jobs");
  });

  it("claimQueuedJobs calls the SKIP LOCKED RPC with free slots", async () => {
    const calls: unknown[] = [];
    const db = {
      rpc: async (name: string, args: { p_limit: number }) => {
        calls.push({ name, args });
        return {
          data: [{ id: "j1", status: "running" }],
          error: null,
        };
      },
    } as unknown as Db;
    const rows = await claimQueuedJobs(db, 2);
    assert.deepEqual(calls, [
      { name: CLAIM_QUEUED_JOBS_RPC, args: { p_limit: 2 } },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "j1");
  });

  it("two workers never claim the same job", async () => {
    const jobs = [0, 1, 2, 3].map((i) => ({
      id: `j${i}`,
      status: "queued",
      created_at: `2026-01-01T00:00:0${i}Z`,
    }));
    const locked = new Set<string>();
    const claim = async (limit: number) => {
      await delay(0);
      return claimJobsSkipLocked(jobs, locked, limit);
    };
    const seen: string[] = [];
    const execute = async (job: { id: string }) => {
      seen.push(job.id);
      await delay(5);
    };

    const w1 = createJobPoller({ concurrency: 2, claim, execute });
    const w2 = createJobPoller({ concurrency: 2, claim, execute });
    await Promise.all([w1.tick(), w2.tick()]);
    await Promise.all([w1.drain(), w2.drain()]);

    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 4);
    assert.deepEqual([...seen].sort(), ["j0", "j1", "j2", "j3"]);
  });
});

describe("batched writes", () => {
  it("chunked inserts match single-row counts (200)", async () => {
    const rows = Array.from({ length: 401 }, (_, i) => ({ n: i }));
    const singles: number[] = [];
    for (const r of rows) singles.push(r.n);

    const batched: number[] = [];
    const sizes: number[] = [];
    const result = await writeChunks(rows, async (chunk) => {
      sizes.push(chunk.length);
      for (const r of chunk) batched.push(r.n);
    });

    assert.equal(result.written, singles.length);
    assert.deepEqual(batched, singles);
    assert.deepEqual(sizes, [200, 200, 1]);
    assert.equal(chunkItems(rows, WRITE_CHUNK_SIZE).length, 3);
  });

  it("250 per-lead upserts chunk to 200+50 with the same count", () => {
    const upserts = Array.from({ length: 250 }, (_, i) => ({
      email: `u${i}@example.test`,
    }));
    const singles = upserts.length;
    const chunks = chunkItems(upserts, WRITE_CHUNK_SIZE);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.length, 200);
    assert.equal(chunks[1]!.length, 50);
    assert.equal(
      chunks.reduce((n, c) => n + c.length, 0),
      singles,
    );
  });
});

describe("vendor limits", () => {
  it("defaults: getleads 4 rps, apify 4, aiark 6, fullenrich 4", () => {
    const cfg = vendorLimitConfigFromEnv({});
    assert.equal(cfg.getleadsRps, GETLEADS_RPS_DEFAULT);
    assert.equal(cfg.apifyConcurrency, APIFY_CONCURRENCY_DEFAULT);
    assert.equal(cfg.aiarkConcurrency, AIARK_CONCURRENCY_DEFAULT);
    assert.equal(cfg.fullenrichConcurrency, FULLENRICH_CONCURRENCY_DEFAULT);
    const limits = createVendorLimits(cfg);
    assert.equal(limits.getleads.rps, 4);
    assert.equal(limits.apify.max, 4);
    assert.equal(limits.aiark.max, 6);
    assert.equal(limits.fullenrich.max, 4);
  });

  it("getleads rate limiter allows 4 acquires per second", async () => {
    let now = 0;
    const limiter = new RateLimiter(4, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    for (let i = 0; i < 4; i++) await limiter.acquire();
    assert.equal(now, 0);
    await limiter.acquire();
    assert.ok(now >= 1000);
  });

  it("apify semaphore caps in-flight at 4", async () => {
    const sem = new Semaphore(4);
    let live = 0;
    let maxLive = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.use(async () => {
          live += 1;
          maxLive = Math.max(maxLive, live);
          await delay(15);
          live -= 1;
        }),
      ),
    );
    assert.ok(maxLive <= 4);
    assert.ok(maxLive >= 2);
  });

  it("429 retry uses jitter backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    const err = Object.assign(new Error("HTTP 429"), { status: 429 });
    assert.equal(is429(err), true);
    const out = await with429Retry(
      async () => {
        calls += 1;
        if (calls < 3) throw err;
        return "ok";
      },
      {
        baseMs: 200,
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.equal(out, "ok");
    assert.deepEqual(waits, [backoffMs(0, 200, () => 0.5), backoffMs(1, 200, () => 0.5)]);
  });
});

describe("AtomicCostGate", () => {
  it("allows free work at ceiling 0", async () => {
    const gate = new AtomicCostGate(0, 0);
    assert.equal(await gate.canStart(), true);
    assert.equal(await gate.tryCharge(0), true);
    assert.equal(gate.isBlocked, false);
    assert.equal(await gate.tryCharge(0.01), true);
    assert.equal(gate.isBlocked, true);
    assert.equal(await gate.canStart(), false);
  });
});
