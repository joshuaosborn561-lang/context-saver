/** Cost helpers — LeadPipe jobs are $0 pass-throughs; kept for ceiling checks. */

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
