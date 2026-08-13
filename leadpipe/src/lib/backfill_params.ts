/**
 * Backfill param validation — kept separate from job handlers to avoid
 * circular imports (services ↔ jobs/runner ↔ backfill).
 */

const ALLOWED_KEYS = new Set([
  "source",
  "batch_key",
  "source_project",
  "source_schema",
  "source_tables",
  "source_table",
  "domain_column",
  "name_column",
  "owner_segments",
  "where",
  "icp_only",
  "run_label",
]);

const CLIENT_SCHEMA_RE = /^client_[a-z][a-z0-9_]{0,46}$/;

export type BackfillParams = {
  source?: string;
  batch_key?: string;
  source_project?: string;
  source_schema?: string;
  source_tables?: string[];
  source_table?: string;
  domain_column?: string;
  name_column?: string;
  owner_segments?: string[];
  where?: string;
  icp_only?: boolean;
  run_label?: string;
};

export function validateBackfillParams(params: Record<string, unknown>): {
  ok: true;
  normalized: BackfillParams;
  tasks: string[];
} | { ok: false; error: string } {
  const unknown = Object.keys(params).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length) {
    return {
      ok: false,
      error:
        `Unknown backfill params: ${unknown.join(", ")}. ` +
        `Expected keys: ${[...ALLOWED_KEYS].sort().join(", ")}. ` +
        `Examples: { source: "gc" } | { source: "basco" } | ` +
        `{ source_schema: "client_basco", source_table: "leads" } | ` +
        `{ source: "permit_parcel.operators", owner_segments: ["private"] }.`,
    };
  }

  const p = params as BackfillParams;
  try {
    const tasks = resolveTasks(p);
    if (!tasks.length) {
      return {
        ok: false,
        error:
          `backfill could not resolve any source tasks from params ${JSON.stringify(params)}. ` +
          `Pass source: "gc" | "basco" | "peterson" | "client_basco.leads" | ` +
          `"permit_parcel.operators" | "peterson_leads", or source_schema + source_table(s).`,
      };
    }
    return { ok: true, normalized: p, tasks };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Task id for client_<tag>.leads → `client_leads:client_basco` */
export function clientLeadsTask(schema: string): string {
  return `client_leads:${schema}`;
}

export function parseClientLeadsTask(
  task: string,
): { schema: string } | null {
  if (!task.startsWith("client_leads:")) return null;
  const schema = task.slice("client_leads:".length);
  if (!CLIENT_SCHEMA_RE.test(schema)) return null;
  return { schema };
}

export function resolveTasks(p: BackfillParams): string[] {
  if (p.source) {
    const s = p.source.trim().toLowerCase();
    if (s === "gc") return ["gc_companies", "gc_contacts"];
    if (s === "gc_companies" || s === "gc_contacts") {
      return [s];
    }
    if (
      s === "permit_parcel.operators" ||
      s === "operators" ||
      s === "permit_parcel_operators"
    ) {
      return ["permit_parcel.operators"];
    }
    // Client aliases → client_<tag>.leads (canonical estate; public.*_leads dropped)
    if (s === "basco" || s === "basco_leads" || s === "client_basco.leads") {
      return [clientLeadsTask("client_basco")];
    }
    if (
      s === "peterson" ||
      s === "peterson_leads" ||
      s === "client_peterson.leads"
    ) {
      return [clientLeadsTask("client_peterson")];
    }
    if (s.startsWith("client_") && s.endsWith(".leads")) {
      const schema = s.slice(0, -".leads".length);
      if (!CLIENT_SCHEMA_RE.test(schema)) {
        throw new Error(`Invalid client schema in source: ${s}`);
      }
      return [clientLeadsTask(schema)];
    }
  }

  const schema = (p.source_schema ?? "").toLowerCase();
  const tables =
    p.source_tables ?? (p.source_table ? [p.source_table] : []);

  if (schema === "gc") {
    const out: string[] = [];
    for (const t of tables) {
      if (t === "companies") out.push("gc_companies");
      else if (t === "contacts") out.push("gc_contacts");
      else {
        throw new Error(
          `Unsupported gc table "${t}". Expected companies or contacts.`,
        );
      }
    }
    return out;
  }

  if (schema === "permit_parcel") {
    if (tables.length === 0 || tables.includes("operators")) {
      return ["permit_parcel.operators"];
    }
    throw new Error(
      `Unsupported permit_parcel table(s): ${tables.join(", ")}. Expected operators.`,
    );
  }

  if (CLIENT_SCHEMA_RE.test(schema)) {
    if (tables.length === 0 || tables.includes("leads")) {
      return [clientLeadsTask(schema)];
    }
    throw new Error(
      `Unsupported ${schema} table(s): ${tables.join(", ")}. Expected leads.`,
    );
  }

  // Legacy public.*_leads — remap to client_* (tables were dropped)
  if (schema === "public") {
    if (tables.includes("peterson_leads") || tables.includes("basco_leads")) {
      const out: string[] = [];
      if (tables.includes("peterson_leads")) {
        out.push(clientLeadsTask("client_peterson"));
      }
      if (tables.includes("basco_leads")) {
        out.push(clientLeadsTask("client_basco"));
      }
      return out;
    }
  }

  return [];
}

export function parseOwnerSegments(params: BackfillParams): string[] | null {
  if (Array.isArray(params.owner_segments) && params.owner_segments.length) {
    return params.owner_segments.map(String);
  }
  if (params.where) {
    const m = params.where.match(/owner_segment\s+in\s*\(([^)]+)\)/i);
    if (m) {
      return m[1]!
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, "").replace(/^"|"$/g, ""))
        .filter(Boolean);
    }
  }
  return null;
}
