import type { UsageEvent, UsagePayload } from "./cursor-api-types";
import { getBillingCycleCutoff } from "./cursor-api-utils";
import { resolveModelPricing } from "./model-pricing";
import { startOfUtcDay } from "./utc-day";

const DAY_MS = 86_400_000;

/** Matches a displayed 100% (`formatPercent` rounds to one decimal). */
const POOL_EXHAUSTED_PERCENT = 99.95;

export type PoolDayPace = {
  allowance: number;
  used: number;
  residual: number;
  /** Pool already reached 100% by the end of this day. Daily residual is not "on budget". */
  exhausted: boolean;
};

export type PoolUsageSeries = {
  labels: string[];
  dayMs: number[];
  autoPercent: number[];
  apiPercent: number[];
  dailyAutoPercent: number[];
  dailyApiPercent: number[];
  dailyAutoPace: PoolDayPace[];
  dailyApiPace: PoolDayPace[];
  todayAutoPace: PoolDayPace | null;
  todayApiPace: PoolDayPace | null;
};

export type PoolDepletionStatus = "ok" | "exhausted" | "no_usage" | "after_reset";

export type PoolDepletionProjection = {
  pool: "auto" | "api";
  projectedAtIso: string | null;
  avgDailyPercent: number;
  status: PoolDepletionStatus;
};

export type PoolDepletionEstimate = {
  auto: PoolDepletionProjection;
  api: PoolDepletionProjection;
};

function buildDayBuckets(cycleStart: number, now: number): number[] {
  const start = startOfUtcDay(cycleStart);
  const end = startOfUtcDay(now);
  const days: number[] = [];
  for (let d = start; d <= end; d += DAY_MS) {
    days.push(d);
  }
  if (days.length === 0) days.push(end);
  return days;
}

export function formatPoolDayLabel(dayMs: number): string {
  return new Date(dayMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Grok Bot rows bill to the separate weekly allowance, not monthly Cursor Models / API pools. */
export function isGrokBotUsageModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith("grok-bot")) return true;
  const entry = resolveModelPricing(modelId);
  return entry?.pool === "grokBot";
}

/** Whether an included event should affect monthly first-party / API pool pacing in the dashboard. */
export function countsTowardCursorMonthlyPools(event: UsageEvent): boolean {
  return !isGrokBotUsageModel(event.model);
}

/** Included spend for Cursor first-party models (Auto, Composer 2.5, Cursor Grok). */
export function isAutoPoolEvent(event: UsageEvent): boolean {
  if (isGrokBotUsageModel(event.model)) return false;
  const entry = resolveModelPricing(event.model);
  if (entry) return entry.pool === "firstParty";
  // Legacy / unknown ids that still map to the Auto routing pool.
  return event.model === "default" || event.model === "auto";
}

export function poolIncludedCostCents(event: UsageEvent): number {
  if (event.kind !== "Included") return 0;
  return event.spendCents;
}

function countCycleDays(cycleStart: number, resetsAt: string | null): number {
  if (!resetsAt) return 30;
  const resetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(resetMs)) return 30;
  const startDay = startOfUtcDay(cycleStart);
  const resetDay = startOfUtcDay(resetMs);
  return Math.max(Math.round((resetDay - startDay) / DAY_MS) + 1, 1);
}

export type PoolRecommendedUsage = {
  autoRecommended: number;
  apiRecommended: number;
};

export function computeRecommendedPoolUsage(
  resetsAt: string | null,
  now: number,
): PoolRecommendedUsage | null {
  if (!resetsAt) return null;
  const cycleStart = getBillingCycleCutoff(resetsAt, now);
  const resetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(resetMs)) return null;
  const cycleDurationMs = Math.max(resetMs - cycleStart, 1);
  const elapsedMs = Math.min(Math.max(now - cycleStart, 0), cycleDurationMs);
  const recommended = (elapsedMs / cycleDurationMs) * 100;
  return { autoRecommended: recommended, apiRecommended: recommended };
}

export function computeDailyPoolPacing(
  cumulative: readonly number[],
  daily: readonly number[],
  totalCycleDays: number,
): PoolDayPace[] {
  return daily.map((used, index) => {
    const cumBefore = index > 0 ? (cumulative[index - 1] ?? 0) : 0;
    const remaining = Math.max(100 - cumBefore, 0);
    const daysLeft = Math.max(totalCycleDays - index, 1);
    const allowance = remaining / daysLeft;
    const residual = allowance - used;
    const cumNow = cumulative[index] ?? 0;
    const exhausted = cumBefore >= POOL_EXHAUSTED_PERCENT || cumNow >= POOL_EXHAUSTED_PERCENT;
    return { allowance, used, residual, exhausted };
  });
}

export function buildPoolUsageSeries(
  events: UsageEvent[],
  poolUsage: NonNullable<UsagePayload["poolUsage"]>,
  resetsAt: string | null,
  now: number,
): PoolUsageSeries | null {
  const cycleStart = getBillingCycleCutoff(resetsAt, now);
  const days = buildDayBuckets(cycleStart, now);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const autoCostByDay = new Array<number>(days.length).fill(0);
  const apiCostByDay = new Array<number>(days.length).fill(0);

  for (const event of events) {
    if (event.timestamp < cycleStart) continue;
    if (!countsTowardCursorMonthlyPools(event)) continue;
    const cost = poolIncludedCostCents(event);
    if (cost <= 0) continue;
    const day = startOfUtcDay(event.timestamp);
    const idx = dayIndex.get(day);
    if (idx === undefined) continue;
    if (isAutoPoolEvent(event)) {
      autoCostByDay[idx] = (autoCostByDay[idx] ?? 0) + cost;
    } else {
      apiCostByDay[idx] = (apiCostByDay[idx] ?? 0) + cost;
    }
  }

  const totalAutoCost = autoCostByDay.reduce((sum, value) => sum + value, 0);
  const totalApiCost = apiCostByDay.reduce((sum, value) => sum + value, 0);

  // When included spend events are missing but live % exists, assume even daily shape.
  const autoWeights =
    totalAutoCost > 0 ? autoCostByDay : autoCostByDay.map(() => (poolUsage.autoPercentUsed > 0 ? 1 : 0));
  const apiWeights =
    totalApiCost > 0 ? apiCostByDay : apiCostByDay.map(() => (poolUsage.apiPercentUsed > 0 ? 1 : 0));
  const totalAutoWeight = autoWeights.reduce((sum, value) => sum + value, 0);
  const totalApiWeight = apiWeights.reduce((sum, value) => sum + value, 0);

  const autoScale = totalAutoWeight > 0 ? poolUsage.autoPercentUsed / totalAutoWeight : 0;
  const apiScale = totalApiWeight > 0 ? poolUsage.apiPercentUsed / totalApiWeight : 0;

  let cumAuto = 0;
  let cumApi = 0;
  const autoPercent: number[] = [];
  const apiPercent: number[] = [];
  const dailyAutoPercent: number[] = [];
  const dailyApiPercent: number[] = [];

  for (let i = 0; i < days.length; i++) {
    const dayAuto = (autoWeights[i] ?? 0) * autoScale;
    const dayApi = (apiWeights[i] ?? 0) * apiScale;
    cumAuto += dayAuto;
    cumApi += dayApi;
    dailyAutoPercent.push(dayAuto);
    dailyApiPercent.push(dayApi);
    autoPercent.push(Math.min(100, cumAuto));
    apiPercent.push(Math.min(100, cumApi));
  }

  const totalCycleDays = countCycleDays(cycleStart, resetsAt);
  const dailyAutoPace = computeDailyPoolPacing(autoPercent, dailyAutoPercent, totalCycleDays);
  const dailyApiPace = computeDailyPoolPacing(apiPercent, dailyApiPercent, totalCycleDays);
  const lastIndex = dailyAutoPace.length - 1;

  return {
    labels: days.map(formatPoolDayLabel),
    dayMs: days,
    autoPercent,
    apiPercent,
    dailyAutoPercent,
    dailyApiPercent,
    dailyAutoPace,
    dailyApiPace,
    todayAutoPace: lastIndex >= 0 ? (dailyAutoPace[lastIndex] ?? null) : null,
    todayApiPace: lastIndex >= 0 ? (dailyApiPace[lastIndex] ?? null) : null,
  };
}

function projectOnePool(
  currentPct: number,
  pool: "auto" | "api",
  now: number,
  elapsedDays: number,
  resetAtMs: number | null,
): PoolDepletionProjection {
  if (currentPct >= 100) {
    return {
      pool,
      projectedAtIso: null,
      avgDailyPercent: elapsedDays > 0 ? currentPct / elapsedDays : 0,
      status: "exhausted",
    };
  }

  if (currentPct <= 0 || elapsedDays <= 0) {
    return { pool, projectedAtIso: null, avgDailyPercent: 0, status: "no_usage" };
  }

  const avgDailyPercent = currentPct / elapsedDays;
  const daysRemaining = (100 - currentPct) / avgDailyPercent;
  const projectedAtMs = now + daysRemaining * DAY_MS;

  if (resetAtMs !== null && projectedAtMs >= resetAtMs) {
    return {
      pool,
      projectedAtIso: new Date(projectedAtMs).toISOString(),
      avgDailyPercent,
      status: "after_reset",
    };
  }

  return {
    pool,
    projectedAtIso: new Date(projectedAtMs).toISOString(),
    avgDailyPercent,
    status: "ok",
  };
}

export function projectPoolDepletion(
  poolUsage: NonNullable<UsagePayload["poolUsage"]>,
  resetsAt: string | null,
  now: number,
): PoolDepletionEstimate {
  const cycleStart = getBillingCycleCutoff(resetsAt, now);
  const resetAtMs = resetsAt ? new Date(resetsAt).getTime() : null;
  const elapsedDays = Math.max((now - cycleStart) / DAY_MS, 1 / 24);

  return {
    auto: projectOnePool(poolUsage.autoPercentUsed, "auto", now, elapsedDays, resetAtMs),
    api: projectOnePool(poolUsage.apiPercentUsed, "api", now, elapsedDays, resetAtMs),
  };
}
