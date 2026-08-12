#!/usr/bin/env node
/**
 * Smoke-check non-negotiables without hitting vendors.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, "src", p), "utf8");

// No PDL references as integrations
const vendors = src("vendors/index.ts");
assert.ok(!/peopledatalabs|people.?data.?labs|pdl\.io/i.test(vendors));

// MCP sample hard-capped
const mcp = src("mcp/server.ts");
assert.ok(mcp.includes("Math.min(Number(args.n ?? 5), 10)"));

// Smartlead strips HTML
assert.ok(vendors.includes("stripHtmlFields") || src("jobs/kinds/sync_smartlead.ts").includes("stripHtmlFields"));

console.log("smoke ok");
