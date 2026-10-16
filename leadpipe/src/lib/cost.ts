/** Cost helpers — LeadPipe jobs are $0 pass-throughs; kept for ceiling checks. */

import { Mutex } from "./concurrency.js";

export function gateCost(
  estimatedUsd: number,
  approveCostUsd: number | undefined,
  defaultCeiling: number,
): { ok: boolean; ceiling: number; reason?: string } {
  const ceiling =
    approveCostUsd !== undefined && Number.isFinite(approveCostUsd)
      ? approveCostUsd
      : defaultCeiling;
  if (!(ceiling >= 0) || !Number.isFinite(ceiling)) {
    return { ok: false, ceiling: 0, reason: `Invalid ceiling: ${ceiling}` };
  }
  if (estimatedUsd > ceiling) {
    return {
      ok: false,
      ceiling,
      reason: `Estimate $${estimatedUsd.toFixed(4)} exceeds approved ceiling $${ceiling.toFixed(4)}`,
    };
  }
  return { ok: true, ceiling };
}

/**
 * Shared cost counter for a parallel row pool.
 * Check before each row; charge after. Overshoot is at most one charged row.
 */
export class AtomicCostGate {
  private actual: number;
  private blocked: boolean;
  private readonly mutex = new Mutex();

  constructor(
    actual: number,
    readonly ceiling: number,
  ) {
    this.actual = Number.isFinite(actual) ? actual : 0;
    this.blocked = this.actual > this.ceiling;
  }

  get costActual(): number {
    return this.actual;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  /** Strict `>` so approve_cost_usd=0 still allows free ($0) work. */
  canStart(): Promise<boolean> {
    return this.mutex.exclusive(() => !this.blocked && this.actual <= this.ceiling);
  }

  /**
   * Add a finished row's cost. Returns false if another worker already
   * crossed the ceiling — caller must not commit that row.
   */
  tryCharge(usd: number): Promise<boolean> {
    return this.mutex.exclusive(() => {
      if (this.blocked || this.actual > this.ceiling) {
        this.blocked = true;
        return false;
      }
      const add = Number.isFinite(usd) ? usd : 0;
      this.actual += add;
      if (this.actual > this.ceiling) this.blocked = true;
      return true;
    });
  }
}
