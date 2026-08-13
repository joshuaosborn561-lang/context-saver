/**
 * LeadPipe configuration.
 * Pass-through only: move data server-side so chat never carries payloads.
 * No paid enrichment / DM lookup strategy.
 */

export const JOB_KINDS = [
  "backfill",
  "ingest_serp",
  "sync_smartlead",
  "import_smartlead",
  "build_suppression",
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
  /** Bearer token required for remote /mcp (Claude URL connector) */
  mcpAuthToken?: string;
  /** Allow unauthenticated /mcp — local only */
  mcpAllowUnauthenticated: boolean;
  /** Apify token — ingest_serp reads finished google-search-scraper datasets */
  apifyToken?: string;
  smartleadApiKey?: string;
  /** Maps / permit_parcel project (kemvxzhcxvynmoutwdrh) */
  mapsSupabaseUrl?: string;
  mapsSupabaseServiceKey?: string;
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

  if (
    process.env.PDL_API_KEY ||
    process.env.PEOPLE_DATA_LABS_API_KEY ||
    process.env.PEOPLEDATALABS_API_KEY
  ) {
    throw new Error(
      "People Data Labs is forbidden in LeadPipe. Remove PDL_* env vars.",
    );
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
    defaultCostCeilingUsd: num("LEADPIPE_COST_CEILING_USD", 0),
    pollIntervalMs: num("LEADPIPE_POLL_MS", 2000),
    heartbeatIntervalMs: num("LEADPIPE_HEARTBEAT_MS", 15000),
    sampleMaxRows: 10,
    exportBucket: process.env.LEADPIPE_EXPORT_BUCKET ?? "lp-exports",
    exportTtlSeconds: num("LEADPIPE_EXPORT_TTL_SECONDS", 86400),
    mcpAuthToken: process.env.LEADPIPE_MCP_TOKEN || process.env.MCP_AUTH_TOKEN,
    mcpAllowUnauthenticated:
      process.env.LEADPIPE_MCP_ALLOW_UNAUTH === "1" ||
      process.env.LEADPIPE_MCP_ALLOW_UNAUTH === "true" ||
      !(process.env.LEADPIPE_MCP_TOKEN || process.env.MCP_AUTH_TOKEN),
    apifyToken:
      process.env.APIFY_TOKEN ||
      process.env.LEADPIPE_APIFY_TOKEN ||
      undefined,
    smartleadApiKey: process.env.SMARTLEAD_API_KEY,
    mapsSupabaseUrl:
      process.env.MAPS_SUPABASE_URL ?? process.env.LEADS_SUPABASE_URL,
    mapsSupabaseServiceKey:
      process.env.MAPS_SUPABASE_SERVICE_ROLE_KEY ??
      process.env.LEADS_SUPABASE_SERVICE_ROLE_KEY ??
      process.env.MAPS_SUPABASE_ANON_KEY ??
      process.env.LEADS_SUPABASE_ANON_KEY,
    peopleDataLabsBlocked: true,
  };
}
