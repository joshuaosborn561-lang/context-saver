/**
 * In-memory SKIP LOCKED equivalent — used by tests and as the claim algorithm.
 * Production claim is lp.claim_queued_jobs (FOR UPDATE SKIP LOCKED).
 */

export const CLAIM_SQL_HINT = "FOR UPDATE SKIP LOCKED";

export interface ClaimableJob {
  id: string;
  status: string;
  created_at?: string;
}

/**
 * Pick up to `limit` unlocked queued/interrupted jobs and mark them running.
 * `locked` is the SKIP LOCKED set — ids another worker already holds.
 */
export function claimJobsSkipLocked<T extends ClaimableJob>(
  jobs: T[],
  locked: Set<string>,
  limit: number,
): T[] {
  const n = Math.max(0, Math.trunc(limit));
  if (n === 0) return [];
  const claimed: T[] = [];
  const sorted = [...jobs].sort((a, b) =>
    String(a.created_at ?? a.id).localeCompare(String(b.created_at ?? b.id)),
  );
  for (const job of sorted) {
    if (claimed.length >= n) break;
    if (locked.has(job.id)) continue;
    if (job.status !== "queued" && job.status !== "interrupted") continue;
    locked.add(job.id);
    job.status = "running";
    claimed.push(job);
  }
  return claimed;
}
