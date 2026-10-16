/**
 * Per-vendor concurrency / RPS gates + 429 jitter backoff.
 * GetLeads is RPS; Apify / AI Ark / FullEnrich are in-flight caps.
 */

import {
  AIARK_CONCURRENCY_DEFAULT,
  APIFY_CONCURRENCY_DEFAULT,
  FULLENRICH_CONCURRENCY_DEFAULT,
  GETLEADS_RPS_DEFAULT,
  RateLimiter,
  Semaphore,
  clampInt,
  with429Retry,
} from "./concurrency.js";

export interface VendorLimitConfig {
  getleadsRps: number;
  apifyConcurrency: number;
  aiarkConcurrency: number;
  fullenrichConcurrency: number;
}

export function vendorLimitConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VendorLimitConfig {
  return {
    getleadsRps: clampInt(
      Number(env.GETLEADS_RPS ?? env.LEADPIPE_GETLEADS_RPS ?? GETLEADS_RPS_DEFAULT),
      GETLEADS_RPS_DEFAULT,
      1,
      20,
    ),
    apifyConcurrency: clampInt(
      Number(env.APIFY_CONCURRENCY ?? APIFY_CONCURRENCY_DEFAULT),
      APIFY_CONCURRENCY_DEFAULT,
      1,
      32,
    ),
    aiarkConcurrency: clampInt(
      Number(env.AIARK_CONCURRENCY ?? AIARK_CONCURRENCY_DEFAULT),
      AIARK_CONCURRENCY_DEFAULT,
      1,
      32,
    ),
    fullenrichConcurrency: clampInt(
      Number(env.FULLENRICH_CONCURRENCY ?? FULLENRICH_CONCURRENCY_DEFAULT),
      FULLENRICH_CONCURRENCY_DEFAULT,
      1,
      32,
    ),
  };
}

export interface VendorLimits {
  getleads: RateLimiter;
  apify: Semaphore;
  aiark: Semaphore;
  fullenrich: Semaphore;
  wrap<T>(vendor: VendorName, fn: () => Promise<T>): Promise<T>;
}

export type VendorName = "getleads" | "apify" | "aiark" | "fullenrich";

export function createVendorLimits(
  cfg: VendorLimitConfig = vendorLimitConfigFromEnv(),
): VendorLimits {
  const getleads = new RateLimiter(cfg.getleadsRps);
  const apify = new Semaphore(cfg.apifyConcurrency);
  const aiark = new Semaphore(cfg.aiarkConcurrency);
  const fullenrich = new Semaphore(cfg.fullenrichConcurrency);
  const gates: Record<VendorName, { use<T>(fn: () => Promise<T>): Promise<T> }> = {
    getleads,
    apify,
    aiark,
    fullenrich,
  };

  return {
    getleads,
    apify,
    aiark,
    fullenrich,
    wrap<T>(vendor: VendorName, fn: () => Promise<T>): Promise<T> {
      return gates[vendor].use(() => with429Retry(fn));
    },
  };
}

let singleton: VendorLimits | null = null;

export function getVendorLimits(): VendorLimits {
  if (!singleton) singleton = createVendorLimits();
  return singleton;
}

export function resetVendorLimits(cfg?: VendorLimitConfig): VendorLimits {
  singleton = createVendorLimits(cfg ?? vendorLimitConfigFromEnv());
  return singleton;
}
