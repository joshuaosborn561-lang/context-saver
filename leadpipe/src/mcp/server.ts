import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { createServices, type Services } from "../services.js";
import { JOB_KINDS } from "../config.js";

/**
 * MCP surface — the whole point.
 * No tool returns more than 10 rows. Ever.
 *
 * Transports:
 * - stdio (local Cursor)
 * - Streamable HTTP at /mcp (Railway URL for Claude) — STATELESS
 *
 * Stateless matters: Claude remote connectors keep a session id across
 * Railway deploys; in-memory session maps then 400 every tools/call with
 * an opaque client error. Fresh transport per POST fixes that.
 */

export function createLeadpipeMcpServer(services: Services): Server {
  const server = new Server(
    { name: "leadpipe", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    console.error(
      `[leadpipe] tools/call inbound name=${name} keys=${Object.keys(args).sort().join(",")}`,
    );
    try {
      const result = await dispatch(services, name, args);
      console.error(`[leadpipe] tools/call ok name=${name}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, tool: name, result }, null, 2),
          },
        ],
      };
    } catch (err) {
      const typed = toTypedError(name, err);
      console.error(
        `[leadpipe] tools/call FAILED name=${name} code=${typed.code}: ${typed.error}`,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(typed, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpServer(db: Db, config: Config): Promise<void> {
  const services = createServices(db, config);
  const server = createLeadpipeMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Stateless Streamable HTTP MCP for Claude remote connectors. */
export function createHttpMcpHandler(
  db: Db,
  config: Config,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const services = createServices(db, config);

  return async (req, res) => {
    if (!authorizeMcp(req, config)) {
      jsonError(res, 401, {
        ok: false,
        code: "mcp_unauthorized",
        error: "unauthorized",
        message: "Bearer token required (LEADPIPE_MCP_TOKEN).",
      });
      return;
    }

    try {
      if (req.method === "POST") {
        const body = await readBodyJson(req);
        const method =
          body && typeof body === "object" && "method" in body
            ? String((body as { method?: unknown }).method ?? "")
            : "";
        console.error(
          `[leadpipe] mcp POST method=${method || "?"} session=${String(req.headers["mcp-session-id"] ?? "-")}`,
        );

        // Stateless: one transport + server per request. Survives deploys and
        // ignores stale mcp-session-id headers from Claude connectors.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createLeadpipeMcpServer(services);
        await server.connect(transport);
        try {
          await transport.handleRequest(req, res, body);
        } finally {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        jsonError(res, 405, {
          ok: false,
          code: "mcp_stateless",
          error: "method_not_allowed",
          message:
            "LeadPipe MCP is stateless JSON over POST. GET/DELETE SSE sessions are not used — reconnect and POST initialize + tools/call.",
        });
        return;
      }

      res.writeHead(405, { Allow: "POST, OPTIONS" });
      res.end();
    } catch (err) {
      console.error("[leadpipe] mcp http error", err);
      if (!res.headersSent) {
        jsonError(res, 500, {
          ok: false,
          code: "mcp_http_error",
          error: err instanceof Error ? err.message : String(err),
          message: "Unhandled MCP HTTP transport error.",
        });
      }
    }
  };
}

function authorizeMcp(req: IncomingMessage, config: Config): boolean {
  const expected = config.mcpAuthToken;
  if (!expected || config.mcpAllowUnauthenticated) return true;
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${expected}`) return true;
  const alt = req.headers["x-leadpipe-token"];
  if (typeof alt === "string" && alt === expected) return true;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("token") === expected) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function toolDefinitions() {
  return [
    {
      name: "lp_plan",
      description:
        "Estimate candidate count and cost for a lead goal. Returns counts and cost breakdown only — never rows.",
      inputSchema: {
        type: "object",
        properties: {
          client_tag: { type: "string", description: "e.g. peterson, basco, parlay" },
          goal: {
            type: "string",
            description:
              "Natural language goal, e.g. 'enrich unresolved DMs', 'find DMs by title', 'verify emails'",
          },
          filters: {
            type: "object",
            description: "Optional LeadFilter fields (domain, is_dm, missing_email, ...)",
          },
          max_tier: {
            type: "string",
            enum: ["getleads", "aiark", "leadmagic", "fullenrich"],
          },
        },
        required: ["client_tag", "goal"],
      },
    },
    {
      name: "lp_run",
      description:
        "Queue a job. Returns job_id + status + estimate. Identical params attach to existing run (idempotent). Cost-gated. " +
        "backfill params (unknown keys rejected): source ('gc'|'basco'|'peterson'|'permit_parcel.operators'|…) " +
        "OR source_schema+source_table(s); optional icp_only, owner_segments, where. " +
        "Basco: {source:'basco'} → client_basco.leads. " +
        "ingest_serp (FREE — do not pull Apify into chat): " +
        "params={apify_run_ids:['…'], target_titles:'Service Director,…', persona:'service_side'}. " +
        "Company+title filter server-side → lp.contacts + client_<tag>.contacts. " +
        "Zero source rows → failed (never silent success).",
      inputSchema: {
        type: "object",
        properties: {
          job_kind: { type: "string", enum: [...JOB_KINDS] },
          client_tag: { type: "string" },
          params: { type: "object" },
          approve_cost_usd: {
            type: "number",
            description: "Cost ceiling for this run. Job refuses to start above this.",
          },
        },
        required: ["job_kind", "client_tag"],
      },
    },
    {
      name: "lp_status",
      description:
        "Job progress: counts, pct, ETA, useful_output_count, cost. Never returns row payloads.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    },
    {
      name: "lp_inventory",
      description:
        "Client inventory counts only: companies, contacts, with_email, dm_grade, by_source_tier, gaps.",
      inputSchema: {
        type: "object",
        properties: {
          client_tag: { type: "string" },
          scope: { type: "string" },
        },
        required: ["client_tag"],
      },
    },
    {
      name: "lp_sample",
      description:
        "Return ≤10 sample rows for eyeballing quality. Never more than 10.",
      inputSchema: {
        type: "object",
        properties: {
          client_tag: { type: "string" },
          filter: { type: "object" },
          n: { type: "number" },
          table: { type: "string", enum: ["contacts", "companies"] },
        },
        required: ["client_tag"],
      },
    },
    {
      name: "lp_export",
      description:
        "Export filtered contacts to storage. Returns signed_url + row_count — never content.",
      inputSchema: {
        type: "object",
        properties: {
          client_tag: { type: "string" },
          filter: { type: "object" },
          format: { type: "string", enum: ["csv", "jsonl"] },
        },
        required: ["client_tag"],
      },
    },
  ];
}

async function dispatch(
  services: Services,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "lp_plan":
      return services.plan({
        client_tag: String(args.client_tag ?? ""),
        goal: String(args.goal ?? ""),
        filters: args.filters as never,
        max_tier: args.max_tier as never,
      });
    case "lp_run":
      return services.run({
        job_kind: args.job_kind as never,
        client_tag: String(args.client_tag ?? ""),
        params: (args.params as Record<string, unknown>) ?? {},
        approve_cost_usd:
          args.approve_cost_usd !== undefined
            ? Number(args.approve_cost_usd)
            : undefined,
      });
    case "lp_status":
      return services.status(String(args.job_id ?? ""));
    case "lp_inventory":
      return services.inventory(
        String(args.client_tag ?? ""),
        args.scope ? String(args.scope) : undefined,
      );
    case "lp_sample": {
      const n = Math.min(Number(args.n ?? 5), 10);
      return services.sample({
        client_tag: String(args.client_tag ?? ""),
        filter: args.filter as never,
        n,
        table: args.table as never,
      });
    }
    case "lp_export":
      return services.export({
        client_tag: String(args.client_tag ?? ""),
        filter: args.filter as never,
        format: args.format as never,
      });
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), {
        code: "unknown_tool",
      });
  }
}

function toTypedError(
  tool: string,
  err: unknown,
): {
  ok: false;
  code: string;
  error: string;
  tool: string;
  message: string;
  hint?: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : classifyErrorMessage(message);
  return {
    ok: false,
    code,
    error: message,
    tool,
    message,
    hint: hintFor(code),
  };
}

function classifyErrorMessage(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("unauthorized") || m.includes("jwt")) return "auth_error";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (
    m.includes("unknown backfill") ||
    m.includes("unknown ingest_serp") ||
    m.includes("unknown job_kind")
  ) {
    return "invalid_params";
  }
  if (m.includes("apify_token") || m.includes("apify token")) {
    return "config_error";
  }
  if (m.includes("zero companies") || m.includes("zero source") || m.includes("rows_total=0")) {
    return "empty_input";
  }
  if (m.includes("not found") || m.includes("pgrst205")) return "not_found";
  if (m.includes("exceeds") && m.includes("ceiling")) return "cost_blocked";
  return "tool_error";
}

function hintFor(code: string): string | undefined {
  switch (code) {
    case "empty_input":
      return "Run lp_run(backfill, …) for this client_tag before find_dms / enrich.";
    case "invalid_params":
      return "Check params against lp_run description; unknown keys are rejected.";
    case "not_found":
      return "Schema/table missing or not exposed to PostgREST.";
    case "mcp_unauthorized":
      return "Reconnect the LeadPipe connector or set LEADPIPE_MCP_TOKEN.";
    default:
      return undefined;
  }
}

function jsonError(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBodyJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
