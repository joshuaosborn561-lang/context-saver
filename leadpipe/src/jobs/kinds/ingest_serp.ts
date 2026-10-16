import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../../config.js";
import type { Db, JobRow } from "../../db/client.js";
import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import {
  fetchDatasetItems,
  loadSerpItemsForRun,
} from "../../lib/apify.js";
import {
  validateIngestSerpParams,
  type IngestSerpParams,
} from "../../lib/ingest_serp_params.js";
import {
  extractSerpPeople,
  normalizeCompany,
  parseTargetTitles,
  type SerpPerson,
} from "../../lib/serp_match.js";

/**
 * ingest_serp — free ingest of already-paid Apify google-search-scraper runs.
 *
 * Params: apify_run_ids, target_titles, persona, require_company_match?,
 * write_client_schema?, write_lp?
 *
 * Filters personalInfo.companyName vs queried dealership + target titles,
 * writes lp.contacts (and client_<tag>.contacts) with persona. No vendor spend.
 */
export const runIngestSerp: JobHandler = {
  async seed(ctx) {
    const v = validateIngestSerpParams(
      (ctx.job.params ?? {}) as Record<string, unknown>,
    );
    if (!v.ok) throw new Error(v.error);

    const needsApify =
      v.params.apify_run_ids.length > 0 ||
      v.params.apify_dataset_ids.length > 0;
    if (needsApify && !ctx.config.apifyToken) {
      throw new Error(
        "ingest_serp with apify_run_ids/apify_dataset_ids requires APIFY_TOKEN " +
          "(token must be allowed to read those runs/datasets). " +
          "Or stage JSON in storage and pass storage_paths instead.",
      );
    }

    const unique = [...new Set(v.params.entity_keys)];
    await seedEntityKeys(ctx.db, ctx.job.id, unique);
    return { rows_total: unique.length };
  },

  async processRow(ctx, entityKey) {
    const v = validateIngestSerpParams(
      (ctx.job.params ?? {}) as Record<string, unknown>,
    );
    if (!v.ok) throw new Error(v.error);
    const params = v.params;
    const titles = parseTargetTitles(params.target_titles);

    const { source, items, meta } = await loadItemsForEntity(
      ctx,
      entityKey,
    );

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "apify_serp",
      entity_key: entityKey,
      payload: {
        source,
        ...meta,
        item_count: items.length,
        sample_terms: items.slice(0, 5).map((it) => {
          const r = it as { searchQuery?: { term?: string } };
          return r.searchQuery?.term ?? null;
        }),
      },
    });

    if (
      !items.some((it) => {
        const r = it as { organicResults?: unknown; searchQuery?: unknown };
        return Boolean(r?.organicResults || r?.searchQuery);
      })
    ) {
      return {
        useful: false,
        cost_usd: 0,
        summary: {
          entity_key: entityKey,
          error: "not_serp_shaped",
          item_count: items.length,
        },
      };
    }

    const people = extractSerpPeople(items, {
      targetTitles: titles,
      requireCompanyMatch: params.require_company_match !== false,
    });

    const domainCache = await loadCompanyDomainIndex(
      ctx.db,
      ctx.config,
      ctx.job.client_tag,
    );

    let written = 0;
    let unresolved = 0;
    const domainsTouched = new Set<string>();

    for (const person of people) {
      const company = person.company_name || person.queried_company;
      let domain = lookupDomain(domainCache, company);
      if (!domain) {
        unresolved += 1;
        const slug = normalizeCompany(company)
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        domain = slug ? `${slug}.unknown` : "";
      }
      if (!domain) continue;
      domainsTouched.add(domain);

      const wrote = await writePerson(ctx, params, person, domain);
      if (wrote) written += 1;
    }

    return {
      useful: written > 0,
      cost_usd: 0,
      summary: {
        entity_key: entityKey,
        source,
        ...meta,
        serp_items: items.length,
        people_matched: people.length,
        contacts_written: written,
        unresolved_domain: unresolved,
        domains_touched: domainsTouched.size,
        persona: params.persona,
      },
    };
  },

  async summarize(ctx) {
    const { data: rowStats } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let contacts = 0;
    let people = 0;
    let runs = 0;
    for (const r of rowStats ?? []) {
      const s = (r.result_summary ?? {}) as Record<string, number>;
      contacts += s.contacts_written ?? 0;
      people += s.people_matched ?? 0;
      runs += 1;
    }

    return {
      useful_output_count: contacts,
      contacts_written: contacts,
      people_matched: people,
      runs_processed: runs,
      note: "Free ingest — Apify dataset read only; no enrich vendors called.",
    };
  },
};

async function loadItemsForEntity(
  ctx: { db: Db; config: Config },
  entityKey: string,
): Promise<{
  source: string;
  items: unknown[];
  meta: Record<string, unknown>;
}> {
  if (entityKey.startsWith("run:")) {
    const runId = entityKey.slice("run:".length);
    const token = ctx.config.apifyToken;
    if (!token) {
      throw new Error(
        `APIFY_TOKEN required to read run ${runId}. Stage JSON and use storage_paths instead.`,
      );
    }
    try {
      const { meta, items } = await loadSerpItemsForRun(token, runId);
      return {
        source: "apify_run",
        items,
        meta: {
          run_id: runId,
          status: meta.status,
          dataset_id: meta.defaultDatasetId,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|insufficient-permissions/i.test(msg)) {
        throw new Error(
          `Apify token cannot read run ${runId} (403). ` +
            `Use a token with run/dataset read access, or upload the dataset JSON to storage and pass storage_paths.`,
        );
      }
      throw err;
    }
  }

  if (entityKey.startsWith("dataset:")) {
    const datasetId = entityKey.slice("dataset:".length);
    const token = ctx.config.apifyToken;
    if (!token) {
      throw new Error(`APIFY_TOKEN required to read dataset ${datasetId}`);
    }
    const items = await fetchDatasetItems(token, datasetId);
    return {
      source: "apify_dataset",
      items,
      meta: { dataset_id: datasetId },
    };
  }

  if (entityKey.startsWith("storage:")) {
    const path = entityKey.slice("storage:".length);
    const bucket = ctx.config.exportBucket;
    const { data, error } = await ctx.db.storage.from(bucket).download(path);
    if (error || !data) {
      throw new Error(
        `storage download ${bucket}/${path} failed: ${error?.message ?? "empty"}`,
      );
    }
    const text = await data.text();
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown[] })?.items)
        ? (parsed as { items: unknown[] }).items
        : null;
    if (!items) {
      throw new Error(
        `storage ${path}: expected a JSON array of SERP items (or {items:[…]})`,
      );
    }
    return {
      source: "storage",
      items,
      meta: { storage_path: path, bucket },
    };
  }

  throw new Error(
    `Unknown ingest_serp entity_key "${entityKey}". Expected run:|dataset:|storage: prefix.`,
  );
}

type DomainIndex = {
  byNormName: Map<string, string>;
  names: { name: string; domain: string; norm: string }[];
};

function indexName(
  byNormName: Map<string, string>,
  names: DomainIndex["names"],
  name: string,
  domain: string,
): void {
  const d = domain.toLowerCase().trim();
  const n = name.trim();
  if (!d || !n) return;
  const norm = normalizeCompany(n);
  if (!norm) return;
  if (!byNormName.has(norm)) byNormName.set(norm, d);
  names.push({ name: n, domain: d, norm });
}

async function loadCompanyDomainIndex(
  db: Db,
  config: Config,
  clientTag: string,
): Promise<DomainIndex> {
  const byNormName = new Map<string, string>();
  const names: DomainIndex["names"] = [];

  // lp.companies
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await db
      .from("companies")
      .select("domain,company_name")
      .eq("client_tag", clientTag)
      .not("domain", "is", null)
      .range(from, from + page - 1);
    if (error) throw new Error(`lp.companies: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      indexName(
        byNormName,
        names,
        String(r.company_name ?? ""),
        String(r.domain ?? ""),
      );
    }
    if (data.length < page) break;
    from += page;
  }

  // client_<tag>.leads — better name→domain coverage for franchise rooftops
  const schema = `client_${clientTag}`;
  try {
    const clientDb = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema },
    }) as SupabaseClient<any, any, any>;
    from = 0;
    for (;;) {
      const { data, error } = await clientDb
        .from("leads")
        .select("domain,name")
        .not("domain", "is", null)
        .range(from, from + page - 1);
      if (error || !data?.length) break;
      for (const r of data) {
        indexName(
          byNormName,
          names,
          String(r.name ?? ""),
          String(r.domain ?? ""),
        );
      }
      if (data.length < page) break;
      from += page;
    }
  } catch {
    /* schema optional */
  }

  return { byNormName, names };
}

function lookupDomain(index: DomainIndex, company: string): string {
  const norm = normalizeCompany(company);
  if (!norm) return "";
  const exact = index.byNormName.get(norm);
  if (exact) return exact;
  // Substring / distinctive-token fallback
  let best = "";
  let bestScore = 0;
  for (const row of index.names) {
    if (
      row.norm.includes(norm) ||
      norm.includes(row.norm) ||
      companyMatchesLoose(row.norm, norm)
    ) {
      const score = row.norm.length;
      if (score > bestScore) {
        bestScore = score;
        best = row.domain;
      }
    }
  }
  return best;
}

function companyMatchesLoose(a: string, b: string): boolean {
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  const distA = [...ta].filter((t) => !["auto", "group", "motors"].includes(t));
  const distB = [...tb].filter((t) => !["auto", "group", "motors"].includes(t));
  if (!distA.length || !distB.length) return false;
  return distA.some((t) => distB.includes(t));
}

async function writePerson(
  ctx: { db: Db; config: Config; job: JobRow },
  params: IngestSerpParams,
  person: SerpPerson,
  domain: string,
): Promise<boolean> {
  const clientTag = ctx.job.client_tag;
  const now = new Date().toISOString();
  const lpRow = {
    client_tag: clientTag,
    domain,
    first_name: person.first_name || null,
    last_name: person.last_name || null,
    job_title: person.job_title || null,
    email: null as string | null,
    linkedin_url: person.linkedin_url || null,
    source_tool: "apify:google-search-scraper",
    source_tier: "apify_serp",
    confidence: person.confidence,
    persona: params.persona,
    metadata: {
      persona: params.persona,
      queried_company: person.queried_company,
      company_name: person.company_name,
      location: person.location,
      from_job: ctx.job.id,
    },
    updated_at: now,
  };

  let wrote = false;

  if (params.write_lp !== false) {
    // Dedupe on linkedin_url when present
    if (person.linkedin_url) {
      const { data: existing } = await ctx.db
        .from("contacts")
        .select("id")
        .eq("client_tag", clientTag)
        .eq("linkedin_url", person.linkedin_url)
        .limit(1);
      if (existing?.length) {
        await ctx.db
          .from("contacts")
          .update({
            job_title: lpRow.job_title,
            persona: params.persona,
            domain,
            source_tier: "apify_serp",
            metadata: lpRow.metadata,
            updated_at: now,
          })
          .eq("id", existing[0]!.id);
        wrote = true;
      } else {
        const { error } = await ctx.db.from("contacts").insert(lpRow);
        if (error) throw new Error(`lp.contacts insert: ${error.message}`);
        wrote = true;
      }
    } else {
      const { data: existing } = await ctx.db
        .from("contacts")
        .select("id")
        .eq("client_tag", clientTag)
        .eq("domain", domain)
        .eq("first_name", person.first_name)
        .eq("last_name", person.last_name)
        .is("email", null)
        .limit(1);
      if (!existing?.length) {
        const { error } = await ctx.db.from("contacts").insert(lpRow);
        if (error) throw new Error(`lp.contacts insert: ${error.message}`);
        wrote = true;
      }
    }
  }

  if (params.write_client_schema !== false) {
    await writeClientContact(ctx, params, person, domain);
  }

  return wrote;
}

async function writeClientContact(
  ctx: { config: Config; job: JobRow },
  params: IngestSerpParams,
  person: SerpPerson,
  domain: string,
): Promise<void> {
  const schema = `client_${ctx.job.client_tag}`;
  const clientDb = createClient(
    ctx.config.supabaseUrl,
    ctx.config.supabaseServiceKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema },
    },
  ) as SupabaseClient<any, any, any>;

  const row = {
    domain,
    first_name: person.first_name || null,
    last_name: person.last_name || null,
    job_title: person.job_title || null,
    email: null,
    linkedin_url: person.linkedin_url || null,
    source_tool: "apify:google-search-scraper",
    source_tier: "apify_serp",
    source_url: person.source_url || person.linkedin_url || null,
    confidence: person.confidence,
    client_tag: ctx.job.client_tag,
    persona: params.persona,
    updated_at: new Date().toISOString(),
  };

  try {
    if (person.linkedin_url) {
      const { data: existing } = await clientDb
        .from("contacts")
        .select("id")
        .eq("linkedin_url", person.linkedin_url)
        .limit(1);
      if (existing?.length) {
        await clientDb
          .from("contacts")
          .update({
            job_title: row.job_title,
            persona: params.persona,
            domain,
            source_tier: "apify_serp",
            updated_at: row.updated_at,
          })
          .eq("id", existing[0]!.id);
        return;
      }
    }
    const { error } = await clientDb.from("contacts").insert(row);
    if (error && !/persona|schema cache|PGRST/i.test(error.message)) {
      // Soft-fail client mirror so lp write still counts
      console.warn(`client_${ctx.job.client_tag}.contacts: ${error.message}`);
    }
  } catch (err) {
    console.warn(
      `client schema write skipped: ${err instanceof Error ? err.message : err}`,
    );
  }
}
