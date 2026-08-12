import type { Config, EnrichTier } from "../config.js";
import { ENRICH_TIER_ORDER } from "../config.js";

export interface CostEstimate {
  candidate_count: number;
  estimated_cost_usd: number;
  breakdown: Record<string, { count: number; unit_cost_usd: number; subtotal_usd: number }>;
  notes: string[];
}

export function tierIndex(tier: EnrichTier): number {
  return ENRICH_TIER_ORDER.indexOf(tier);
}

export function tiersUpTo(maxTier: EnrichTier): EnrichTier[] {
  const max = tierIndex(maxTier);
  if (max < 0) throw new Error(`Unknown max_tier: ${maxTier}`);
  return ENRICH_TIER_ORDER.slice(0, max + 1);
}

export function estimateEnrichCost(
  config: Config,
  candidateCount: number,
  maxTier: EnrichTier,
  opts?: { assumeHitRate?: number },
): CostEstimate {
  const hitRate = opts?.assumeHitRate ?? 0.35;
  const tiers = tiersUpTo(maxTier);
  const breakdown: CostEstimate["breakdown"] = {};
  let remaining = candidateCount;
  let total = 0;
  const notes: string[] = [
    `Assumes ~${Math.round(hitRate * 100)}% hit rate cascading across tiers (conservative upper bound uses remaining).`,
  ];

  for (const tier of tiers) {
    const key =
      tier === "getleads"
        ? "getleads_work_email_finder"
        : tier === "aiark"
          ? "aiark_enrich"
          : tier === "leadmagic"
            ? "leadmagic_enrich"
            : "fullenrich_enrich";
    const unit = config.costs[key] ?? 0;
    const count = Math.ceil(remaining);
    const subtotal = +(count * unit).toFixed(4);
    breakdown[tier] = { count, unit_cost_usd: unit, subtotal_usd: subtotal };
    total += subtotal;
    remaining = remaining * (1 - hitRate);
  }

  return {
    candidate_count: candidateCount,
    estimated_cost_usd: +total.toFixed(4),
    breakdown,
    notes,
  };
}

export function estimateFindDmsCost(
  config: Config,
  companyCount: number,
  opts?: { employeesPerCompany?: number; dmRate?: number },
): CostEstimate {
  const empPer = opts?.employeesPerCompany ?? 8;
  const dmRate = opts?.dmRate ?? 0.15;
  const people = companyCount * empPer;
  const survivors = Math.ceil(people * dmRate);

  const finderUnit = config.costs.getleads_employee_finder ?? 0.005;
  const emailUnit = config.costs.getleads_work_email_finder ?? 0.05;

  const finderSub = +(people * finderUnit).toFixed(4);
  const emailSub = +(survivors * emailUnit).toFixed(4);

  return {
    candidate_count: companyCount,
    estimated_cost_usd: +(finderSub + emailSub).toFixed(4),
    breakdown: {
      employee_finder: {
        count: people,
        unit_cost_usd: finderUnit,
        subtotal_usd: finderSub,
      },
      work_email_finder_on_dm_survivors: {
        count: survivors,
        unit_cost_usd: emailUnit,
        subtotal_usd: emailSub,
      },
    },
    notes: [
      `employee_finder on ~${empPer}/company then SQL title filter, then email only on ~${Math.round(dmRate * 100)}% survivors.`,
      "This path is ~9x cheaper than search_people for DM discovery.",
    ],
  };
}

export function estimateVerifyCost(
  config: Config,
  emailCount: number,
): CostEstimate {
  const mv = config.costs.millionverifier ?? 0.002;
  const n2 = config.costs.no2bounce ?? 0.003;
  // No2Bounce only on ambiguous MV results (~20%)
  const n2Count = Math.ceil(emailCount * 0.2);
  const mvSub = +(emailCount * mv).toFixed(4);
  const n2Sub = +(n2Count * n2).toFixed(4);
  return {
    candidate_count: emailCount,
    estimated_cost_usd: +(mvSub + n2Sub).toFixed(4),
    breakdown: {
      millionverifier: { count: emailCount, unit_cost_usd: mv, subtotal_usd: mvSub },
      no2bounce_ambiguous: { count: n2Count, unit_cost_usd: n2, subtotal_usd: n2Sub },
    },
    notes: ["No2Bounce only on ambiguous MillionVerifier results (~20%)."],
  };
}

export function gateCost(
  estimateUsd: number,
  approveCostUsd: number | undefined,
  ceilingUsd: number,
): { ok: boolean; reason?: string } {
  const cap = approveCostUsd ?? ceilingUsd;
  if (estimateUsd > cap) {
    return {
      ok: false,
      reason: `Estimated $${estimateUsd.toFixed(4)} exceeds approved ceiling $${cap.toFixed(4)}. Pass a higher approve_cost_usd to proceed — no workaround chain will be invented.`,
    };
  }
  return { ok: true };
}
