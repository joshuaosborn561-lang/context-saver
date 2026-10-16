/**
 * Concurrency primitives for the worker, row pool, and vendor gates.
 * No secrets, no lead payloads.
 */

export const JOB_CONCURRENCY_DEFAULT = 2;
export const JOB_CONCURRENCY_CAP = 4;
export const ROW_CONCURRENCY_DEFAULT = 6;
export const ROW_CONCURRENCY_CAP = 12;
export const WRITE_CHUNK_SIZE = 200;
export const GETLEADS_RPS_DEFAULT = 4;
export const APIFY_CONCURRENCY_DEFAULT = 4;
export const AIARK_CONCURRENCY_DEFAULT = 6;
export const FULLENRICH_CONCURRENCY_DEFAULT = 4;

export function clampInt(
  value: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(lo, Math.trunc(value)));
}

export function chunkItems<T>(
  items: readonly T[],
  size = WRITE_CHUNK_SIZE,
): T[][] {
  const n = clampInt(size, WRITE_CHUNK_SIZE, 1, Number.MAX_SAFE_INTEGER);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n));
  }
  return out;
}

/** Write `items` in chunks. On chunk failure, retry that chunk one row at a time. */
export async function writeChunks<T>(
  items: readonly T[],
  write: (chunk: T[]) => Promise<{ error?: { message?: string } | null } | void>,
  chunkSize = WRITE_CHUNK_SIZE,
): Promise<{ written: number; calls: number }> {
  let written = 0;
  let calls = 0;
  for (const chunk of chunkItems(items, chunkSize)) {
    calls += 1;
    const result = await write(chunk);
    if (!result?.error) {
      written += chunk.length;
      continue;
    }
    for (const row of chunk) {
      calls += 1;
      const single = await write([row]);
      if (!single?.error) written += 1;
    }
  }
  return { written, calls };
}

export function sleep(
  ms: number,
  wait: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  return wait(ms);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff: base * 2^attempt + random * base. */
export function backoffMs(
  attempt: number,
  baseMs = 200,
  random: () => number = Math.random,
): number {
  const exp = Math.max(0, Math.trunc(attempt));
  const jitter = Math.max(0, random()) * baseMs;
  return baseMs * 2 ** exp + jitter;
}

export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  opts?: { shouldStop?: () => boolean },
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  if (items.length === 0) return results;
  let cursor = 0;
  const width = clampInt(concurrency, 1, 1, items.length);

  async function run(): Promise<void> {
    for (;;) {
      if (opts?.shouldStop?.()) return;
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()));
  return results;
}

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Token-bucket: at most `rps` acquires in any rolling 1s window. */
export class RateLimiter {
  readonly rps: number;
  private stamps: number[] = [];

  constructor(
    rps: number,
    private readonly deps: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.rps = clampInt(rps, GETLEADS_RPS_DEFAULT, 1, 100);
  }

  async acquire(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const wait = this.deps.sleep ?? defaultSleep;
    for (;;) {
      const t = now();
      this.stamps = this.stamps.filter((s) => t - s < 1000);
      if (this.stamps.length < this.rps) {
        this.stamps.push(t);
        return;
      }
      const oldest = this.stamps[0] ?? t;
      const delay = Math.max(1, 1000 - (t - oldest));
      await wait(delay);
    }
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }
}

export class Semaphore {
  readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = clampInt(max, 1, 1, 256);
  }

  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export function is429(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 429 || e.statusCode === 429) return true;
  return typeof e.message === "string" && /\b429\b/.test(e.message);
}

export async function with429Retry<T>(
  fn: () => Promise<T>,
  opts?: {
    maxRetries?: number;
    baseMs?: number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxRetries = clampInt(opts?.maxRetries ?? 5, 5, 0, 12);
  const baseMs = opts?.baseMs ?? 200;
  const random = opts?.random ?? Math.random;
  const wait = opts?.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!is429(err) || attempt >= maxRetries) throw err;
      await wait(backoffMs(attempt, baseMs, random));
      attempt += 1;
    }
  }
}
