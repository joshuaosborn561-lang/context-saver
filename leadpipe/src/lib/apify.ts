/**
 * Minimal Apify client — fetch finished actor-run datasets only.
 * Used by ingest_serp (already-paid google-search-scraper runs).
 */

export interface ApifyRunMeta {
  id: string;
  status: string;
  defaultDatasetId: string;
  actId?: string;
}

export async function fetchActorRun(
  token: string,
  runId: string,
  baseUrl = "https://api.apify.com",
): Promise<ApifyRunMeta> {
  const url = `${baseUrl.replace(/\/$/, "")}/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Apify run ${runId} fetch failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { data?: Record<string, unknown> };
  const data = json.data ?? {};
  const datasetId = String(data.defaultDatasetId ?? "");
  if (!datasetId) {
    throw new Error(`Apify run ${runId}: no defaultDatasetId`);
  }
  return {
    id: String(data.id ?? runId),
    status: String(data.status ?? ""),
    defaultDatasetId: datasetId,
    actId: data.actId ? String(data.actId) : undefined,
  };
}

/** Page dataset items (clean JSON). */
export async function fetchDatasetItems(
  token: string,
  datasetId: string,
  opts: { limit?: number; baseUrl?: string } = {},
): Promise<unknown[]> {
  const baseUrl = (opts.baseUrl ?? "https://api.apify.com").replace(/\/$/, "");
  const pageSize = Math.min(Math.max(opts.limit ?? 100, 1), 250);
  const out: unknown[] = [];
  let offset = 0;

  for (;;) {
    const url =
      `${baseUrl}/v2/datasets/${encodeURIComponent(datasetId)}/items` +
      `?token=${encodeURIComponent(token)}` +
      `&clean=true&format=json&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Apify dataset ${datasetId} fetch failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const chunk = (await res.json()) as unknown;
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += chunk.length;
  }
  return out;
}

export async function loadSerpItemsForRun(
  token: string,
  runId: string,
): Promise<{ meta: ApifyRunMeta; items: unknown[] }> {
  const meta = await fetchActorRun(token, runId);
  const items = await fetchDatasetItems(token, meta.defaultDatasetId);
  return { meta, items };
}
