#!/usr/bin/env node
/**
 * LeadPipe entrypoint.
 *
 * Modes:
 *   --mode mcp     Stdio MCP server (Claude/Cursor tools)
 *   --mode worker  HTTP + job poller (Railway)
 *   --mode both    Worker HTTP + note that MCP is typically separate process
 */

import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { startMcpServer } from "./mcp/server.js";
import { startWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config);

  console.error(`[leadpipe] starting mode=${config.mode}`);

  if (config.mode === "mcp") {
    await startMcpServer(db, config);
    return;
  }

  if (config.mode === "worker") {
    await startWorker(db, config);
    return;
  }

  // both: run worker; MCP over stdio only when explicitly requested
  // (Railway deploys worker; local Cursor uses --mode mcp)
  await startWorker(db, config);
}

main().catch((err) => {
  console.error("[leadpipe] fatal", err);
  process.exit(1);
});
