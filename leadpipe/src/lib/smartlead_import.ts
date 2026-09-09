/**
 * Pure helpers for Smartlead import assertions.
 * The failure mode this prevents: comparing upload_count to "what I sent this call"
 * instead of "what should have been sent for the whole campaign."
 */

export interface ImportCampaignSpec {
  campaign_id: string;
  /** Path in LeadPipe storage bucket, e.g. imports/3781908_clean.json */
  storage_path: string;
  /** Leads in the clean file — must match file length at seed time */
  expected_upload: number;
  /** Live campaign membership after successful requeue */
  expected_final_count: number;
}

export interface ImportBatchResult {
  upload_count: number;
  block_count: number;
  sent: number;
}

export interface CampaignVerifyResult {
  campaign_id: string;
  expected_upload: number;
  uploaded_total: number;
  block_total: number;
  expected_final_count: number;
  live_count: number;
  emails_checked: number;
  emails_missing: number;
  ok: boolean;
  failures: string[];
}

export function chunkLeads<T>(leads: T[], batchSize: number): T[][] {
  const size = Math.max(1, batchSize);
  const out: T[][] = [];
  for (let i = 0; i < leads.length; i += size) {
    out.push(leads.slice(i, i + size));
  }
  return out;
}

export function assertBatchImport(
  result: ImportBatchResult,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (result.upload_count !== result.sent) {
    failures.push(
      `upload_count ${result.upload_count} !== sent ${result.sent}`,
    );
  }
  if (result.block_count !== 0) {
    failures.push(`block_count ${result.block_count} !== 0`);
  }
  return { ok: failures.length === 0, failures };
}

export function verifyCampaignTotals(input: {
  campaign_id: string;
  expected_upload: number;
  uploaded_total: number;
  block_total: number;
  expected_final_count: number;
  live_count: number;
  emails_checked: number;
  emails_missing: number;
}): CampaignVerifyResult {
  const failures: string[] = [];
  if (input.uploaded_total !== input.expected_upload) {
    failures.push(
      `uploaded_total ${input.uploaded_total} !== expected_upload ${input.expected_upload}`,
    );
  }
  if (input.block_total !== 0) {
    failures.push(`block_total ${input.block_total} !== 0`);
  }
  if (input.live_count !== input.expected_final_count) {
    failures.push(
      `live_count ${input.live_count} !== expected_final_count ${input.expected_final_count}`,
    );
  }
  if (input.emails_missing > 0) {
    failures.push(
      `${input.emails_missing}/${input.emails_checked} sampled emails missing from live campaign`,
    );
  }
  return {
    ...input,
    ok: failures.length === 0,
    failures,
  };
}

export function extractLeadEmail(lead: Record<string, unknown>): string | null {
  const candidates = [lead.email, lead.Email, lead.lead_email, lead.to_email];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c.toLowerCase().trim();
  }
  return null;
}

/** Normalize Smartlead lead_list payloads from common clean-file shapes. */
export function normalizeLeadList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["leads", "lead_list", "data", "rows"]) {
      if (Array.isArray(obj[key])) {
        return normalizeLeadList(obj[key]);
      }
    }
  }
  throw new Error("Clean file must be a JSON array of leads or { leads: [...] }");
}
