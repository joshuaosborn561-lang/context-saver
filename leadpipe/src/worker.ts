import http from "node:http";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { claimQueuedJobs } from "./db/client.js";
import { executeJob } from "./jobs/runner.js";
import { createVendors } from "./vendors/index.js";
import { createServices } from "./services.js";
import { createHttpMcpHandler } from "./mcp/server.js";

/**
 * HTTP server for Railway:
 * - GET  /health
 * - /mcp Streamable HTTP MCP (Claude remote URL)
 * - REST mirrors for plan/run/status/inventory
 * - background job poller
 */
export async function startWorker(db: Db, config: Config): Promise<void> {
  const vendors = createVendors(config);
  const services = createServices(db, config);
  const handleMcp = createHttpMcpHandler(db, config);
  let running = false;
  let stopping = false;

  if (!config.mcpAuthToken && !config.mcpAllowUnauthenticated) {
    console.error(
      "[leadpipe] WARNING: LEADPIPE_MCP_TOKEN unset and unauth disabled — /mcp will return 401. Set LEADPIPE_MCP_TOKEN or LEADPIPE_MCP_ALLOW_UNAUTH=1",
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          service: "leadpipe",
          mcp: "/mcp",
          ts: new Date().toISOString(),
        });
        return;
      }

      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        // CORS preflight for browser-based MCP clients
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization, mcp-session-id, x-leadpipe-token",
            "Access-Control-Expose-Headers": "mcp-session-id",
          });
          res.end();
          return;
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
        await handleMcp(req, res);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/status/")) {
        const jobId = url.pathname.slice("/status/".length);
        const status = await services.status(jobId);
        json(res, 200, status);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/inventory/")) {
        const clientTag = decodeURIComponent(url.pathname.slice("/inventory/".length));
        const inv = await services.inventory(clientTag);
        json(res, 200, inv);
        return;
      }

      if (req.method === "POST" && url.pathname === "/run") {
        const body = await readJson(req);
        const result = await services.run({
          job_kind: body.job_kind as never,
          client_tag: String(body.client_tag ?? ""),
          params: (body.params as Record<string, unknown>) ?? {},
          approve_cost_usd:
            body.approve_cost_usd !== undefined
              ? Number(body.approve_cost_usd)
              : undefined,
        });
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/plan") {
        const body = await readJson(req);
        const result = await services.plan({
          client_tag: String(body.client_tag ?? ""),
          goal: String(body.goal ?? ""),
          filters: body.filters as never,
          max_tier: body.max_tier as never,
        });
        json(res, 200, result);
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.error(`[leadpipe] listening on 0.0.0.0:${config.port}`);
    console.error(`[leadpipe] MCP URL path: /mcp`);
  });

  const poll = async () => {
    if (stopping || running) return;
    running = true;
    try {
      const jobs = await claimQueuedJobs(db, 1);
      for (const job of jobs) {
        console.error(
          `[leadpipe] executing job ${job.id} kind=${job.kind} client=${job.client_tag}`,
        );
        await executeJob({ db, config, vendors, job });
        console.error(`[leadpipe] finished job ${job.id}`);
      }
    } catch (err) {
      console.error("[leadpipe] poll error", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(poll, config.pollIntervalMs);
  void poll();

  const shutdown = () => {
    stopping = true;
    clearInterval(timer);
    server.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
