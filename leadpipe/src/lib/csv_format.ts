/**
 * CSV helpers for lp_export — proper RFC4180-ish escaping.
 * Quote fields that contain commas, quotes, CR, or LF.
 */

export function escapeCsvField(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build a CSV document from rows.
 * @param columns — column order (required when rows may be empty)
 */
export function toCsv(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  const header = columns.map(escapeCsvField).join(",");
  if (rows.length === 0) return header ? `${header}\n` : "";
  const lines = rows.map((r) =>
    columns.map((c) => escapeCsvField(r[c])).join(","),
  );
  return [header, ...lines].join("\n");
}

/**
 * Parse a simple equality filter_sql like `ev_status = 'sendable'`.
 * Supports AND-chained `col = 'value' | col = "value" | col = null | col IS NULL`.
 * Returns null if the string cannot be safely parsed (caller should error).
 */
export function parseSimpleFilterSql(
  filterSql: string,
): Record<string, string | number | boolean | null> | null {
  const raw = String(filterSql ?? "").trim();
  if (!raw) return {};

  const out: Record<string, string | number | boolean | null> = {};
  // Split on AND (case-insensitive), not inside quotes — keep it simple: no nested AND in values
  const parts = raw.split(/\s+AND\s+/i);
  for (const part of parts) {
    const p = part.trim();
    let m =
      /^([a-zA-Z_][a-zA-Z0-9_]*)\s+IS\s+NULL$/i.exec(p) ??
      /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*NULL$/i.exec(p);
    if (m) {
      out[m[1]!] = null;
      continue;
    }
    m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*'((?:\\'|[^'])*)'$/s.exec(p);
    if (m) {
      out[m[1]!] = m[2]!.replace(/\\'/g, "'");
      continue;
    }
    m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:\\"|[^"])*)"$/s.exec(p);
    if (m) {
      out[m[1]!] = m[2]!.replace(/\\"/g, '"');
      continue;
    }
    m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(p);
    if (m) {
      out[m[1]!] = Number(m[2]);
      continue;
    }
    m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(true|false)$/i.exec(p);
    if (m) {
      out[m[1]!] = m[2]!.toLowerCase() === "true";
      continue;
    }
    return null;
  }
  return out;
}

/** Merge where + optional filter_sql into equality predicates. */
export function resolveExportWhere(
  where?: Record<string, unknown>,
  filter_sql?: string,
): { ok: true; preds: Record<string, string | number | boolean | null> } | { ok: false; error: string } {
  const preds: Record<string, string | number | boolean | null> = {};

  if (where) {
    for (const [k, v] of Object.entries(where)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        return { ok: false, error: `Invalid where column name: ${k}` };
      }
      if (v === null || v === undefined) {
        preds[k] = null;
      } else if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        preds[k] = v;
      } else {
        return {
          ok: false,
          error: `where.${k} must be string | number | boolean | null`,
        };
      }
    }
  }

  if (filter_sql != null && String(filter_sql).trim() !== "") {
    const parsed = parseSimpleFilterSql(String(filter_sql));
    if (!parsed) {
      return {
        ok: false,
        error:
          `filter_sql must be simple equality predicates ` +
          `(e.g. "ev_status = 'sendable'" or "band = 'A' AND mail_class = '1'"). ` +
          `Got: ${String(filter_sql).slice(0, 120)}`,
      };
    }
    Object.assign(preds, parsed);
  }

  return { ok: true, preds };
}
