import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
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
 * - Streamable HTTP at /mcp (Railway URL for Claude)
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
    try {
      const result = await dispatch(services, name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
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

/** Session-scoped Streamable HTTP MCP for Claude remote connectors. */
export function createHttpMcpHandler(
  db: Db,
  config: Config,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const services = createServices(db, config);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return async (req, res) => {
    if (!authorizeMcp(req, config)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (req.method === "POST") {
        const body = await readBodyJson(req);

        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res, body);
          return;
        }

        if (!sessionId && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            // JSON responses are more reliable with Claude.ai custom connectors
            // than SSE streams behind some proxies.
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) transports.delete(id);
          };
          const server = createLeadpipeMcpServer(services);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "bad_request",
            message: "Missing or unknown mcp-session-id; send initialize first.",
          }),
        );
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_session" }));
          return;
        }
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
    } catch (err) {
      console.error("[leadpipe] mcp http error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  };
}

function authorizeMcp(req: IncomingMessage, config: Config): boolean {
  const expected = config.mcpAuthToken;
  // No token configured → open access
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
        "backfill params (unknown keys rejected): source ('gc'|'gc_companies'|'gc_contacts'|'permit_parcel.operators'|'peterson_leads') " +
        "OR source_schema+source_table(s); optional source_project, domain_column, name_column, owner_segments, where. " +
        "Examples: {source:'gc'} or {source_schema:'gc',source_tables:['companies','contacts']} " +
        "or {source:'permit_parcel.operators',owner_segments:['private','religious_nonprofit']}. " +
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
      description: "Up to 10 rows for eyeballing quality only. Hard-capped at 10.",
      inputSchema: {
        type: "object",
        properties: {
          client_tag: { type: "string" },
          filter: { type: "object" },
          n: { type: "integer", minimum: 1, maximum: 10 },
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
        client_tag: String(args.client_tag),
        goal: String(args.goal),
        filters: args.filters as never,
        max_tier: args.max_tier as never,
      });
    case "lp_run":
      return services.run({
        job_kind: args.job_kind as never,
        client_tag: String(args.client_tag),
        params: (args.params as Record<string, unknown>) ?? {},
        approve_cost_usd:
          args.approve_cost_usd !== undefined
            ? Number(args.approve_cost_usd)
            : undefined,
      });
    case "lp_status":
      return services.status(String(args.job_id));
    case "lp_inventory":
      return services.inventory(
        String(args.client_tag),
        args.scope ? String(args.scope) : undefined,
      );
    case "lp_sample": {
      const n = Math.min(Number(args.n ?? 5), 10);
      return services.sample({
        client_tag: String(args.client_tag),
        filter: args.filter as never,
        n,
        table: args.table as never,
      });
    }
    case "lp_export":
      return services.export({
        client_tag: String(args.client_tag),
        filter: args.filter as never,
        format: args.format as never,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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
