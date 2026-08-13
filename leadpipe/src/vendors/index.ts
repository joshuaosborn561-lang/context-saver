/**
 * External integrations used by pass-through jobs (Smartlead only).
 * Never return bulk rows to MCP / chat — jobs write to Supabase; tools return counts.
 *
 * No enrichment vendors. No PDL.
 */

import type { Config } from "../config.js";

export class VendorError extends Error {
  constructor(
    public vendor: string,
    message: string,
    public status?: number,
  ) {
    super(`[${vendor}] ${message}`);
    this.name = "VendorError";
  }
}

async function jsonFetch<T>(
  vendor: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new VendorError(
      vendor,
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return body as T;
}

export function createVendors(config: Config) {
  return {
    async smartleadCampaignStats(campaignId: string): Promise<{
      leads: Array<Record<string, unknown>>;
      stripped_fields: string[];
    }> {
      if (!config.smartleadApiKey) {
        throw new VendorError("smartlead", "SMARTLEAD_API_KEY not configured");
      }
      const url = `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/statistics?api_key=${config.smartleadApiKey}`;
      const data = await jsonFetch<unknown>("smartlead", url, { method: "GET" });
      const leads = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown }).data)
          ? (data as { data: unknown[] }).data
          : [];

      const stripped_fields = [
        "email_body",
        "html",
        "body",
        "message",
        "content",
        "email_html",
        "sequence_body",
      ];

      const cleaned = leads.map((row) =>
        stripHtmlFields(row as Record<string, unknown>, stripped_fields),
      );
      return { leads: cleaned, stripped_fields };
    },

    async smartleadImportLeads(
      campaignId: string,
      leadList: Record<string, unknown>[],
      settings?: { ignore_global_block_list?: boolean },
    ): Promise<{
      upload_count: number;
      block_count: number;
      duplicate_count: number;
      raw: unknown;
    }> {
      if (!config.smartleadApiKey) {
        throw new VendorError("smartlead", "SMARTLEAD_API_KEY not configured");
      }
      const url = `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads?api_key=${config.smartleadApiKey}`;
      const data = await jsonFetch<Record<string, unknown>>("smartlead", url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_list: leadList,
          settings: {
            ignore_global_block_list: settings?.ignore_global_block_list ?? true,
          },
        }),
      });

      return {
        upload_count: numField(
          data,
          ["upload_count", "uploaded_count", "ok_count"],
          leadList.length,
        ),
        block_count: numField(data, ["block_count", "blocked_count"], 0),
        duplicate_count: numField(
          data,
          ["duplicate_count", "dup_count", "already_added"],
          0,
        ),
        raw: stripHtmlFields(data),
      };
    },

    async smartleadCampaignLeadEmails(
      campaignId: string,
      opts?: { maxPages?: number; pageSize?: number },
    ): Promise<{ count: number; emails: Set<string> }> {
      if (!config.smartleadApiKey) {
        throw new VendorError("smartlead", "SMARTLEAD_API_KEY not configured");
      }
      const pageSize = opts?.pageSize ?? 100;
      const maxPages = opts?.maxPages ?? 500;
      const emails = new Set<string>();
      let offset = 0;

      for (let page = 0; page < maxPages; page++) {
        const url =
          `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads` +
          `?api_key=${config.smartleadApiKey}&offset=${offset}&limit=${pageSize}`;
        const data = await jsonFetch<unknown>("smartlead", url, {
          method: "GET",
        });
        const rows = Array.isArray(data)
          ? data
          : Array.isArray((data as { data?: unknown }).data)
            ? (data as { data: unknown[] }).data
            : Array.isArray((data as { leads?: unknown }).leads)
              ? (data as { leads: unknown[] }).leads
              : [];

        if (rows.length === 0) break;

        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          const email =
            (typeof r.email === "string" && r.email) ||
            (typeof r.lead_email === "string" && r.lead_email) ||
            (r.lead &&
            typeof r.lead === "object" &&
            typeof (r.lead as { email?: string }).email === "string"
              ? (r.lead as { email: string }).email
              : null);
          if (email) emails.add(email.toLowerCase().trim());
        }

        if (rows.length < pageSize) break;
        offset += pageSize;
      }

      return { count: emails.size, emails };
    },
  };
}

function numField(
  data: Record<string, unknown>,
  keys: string[],
  fallback: number,
): number {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return fallback;
}

export type Vendors = ReturnType<typeof createVendors>;

const HTML_KEYS = new Set([
  "email_body",
  "html",
  "body",
  "message",
  "content",
  "email_html",
  "sequence_body",
  "mail_body",
  "campaign_message",
]);

/** Recursively strip HTML / body fields from vendor payloads. */
export function stripHtmlFields(
  obj: Record<string, unknown>,
  extraKeys: string[] = [],
): Record<string, unknown> {
  const block = new Set([...HTML_KEYS, ...extraKeys]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (
      block.has(keyLower) ||
      keyLower.includes("html") ||
      keyLower.endsWith("_body")
    ) {
      out[k] = "[stripped]";
      continue;
    }
    if (typeof v === "string" && looksLikeHtml(v)) {
      out[k] = "[stripped_html]";
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = stripHtmlFields(v as Record<string, unknown>, extraKeys);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object"
          ? stripHtmlFields(item as Record<string, unknown>, extraKeys)
          : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

function looksLikeHtml(s: string): boolean {
  return s.length > 200 && /<\/?[a-z][\s\S]*>/i.test(s);
}
