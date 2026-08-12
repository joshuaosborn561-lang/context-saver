import { createClient } from "@supabase/supabase-js";
import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import {
  assertBatchImport,
  chunkLeads,
  extractLeadEmail,
  normalizeLeadList,
  verifyCampaignTotals,
  type ImportCampaignSpec,
} from "../../lib/smartlead_import.js";

/**
 * import_smartlead — requeue/import leads without passing them through chat.
 *
 * Solves the session-exhaustion failure: 1,113 leads × (read + tool write) through
 * context truncates mid-campaign and count assertions only check "what I sent",
 * not "what should have been sent."
 *
 * Flow (all server-side):
 * 1. Load `_clean.json` from storage
 * 2. Assert file length === expected_upload
 * 3. Batch import_leads with ignore_global_block_list
 * 4. Per batch: upload_count === sent && block_count === 0
 * 5. After campaign: live membership === expected_final_count
 * 6. Spot-check every email from the clean file is present (server-side set)
 * 7. MCP sees only counts / pass-fail — never lead rows
 *
 * Params:
 * {
 *   campaigns: [{ campaign_id, storage_path, expected_upload, expected_final_count }],
 *   ignore_global_block_list?: true,
 *   batch_size?: 100,
 *   import_bucket?: "lp-exports"
 * }
 */
export const runImportSmartlead: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as {
      campaigns?: ImportCampaignSpec[];
      batch_size?: number;
      import_bucket?: string;
    };
    if (!params.campaigns?.length) {
      throw new Error(
        "import_smartlead requires params.campaigns[{ campaign_id, storage_path, expected_upload, expected_final_count }]",
      );
    }

    const batchSize = params.batch_size ?? 100;
    const bucket = params.import_bucket ?? ctx.config.exportBucket;
    const keys: string[] = [];

    for (const spec of params.campaigns) {
      validateSpec(spec);
      const leads = await loadLeadsFromStorage(ctx, bucket, spec.storage_path);

      if (leads.length !== spec.expected_upload) {
        throw new Error(
          `Campaign ${spec.campaign_id}: clean file has ${leads.length} leads but expected_upload=${spec.expected_upload}. ` +
            `Refusing to start — this is the "sent vs should-have-sent" failure mode.`,
        );
      }

      const batches = chunkLeads(leads, batchSize);
      for (let i = 0; i < batches.length; i++) {
        const entityKey = `${spec.campaign_id}:batch:${i}`;
        await storeRawPayload(ctx.db, {
          job_id: ctx.job.id,
          vendor: "smartlead_import_batch",
          entity_key: entityKey,
          payload: {
            campaign_id: spec.campaign_id,
            batch_index: i,
            batch_total: batches.length,
            expected_upload: spec.expected_upload,
            expected_final_count: spec.expected_final_count,
            storage_path: spec.storage_path,
            leads: batches[i],
          },
        });
        keys.push(entityKey);
      }

      // Campaign-level expected targets (no leads) — used by summarize verify
      await storeRawPayload(ctx.db, {
        job_id: ctx.job.id,
        vendor: "smartlead_import_spec",
        entity_key: `${spec.campaign_id}:spec`,
        payload: {
          campaign_id: spec.campaign_id,
          expected_upload: spec.expected_upload,
          expected_final_count: spec.expected_final_count,
          storage_path: spec.storage_path,
          batch_total: batches.length,
        },
      });
    }

    await seedEntityKeys(ctx.db, ctx.job.id, keys);
    return { rows_total: keys.length };
  },

  async processRow(ctx, entityKey) {
    const ignoreBlock =
      (ctx.job.params as { ignore_global_block_list?: boolean })
        .ignore_global_block_list !== false;

    const { data: payloads, error } = await ctx.db
      .from("raw_payloads")
      .select("payload")
      .eq("job_id", ctx.job.id)
      .eq("vendor", "smartlead_import_batch")
      .eq("entity_key", entityKey)
      .order("fetched_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const payload = payloads?.[0]?.payload as Record<string, unknown> | undefined;
    if (!payload) throw new Error(`Missing import batch payload for ${entityKey}`);

    const campaignId = String(payload.campaign_id);
    const leads = (payload.leads as Record<string, unknown>[]) ?? [];
    const result = await ctx.vendors.smartleadImportLeads(campaignId, leads, {
      ignore_global_block_list: ignoreBlock,
    });

    const assertion = assertBatchImport({
      upload_count: result.upload_count,
      block_count: result.block_count,
      sent: leads.length,
    });

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "smartlead_import_result",
      entity_key: entityKey,
      payload: {
        campaign_id: campaignId,
        sent: leads.length,
        upload_count: result.upload_count,
        block_count: result.block_count,
        duplicate_count: result.duplicate_count,
        assertion_ok: assertion.ok,
        failures: assertion.failures,
        api: result.raw,
      },
    });

    if (!assertion.ok) {
      throw new Error(
        `Import batch failed for ${entityKey}: ${assertion.failures.join("; ")}`,
      );
    }

    return {
      useful: true,
      cost_usd: 0,
      summary: {
        phase: "import",
        campaign_id: campaignId,
        sent: leads.length,
        upload_count: result.upload_count,
        block_count: result.block_count,
        duplicate_count: result.duplicate_count,
      },
    };
  },

  async summarize(ctx) {
    const bucket =
      (ctx.job.params as { import_bucket?: string }).import_bucket ??
      ctx.config.exportBucket;

    const { data: specs } = await ctx.db
      .from("raw_payloads")
      .select("payload")
      .eq("job_id", ctx.job.id)
      .eq("vendor", "smartlead_import_spec");

    const { data: batchRows } = await ctx.db
      .from("job_rows")
      .select("entity_key, status, result_summary, last_error")
      .eq("job_id", ctx.job.id);

    const byCampaign: Record<string, Record<string, unknown>> = {};
    let leads_uploaded = 0;
    let campaigns_ok = 0;
    const all_failures: string[] = [];

    for (const specRow of specs ?? []) {
      const spec = specRow.payload as {
        campaign_id: string;
        expected_upload: number;
        expected_final_count: number;
        storage_path: string;
      };
      const campaignId = spec.campaign_id;
      const rows = (batchRows ?? []).filter((r) =>
        String(r.entity_key).startsWith(`${campaignId}:batch:`),
      );

      let uploaded_total = 0;
      let block_total = 0;
      let batches_failed = 0;
      for (const r of rows) {
        if (r.status === "failed") {
          batches_failed += 1;
          if (r.last_error) all_failures.push(String(r.last_error));
          continue;
        }
        const s = (r.result_summary ?? {}) as Record<string, number>;
        uploaded_total += Number(s.upload_count ?? 0);
        block_total += Number(s.block_count ?? 0);
      }

      let verified = null as ReturnType<typeof verifyCampaignTotals> | null;
      if (batches_failed === 0 && rows.length > 0) {
        try {
          const live = await ctx.vendors.smartleadCampaignLeadEmails(campaignId);
          const cleanLeads = await loadLeadsFromStorage(
            ctx,
            bucket,
            spec.storage_path,
          );
          const cleanEmails = cleanLeads
            .map(extractLeadEmail)
            .filter((e): e is string => !!e);
          let emails_missing = 0;
          for (const email of cleanEmails) {
            if (!live.emails.has(email)) emails_missing += 1;
          }
          verified = verifyCampaignTotals({
            campaign_id: campaignId,
            expected_upload: spec.expected_upload,
            uploaded_total,
            block_total,
            expected_final_count: spec.expected_final_count,
            live_count: live.count,
            emails_checked: cleanEmails.length,
            emails_missing,
          });
          await storeRawPayload(ctx.db, {
            job_id: ctx.job.id,
            vendor: "smartlead_import_verify",
            entity_key: `${campaignId}:verify`,
            payload: verified,
          });
          if (verified.ok) campaigns_ok += 1;
          else all_failures.push(...verified.failures);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          all_failures.push(`${campaignId} verify error: ${msg}`);
        }
      }

      leads_uploaded += uploaded_total;
      byCampaign[campaignId] = {
        batches: rows.length,
        batches_failed,
        leads_uploaded: uploaded_total,
        block_total,
        expected_upload: spec.expected_upload,
        expected_final_count: spec.expected_final_count,
        live_count: verified?.live_count ?? null,
        verified_ok: verified?.ok ?? false,
        failures: verified?.failures ?? [],
      };
    }

    return {
      useful_output_count: leads_uploaded,
      campaigns_verified_ok: campaigns_ok,
      campaigns: byCampaign,
      verification_failures: all_failures,
      ok: all_failures.length === 0 && campaigns_ok === (specs ?? []).length,
      note:
        "Verification compares live campaign membership to expected_final_count — not merely upload_count vs this request.",
    };
  },
};

function validateSpec(spec: ImportCampaignSpec): void {
  if (!spec.campaign_id) throw new Error("campaign_id required");
  if (!spec.storage_path) throw new Error("storage_path required");
  if (!Number.isFinite(spec.expected_upload) || spec.expected_upload < 0) {
    throw new Error(`expected_upload required for ${spec.campaign_id}`);
  }
  if (!Number.isFinite(spec.expected_final_count) || spec.expected_final_count < 0) {
    throw new Error(`expected_final_count required for ${spec.campaign_id}`);
  }
}

async function loadLeadsFromStorage(
  ctx: { config: { supabaseUrl: string; supabaseServiceKey: string } },
  bucket: string,
  path: string,
): Promise<Record<string, unknown>[]> {
  const publicDb = createClient(ctx.config.supabaseUrl, ctx.config.supabaseServiceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await publicDb.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `Failed to load ${bucket}/${path}: ${error?.message ?? "no data"}. ` +
        `Upload the _clean.json to storage first — do not paste leads into chat.`,
    );
  }
  const text = await data.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
  return normalizeLeadList(parsed);
}
