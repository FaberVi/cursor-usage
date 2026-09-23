import { apiLog } from "./cursor-api-logger";
import type { NumberWithSource, RequestTotals, UsagePayload } from "./cursor-api-types";
import { asRecord, nextMonth, toNumber } from "./cursor-api-utils";
import type { OnDemandUsage } from "./on-demand-types";

function pickNumber(record: Record<string, unknown>, fields: string[]): NumberWithSource | null {
  for (const field of fields) {
    const value = toNumber(record[field]);
    if (value !== null) {
      return { value, source: field };
    }
  }
  return null;
}

function extractOnDemandFromSummaryBlock(
  block: Record<string, unknown> | null,
  stripeOnDemandEnabled: boolean,
): OnDemandUsage {
  if (!block || block.enabled !== true) {
    return stripeOnDemandEnabled
      ? { state: "unlimited", onDemandEnabled: true, spendDollars: 0, limitDollars: null }
      : { state: "disabled", onDemandEnabled: false, spendDollars: 0, limitDollars: null };
  }

  const usedCents = toNumber(block.used) ?? 0;
  const spendDollars = usedCents / 100;
  const limitCents = toNumber(block.limit);

  if (limitCents !== null && limitCents > 0) {
    return {
      state: "limited",
      onDemandEnabled: stripeOnDemandEnabled,
      spendDollars,
      limitDollars: limitCents / 100,
    };
  }

  return { state: "unlimited", onDemandEnabled: true, spendDollars, limitDollars: null };
}

function extractPoolUsageFromPlan(plan: Record<string, unknown>): UsagePayload["poolUsage"] {
  const autoPercentUsed = toNumber(plan.autoPercentUsed);
  const apiPercentUsed = toNumber(plan.apiPercentUsed);
  const totalPercentUsed = toNumber(plan.totalPercentUsed);
  if (autoPercentUsed === null && apiPercentUsed === null && totalPercentUsed === null) {
    return null;
  }
  return {
    autoPercentUsed: autoPercentUsed ?? 0,
    apiPercentUsed: apiPercentUsed ?? 0,
    totalPercentUsed: totalPercentUsed ?? 0,
  };
}

export function extractPoolUsageFromSummary(summaryRaw: unknown): UsagePayload["poolUsage"] {
  const summary = asRecord(summaryRaw);
  const individual = summary ? asRecord(summary.individualUsage) : null;
  const plan = individual ? asRecord(individual.plan) : null;
  if (!plan) return null;
  return extractPoolUsageFromPlan(plan);
}

export function extractUsageFromSummary(
  summaryRaw: unknown,
  stripeOnDemandEnabled: boolean,
): UsagePayload | null {
  const summary = asRecord(summaryRaw);
  if (!summary) {
    apiLog("usage-summary payload is not an object");
    return null;
  }

  const individual = asRecord(summary.individualUsage);
  const plan = individual ? asRecord(individual.plan) : null;
  if (!plan || plan.enabled === false) {
    apiLog("usage-summary: plan disabled or missing");
    return null;
  }

  const used = toNumber(plan.used);
  const limit = toNumber(plan.limit);
  const breakdown = asRecord(plan.breakdown);
  const breakdownUsed =
    toNumber(breakdown?.included) ??
    toNumber(breakdown?.total);
  const breakdownLimit =
    toNumber(breakdown?.total) ??
    toNumber(breakdown?.included);

  const resolvedUsed = used ?? breakdownUsed ?? 0;
  const resolvedLimit = limit ?? breakdownLimit ?? 0;

  if (resolvedUsed === 0 && resolvedLimit === 0) {
    apiLog("usage-summary: no plan used/limit fields");
    return null;
  }

  const individualOnDemand = individual ? asRecord(individual.onDemand) : null;
  const teamUsage = asRecord(summary.teamUsage);
  const teamOnDemand = teamUsage ? asRecord(teamUsage.onDemand) : null;
  const onDemandBlock =
    individualOnDemand?.enabled === true ? individualOnDemand : teamOnDemand;
  const onDemand = extractOnDemandFromSummaryBlock(onDemandBlock, stripeOnDemandEnabled);

  const billingCycleEnd = typeof summary.billingCycleEnd === "string" ? summary.billingCycleEnd : null;
  const billingCycleStart = typeof summary.billingCycleStart === "string" ? summary.billingCycleStart : null;
  const resetsAt = billingCycleEnd ?? (billingCycleStart ? nextMonth(billingCycleStart) : null);

  return {
    includedRequests: {
      used: resolvedUsed,
      limit: resolvedLimit,
    },
    onDemand,
    poolUsage: extractPoolUsageFromPlan(plan),
    grokBotUsage: null,
    resetsAt,
    planInfo: null,
  };
}

export function mergeTeamIncludedRequests(
  usageTotals: RequestTotals | null,
  memberUsed: NumberWithSource,
  memberLimit: NumberWithSource,
): { used: number; limit: number; usedSource: string; limitSource: string } {
  const hasParsedUsage = usageTotals !== null && usageTotals.source !== "none";
  const used = hasParsedUsage ? usageTotals.used : memberUsed.value;
  const limit =
    usageTotals !== null && usageTotals.limit > 0
      ? usageTotals.limit
      : memberLimit.value > 0
        ? memberLimit.value
        : hasParsedUsage
          ? usageTotals.limit
          : memberLimit.value;

  const usedSource = hasParsedUsage
    ? `usage.${usageTotals.source}.used`
    : `member.${memberUsed.source}`;
  const limitSource =
    usageTotals !== null && usageTotals.limit > 0
      ? `usage.${usageTotals.source}.limit`
      : memberLimit.value > 0
        ? `member.${memberLimit.source}`
        : hasParsedUsage
          ? `usage.${usageTotals.source}.limit`
          : `member.${memberLimit.source}`;

  return { used, limit, usedSource, limitSource };
}

export function extractTeamUsedRequests(member: Record<string, unknown>): NumberWithSource {
  return (
    pickNumber(member, [
      "includedRequestsUsed",
      "numRequests",
      "requestsUsed",
      "fastPremiumRequests",
      "fastPremiumRequestsUsed",
      "premiumRequestsUsed",
      "requestCount",
      "includedUsage",
    ]) ?? { value: 0, source: "fallback:0" }
  );
}

export function extractTeamRequestLimit(
  member: Record<string, unknown>,
  fallbackLimit: number,
): NumberWithSource {
  return (
    pickNumber(member, [
      "includedRequestLimit",
      "maxRequestUsage",
      "maxRequests",
      "requestLimit",
      "premiumRequestLimit",
    ]) ?? {
      value: fallbackLimit,
      source: "setup.maxRequestUsage",
    }
  );
}
