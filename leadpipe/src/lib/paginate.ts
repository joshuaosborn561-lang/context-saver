import type { Db } from "../db/client.js";

/** Page through a PostgREST select — default max rows per request is 1000. */
export async function fetchAllRows<T extends Record<string, unknown>>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await build(from, to);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

export async function fetchAllDomains(
  db: Db,
  clientTag: string,
): Promise<string[]> {
  const rows = await fetchAllRows<{ domain: string }>((from, to) =>
    db
      .from("companies")
      .select("domain")
      .eq("client_tag", clientTag)
      .not("domain", "is", null)
      .range(from, to),
  );
  return rows.map((r) => r.domain).filter(Boolean);
}

export async function fetchDomainsWithDmEmail(
  db: Db,
  clientTag: string,
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ domain: string }>((from, to) =>
    db
      .from("contacts")
      .select("domain")
      .eq("client_tag", clientTag)
      .eq("is_dm", true)
      .not("email", "is", null)
      .range(from, to),
  );
  return new Set(rows.map((r) => String(r.domain ?? "").toLowerCase()));
}
