#!/usr/bin/env node
/**
 * LeadPipe entrypoint.
 *
 * Modes:
 *   --mode mcp     Stdio MCP (local Cursor)
 *   --mode worker  HTTP + /mcp Streamable HTTP + job poller (Railway)
 *   --mode both    Same as worker (HTTP MCP + poller)
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

  // worker | both → HTTP with Streamable MCP at /mcp + job poller
  await startWorker(db, config);
}

main().catch((err) => {
  console.error("[leadpipe] fatal", err);
  process.exit(1);
});
