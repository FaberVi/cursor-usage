import type { PlanInfo } from "./plan-labels";
import type { UsagePayload } from "./cursor-api-types";
import { POOL_EXHAUSTED_PERCENT } from "./pool-usage-series";

/**
 * Legacy request counters (used/limit) apply only to old personal plans without pool data.
 * Current Cursor billing (personal and team) uses separate First-party models and API pools.
 */
export function shouldShowPremiumRequestsQuota(
  planInfo: PlanInfo | null,
  poolUsage?: UsagePayload["poolUsage"],
): boolean {
  if (poolUsage) return false;
  if (planInfo?.accountType === "team") return false;
  return true;
}

export function isIncludedQuotaExhausted(
  data: Pick<UsagePayload, "includedRequests" | "poolUsage">,
  showPremiumRequests: boolean,
): boolean {
  if (showPremiumRequests) {
    const { used, limit } = data.includedRequests;
    return limit > 0 && used >= limit;
  }
  return (data.poolUsage?.totalPercentUsed ?? 0) >= POOL_EXHAUSTED_PERCENT;
}
