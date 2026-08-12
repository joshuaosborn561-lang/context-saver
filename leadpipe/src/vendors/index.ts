/**
 * Vendor HTTP clients.
 * Never return bulk rows to callers above this layer for LLM consumption —
 * jobs write to Supabase; MCP returns counts only.
 *
 * PDL is intentionally absent and must stay absent.
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

export interface EmployeeRecord {
  first_name?: string;
  last_name?: string;
  job_title?: string;
  linkedin_url?: string;
  email?: string;
  country_code?: string;
  country?: string;
  location?: string;
  raw?: unknown;
}

export interface EmailResult {
  email: string | null;
  status?: string;
  confidence?: number;
  raw?: unknown;
}

export function createVendors(config: Config) {
  return {
    async getleadsEmployeeFinder(domain: string): Promise<EmployeeRecord[]> {
      if (!config.getleadsApiKey) {
        throw new VendorError("getleads", "GETLEADS_API_KEY not configured");
      }
      // Adapter shape — adjust endpoint to real getleads API when wiring production keys.
      const data = await jsonFetch<{ employees?: EmployeeRecord[]; data?: EmployeeRecord[] }>(
        "getleads",
        "https://api.getleads.xyz/v1/employee_finder",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.getleadsApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ domain }),
        },
      );
      return data.employees ?? data.data ?? [];
    },

    async getleadsWorkEmailFinder(input: {
      domain: string;
      first_name: string;
      last_name: string;
    }): Promise<EmailResult> {
      if (!config.getleadsApiKey) {
        throw new VendorError("getleads", "GETLEADS_API_KEY not configured");
      }
      const data = await jsonFetch<EmailResult & { data?: EmailResult }>(
        "getleads",
        "https://api.getleads.xyz/v1/work_email_finder",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.getleadsApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
      return data.data ?? data;
    },

    async aiarkEnrich(input: {
      domain: string;
      first_name?: string;
      last_name?: string;
      linkedin_url?: string;
    }): Promise<EmailResult> {
      if (!config.aiarkApiKey) {
        throw new VendorError("aiark", "AIARK_API_KEY not configured");
      }
      return jsonFetch<EmailResult>("aiark", "https://api.aiark.co/v1/enrich", {
        method: "POST",
        headers: {
          "X-API-Key": config.aiarkApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    /**
     * LeadMagic Employee Finder — ~0.05 credits per person returned (free if empty).
     * Proven path for find_dms_by_title (title filter in-process, then email survivors).
     */
    async leadmagicEmployeeFinder(
      domain: string,
      opts?: { limit?: number },
    ): Promise<EmployeeRecord[]> {
      if (!config.leadmagicApiKey) {
        throw new VendorError("leadmagic", "LEADMAGIC_API_KEY not configured");
      }
      const data = await jsonFetch<{
        data?: Array<Record<string, unknown>>;
        employees?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("leadmagic", "https://api.leadmagic.io/v1/people/employee-finder", {
        method: "POST",
        headers: {
          "X-API-Key": config.leadmagicApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          company_domain: domain,
          limit: opts?.limit ?? 10,
        }),
      });
      const rows = data.data ?? data.employees ?? data.results ?? [];
      return rows.map((r) => ({
        first_name: (r.first_name as string) ?? undefined,
        last_name: (r.last_name as string) ?? undefined,
        job_title:
          (r.job_title as string) ?? (r.title as string) ?? undefined,
        linkedin_url:
          (r.profile_url as string) ??
          (r.linkedin_url as string) ??
          undefined,
        email: (r.email as string) ?? undefined,
        country_code: (r.country_code as string) ?? undefined,
        country: (r.country as string) ?? undefined,
        location: (r.location as string) ?? undefined,
        raw: r,
      }));
    },

    /** LeadMagic Email Finder — 1 credit on hit, 0 when null. */
    async leadmagicWorkEmailFinder(input: {
      domain: string;
      first_name: string;
      last_name: string;
    }): Promise<EmailResult> {
      if (!config.leadmagicApiKey) {
        throw new VendorError("leadmagic", "LEADMAGIC_API_KEY not configured");
      }
      const data = await jsonFetch<{
        email?: string | null;
        status?: string | null;
        message?: string;
      }>("leadmagic", "https://api.leadmagic.io/v1/people/email-finder", {
        method: "POST",
        headers: {
          "X-API-Key": config.leadmagicApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          first_name: input.first_name,
          last_name: input.last_name,
          domain: input.domain,
        }),
      });
      return {
        email: data.email ?? null,
        status: data.status ?? (data.email ? "valid" : "not_found"),
        raw: data,
      };
    },

    async leadmagicEnrich(input: {
      domain: string;
      first_name?: string;
      last_name?: string;
      linkedin_url?: string;
    }): Promise<EmailResult> {
      if (!config.leadmagicApiKey) {
        throw new VendorError("leadmagic", "LEADMAGIC_API_KEY not configured");
      }
      const data = await jsonFetch<{
        email?: string | null;
        status?: string | null;
      }>("leadmagic", "https://api.leadmagic.io/v1/people/email-finder", {
        method: "POST",
        headers: {
          "X-API-Key": config.leadmagicApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          first_name: input.first_name ?? "",
          last_name: input.last_name ?? "",
          domain: input.domain,
          linkedin_url: input.linkedin_url,
        }),
      });
      return {
        email: data.email ?? null,
        status: data.status ?? (data.email ? "valid" : "not_found"),
        raw: data,
      };
    },

    async fullenrichEnrich(input: {
      domain: string;
      first_name?: string;
      last_name?: string;
      linkedin_url?: string;
    }): Promise<EmailResult> {
      if (!config.fullenrichApiKey) {
        throw new VendorError("fullenrich", "FULLENRICH_API_KEY not configured");
      }
      return jsonFetch<EmailResult>(
        "fullenrich",
        "https://api.fullenrich.com/v1/enrich",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.fullenrichApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
    },

    async millionVerify(email: string): Promise<{ result: string; raw: unknown }> {
      if (!config.millionverifierApiKey) {
        throw new VendorError("millionverifier", "MILLIONVERIFIER_API_KEY not configured");
      }
      const url = new URL("https://api.millionverifier.com/api/v3/");
      url.searchParams.set("api", config.millionverifierApiKey);
      url.searchParams.set("email", email);
      const data = await jsonFetch<{ result?: string; quality?: string }>(
        "millionverifier",
        url.toString(),
        { method: "GET" },
      );
      return { result: data.result ?? data.quality ?? "unknown", raw: data };
    },

    async no2bounce(email: string): Promise<{ result: string; raw: unknown }> {
      if (!config.no2bounceApiKey) {
        throw new VendorError("no2bounce", "NO2BOUNCE_API_KEY not configured");
      }
      const data = await jsonFetch<{ status?: string; result?: string }>(
        "no2bounce",
        "https://api.no2bounce.com/v1/verify",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.no2bounceApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email }),
        },
      );
      return { result: data.result ?? data.status ?? "unknown", raw: data };
    },

    /**
     * Smartlead campaign stats WITHOUT email bodies.
     * Explicitly strips HTML server-side — Aug 12 failure mode.
     */
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
          ? ((data as { data: unknown[] }).data)
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

      const cleaned = leads.map((row) => stripHtmlFields(row as Record<string, unknown>, stripped_fields));
      return { leads: cleaned, stripped_fields };
    },

    /**
     * Import leads into a campaign. Never return lead payloads to the LLM —
     * only upload_count / block_count / duplicate summaries.
     */
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
        upload_count: numField(data, ["upload_count", "uploaded_count", "ok_count"], leadList.length),
        block_count: numField(data, ["block_count", "blocked_count"], 0),
        duplicate_count: numField(data, ["duplicate_count", "dup_count", "already_added"], 0),
        raw: stripHtmlFields(data),
      };
    },

    /**
     * Live campaign lead count — pages server-side; returns count + email set
     * for membership checks. Does not surface rows to MCP.
     */
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
        const data = await jsonFetch<unknown>("smartlead", url, { method: "GET" });
        const rows = Array.isArray(data)
          ? data
          : Array.isArray((data as { data?: unknown }).data)
            ? ((data as { data: unknown[] }).data)
            : Array.isArray((data as { leads?: unknown }).leads)
              ? ((data as { leads: unknown[] }).leads)
              : [];

        if (rows.length === 0) break;

        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          const email =
            (typeof r.email === "string" && r.email) ||
            (typeof r.lead_email === "string" && r.lead_email) ||
            (r.lead && typeof r.lead === "object" && typeof (r.lead as { email?: string }).email === "string"
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
    if (block.has(keyLower) || keyLower.includes("html") || keyLower.endsWith("_body")) {
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
