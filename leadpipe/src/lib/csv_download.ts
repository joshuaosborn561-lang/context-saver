/**
 * Download + parse CSV / XLSX for ingest_csv (stream-ish, size capped).
 */

import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export const INGEST_CSV_TIMEOUT_MS = 30_000;
export const INGEST_CSV_MAX_BYTES = 100 * 1024 * 1024;
export const INGEST_CSV_MAX_ROWS = 100_000;

export type DownloadedFile =
  | {
      ok: true;
      url: string;
      bytes: Buffer;
      content_hash: string;
      content_type: string | null;
      filename_hint: string | null;
    }
  | {
      ok: false;
      url: string;
      error: string;
      status?: number;
    };

export async function downloadIngestFile(url: string): Promise<DownloadedFile> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INGEST_CSV_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) {
      const expired =
        res.status === 403 ||
        res.status === 401 ||
        res.status === 400 ||
        res.status === 404;
      return {
        ok: false,
        url,
        status: res.status,
        error: expired
          ? `Download failed HTTP ${res.status} (expired or inaccessible URL)`
          : `Download failed HTTP ${res.status}`,
      };
    }

    const content_type = res.headers.get("content-type");
    const disposition = res.headers.get("content-disposition");
    const filename_hint = filenameFromDisposition(disposition) ?? filenameFromUrl(url);

    const reader = res.body?.getReader();
    if (!reader) {
      const ab = Buffer.from(await res.arrayBuffer());
      if (ab.byteLength > INGEST_CSV_MAX_BYTES) {
        return {
          ok: false,
          url,
          error: `File exceeds ${INGEST_CSV_MAX_BYTES} byte cap (${ab.byteLength} bytes)`,
        };
      }
      return {
        ok: true,
        url,
        bytes: ab,
        content_hash: sha256(ab),
        content_type,
        filename_hint,
      };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      total += buf.byteLength;
      if (total > INGEST_CSV_MAX_BYTES) {
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          url,
          error: `File exceeds ${INGEST_CSV_MAX_BYTES} byte cap while downloading`,
        };
      }
      chunks.push(buf);
    }
    const bytes = Buffer.concat(chunks);
    return {
      ok: true,
      url,
      bytes,
      content_hash: sha256(bytes),
      content_type,
      filename_hint,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /abort/i.test(msg);
    return {
      ok: false,
      url,
      error: timedOut
        ? `Download timed out after ${INGEST_CSV_TIMEOUT_MS}ms`
        : `Download error: ${msg.slice(0, 300)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type ParsedSheet =
  | {
      ok: true;
      headers: string[];
      rows: Record<string, unknown>[];
      format: "csv" | "xlsx";
      truncated: boolean;
    }
  | { ok: false; error: string };

export function parseTabularFile(
  bytes: Buffer,
  opts?: { filename_hint?: string | null; content_type?: string | null },
): ParsedSheet {
  const format = detectFormat(bytes, opts?.filename_hint, opts?.content_type);
  try {
    if (format === "xlsx") {
      const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) {
        return { ok: false, error: "XLSX has no sheets" };
      }
      const sheet = wb.Sheets[sheetName];
      if (!sheet) return { ok: false, error: "XLSX sheet missing" };
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
        raw: false,
      });
      return rowsFromObjects(json, "xlsx");
    }

    const text = bytes.toString("utf8");
    // strip BOM
    const cleaned = text.replace(/^\uFEFF/, "");
    const matrix = parseCsv(cleaned);
    if (!matrix.length) {
      return { ok: false, error: "CSV is empty" };
    }
    const headers = matrix[0]!.map((h) => String(h ?? "").trim());
    const body = matrix.slice(1);
    const truncated = body.length > INGEST_CSV_MAX_ROWS;
    const limited = truncated ? body.slice(0, INGEST_CSV_MAX_ROWS) : body;
    const rows: Record<string, unknown>[] = limited.map((cells) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i] || `col_${i}`;
        obj[key] = cells[i] ?? "";
      }
      return obj;
    });
    return { ok: true, headers, rows, format: "csv", truncated };
  } catch (err) {
    return {
      ok: false,
      error: `Parse failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
    };
  }
}

function rowsFromObjects(
  json: Record<string, unknown>[],
  format: "csv" | "xlsx",
): ParsedSheet {
  if (!json.length) {
    return { ok: false, error: `${format.toUpperCase()} has no data rows` };
  }
  const headerSet = new Set<string>();
  for (const row of json.slice(0, 50)) {
    for (const k of Object.keys(row)) headerSet.add(k);
  }
  const headers = [...headerSet];
  const truncated = json.length > INGEST_CSV_MAX_ROWS;
  const rows = truncated ? json.slice(0, INGEST_CSV_MAX_ROWS) : json;
  return { ok: true, headers, rows, format, truncated };
}

function detectFormat(
  bytes: Buffer,
  filename?: string | null,
  contentType?: string | null,
): "csv" | "xlsx" {
  const name = (filename ?? "").toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "xlsx";
  if (
    ct.includes("spreadsheet") ||
    ct.includes("excel") ||
    ct.includes("officedocument.spreadsheetml")
  ) {
    return "xlsx";
  }
  // ZIP / XLSX magic
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return "xlsx";
  }
  return "csv";
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function filenameFromDisposition(d: string | null): string | null {
  if (!d) return null;
  const m =
    /filename\*=UTF-8''([^;]+)/i.exec(d) ??
    /filename="([^"]+)"/i.exec(d) ??
    /filename=([^;]+)/i.exec(d);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1].trim());
  } catch {
    return m[1].trim();
  }
}

function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/** Minimal RFC4180-ish CSV parser (handles quotes and commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing fully-empty row from final newline
  if (
    rows.length &&
    rows[rows.length - 1]!.length === 1 &&
    rows[rows.length - 1]![0] === ""
  ) {
    rows.pop();
  }
  return rows;
}
