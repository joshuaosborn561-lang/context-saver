/**
 * LeadPipe configuration.
 * All secrets via env; never hardcode vendor keys.
 */

export type EnrichTier = "getleads" | "aiark" | "leadmagic" | "fullenrich";

export const ENRICH_TIER_ORDER: EnrichTier[] = [
  "getleads",
  "aiark",
  "leadmagic",
  "fullenrich",
];

/** USD cost estimates per useful call (configurable via env overrides). */
export const DEFAULT_COSTS_USD: Record<string, number> = {
  getleads_employee_finder: 0.005,
  getleads_work_email_finder: 0.05,
  aiark_enrich: 0.08,
  leadmagic_enrich: 0.04,
  fullenrich_enrich: 0.12,
  millionverifier: 0.002,
  no2bounce: 0.003,
  smartlead_sync_page: 0.0,
  resolve_serp: 0.01,
};

export const JOB_KINDS = [
  "find_dms_by_title",
  "enrich_contacts",
  "verify_emails",
  "resolve_companies",
  "sync_smartlead",
  "build_suppression",
  "backfill",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export const CLIENT_TAGS = [
  "peterson",
  "basco",
  "culture_fits",
  "parlay",
  "msrs",
  "bcp",
] as const;

export type ClientTag = (typeof CLIENT_TAGS)[number] | string;

export interface Config {
  supabaseUrl: string;
  supabaseServiceKey: string;
  port: number;
  mode: "mcp" | "worker" | "both";
  defaultCostCeilingUsd: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  sampleMaxRows: number;
  exportBucket: string;
  exportTtlSeconds: number;
  costs: Record<string, number>;
  /** Vendor API keys — optional until the job kind is used */
  getleadsApiKey?: string;
  aiarkApiKey?: string;
  leadmagicApiKey?: string;
  fullenrichApiKey?: string;
  millionverifierApiKey?: string;
  no2bounceApiKey?: string;
  smartleadApiKey?: string;
  /** Forbidden: PDL must never be configured */
  peopleDataLabsBlocked: true;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const supabaseUrl =
    process.env.SUPABASE_URL ?? process.env.LEADPIPE_SUPABASE_URL ?? "";
  const supabaseServiceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.LEADPIPE_SUPABASE_SERVICE_KEY ??
    "";

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
    );
  }

  // Hard block PDL — non-negotiable
  if (
    process.env.PDL_API_KEY ||
    process.env.PEOPLE_DATA_LABS_API_KEY ||
    process.env.PEOPLEDATALABS_API_KEY
  ) {
    throw new Error(
      "People Data Labs is forbidden in LeadPipe. Remove PDL_* env vars.",
    );
  }

  const costs = { ...DEFAULT_COSTS_USD };
  for (const key of Object.keys(DEFAULT_COSTS_USD)) {
    const envKey = `COST_${key.toUpperCase()}`;
    if (process.env[envKey]) {
      costs[key] = Number(process.env[envKey]);
    }
  }

  const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.slice(7)
    ?? (process.argv.includes("--mode")
      ? process.argv[process.argv.indexOf("--mode") + 1]
      : undefined);

  return {
    supabaseUrl,
    supabaseServiceKey,
    port: num("PORT", 8080),
    mode: (modeArg as Config["mode"]) ?? (process.env.LEADPIPE_MODE as Config["mode"]) ?? "both",
    defaultCostCeilingUsd: num("LEADPIPE_COST_CEILING_USD", 50),
    pollIntervalMs: num("LEADPIPE_POLL_MS", 2000),
    heartbeatIntervalMs: num("LEADPIPE_HEARTBEAT_MS", 15000),
    sampleMaxRows: 10,
    exportBucket: process.env.LEADPIPE_EXPORT_BUCKET ?? "lp-exports",
    exportTtlSeconds: num("LEADPIPE_EXPORT_TTL_SECONDS", 86400),
    costs,
    getleadsApiKey: process.env.GETLEADS_API_KEY,
    aiarkApiKey: process.env.AIARK_API_KEY,
    leadmagicApiKey: process.env.LEADMAGIC_API_KEY,
    fullenrichApiKey: process.env.FULLENRICH_API_KEY,
    millionverifierApiKey: process.env.MILLIONVERIFIER_API_KEY,
    no2bounceApiKey: process.env.NO2BOUNCE_API_KEY,
    smartleadApiKey: process.env.SMARTLEAD_API_KEY,
    peopleDataLabsBlocked: true,
  };
}
