import type { DailySpendRow, UsageEvent, UsagePayload } from "./cursor-api";
import { parseTimestamp } from "./cursor-api-utils";
import { CARD_HELP } from "./card-help";
import { getDurationCutoff, type UsageDuration } from "./model-breakdown";
import { startOfUtcDay } from "./utc-day";
import { eventRequestCount, eventTokenCount } from "./cursor-usage-parsing";
import {
  aggregateTheoreticalByModel,
  getModelPricingCatalog,
  getPricingCatalogSyncedAt,
  getPricingRuntimeOnlyModels,
  type ModelPricingCatalog,
  type RuntimeOnlyPricingModel,
  type TheoreticalModelCost,
} from "./model-pricing";
import {
  buildPoolUsageSeries,
  computeRecommendedPoolUsage,
  projectPoolDepletion,
  type PoolDepletionEstimate,
  type PoolRecommendedUsage,
  type PoolUsageSeries,
} from "./pool-usage-series";
import { shouldShowPremiumRequestsQuota } from "./usage-display";

export type ChartMetric = "spend" | "tokens" | "requests";
export type UsageFilter = "all" | "included" | "ondemand";

export type ChartDataset = {
  model: string;
  data: number[];
  spendByDay?: number[];
};

export type ChartSeries = {
  labels: string[];
  dayMs: number[];
  datasets: ChartDataset[];
};

export type ModelPricingState = {
  catalog: ModelPricingCatalog;
  usedModelIds: string[];
  theoreticalByModel: Record<string, TheoreticalModelCost>;
};

export type DashboardState = {
  generatedAt: number;
  data: UsagePayload | null;
  events: UsageEvent[];
  dailySpend: DailySpendRow[];
  resetsAt: string | null;
  isTeamMember: boolean;
  showPremiumRequests: boolean;
  quotaAwareEventDisplay: boolean;
  poolUsageSeries: PoolUsageSeries | null;
  poolDepletion: PoolDepletionEstimate | null;
  poolRecommended: PoolRecommendedUsage | null;
  modelPricing: ModelPricingState;
  pricingCatalogSyncedAt: number | null;
  pricingRuntimeOnlyModels: RuntimeOnlyPricingModel[];
  error: string | null;
  cardHelp: typeof CARD_HELP;
  conversationTitles: Record<string, string>;
  storedEventCount: number;
  warnings: string[];
  eventsComplete: boolean;
  eventHistorySyncInProgress: boolean;
};

const DAY_MS = 86_400_000;

function isIncluded(event: UsageEvent): boolean {
  return event.kind === "Included";
}

function isOnDemand(event: UsageEvent): boolean {
  return event.kind === "On-Demand";
}

function billableSpendCents(event: UsageEvent, quotaAwareEventDisplay: boolean): number {
  return quotaAwareEventDisplay && !isOnDemand(event) ? 0 : event.spendCents;
}

function matchesUsageFilter(event: UsageEvent, filter: UsageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "included") return isIncluded(event);
  return isOnDemand(event);
}

export function buildDashboardState(
  data: UsagePayload | null,
  events: UsageEvent[],
  dailySpend: DailySpendRow[],
  isTeamMember: boolean,
  error: string | null,
  now: number,
  quotaAwareEventDisplay = true,
  conversationTitles: Record<string, string> = {},
  storedEventCount = 0,
  /** Full event history for pool pacing (must not follow the Usage chart range filter). */
  poolEvents?: UsageEvent[],
  warnings: string[] = [],
  eventsComplete = true,
  eventHistorySyncInProgress = false,
): DashboardState {
  const poolUsage = data?.poolUsage ?? null;
  const resetsAt = data?.resetsAt ?? null;
  const eventsForPool = poolEvents ?? events;
  const showPremiumRequests = shouldShowPremiumRequestsQuota(
    data?.planInfo ?? null,
    poolUsage,
  );
  const catalog = getModelPricingCatalog();
  const tier = data?.planInfo?.tier;
  const isTeamPlan =
    tier === "Teams" ||
    tier === "Enterprise" ||
    tier?.startsWith("Teams ·") === true;
  const pricingAggregate = aggregateTheoreticalByModel(
    events,
    "billingCycle",
    resetsAt,
    now,
    {
      applyCursorTokenRate: isTeamPlan,
      cursorTokenRatePerMillion: catalog.cursorTokenRatePerMillion,
      quotaAwareEventDisplay,
    },
  );

  return {
    generatedAt: now,
    data,
    events,
    dailySpend,
    resetsAt,
    isTeamMember,
    showPremiumRequests,
    quotaAwareEventDisplay,
    poolUsageSeries: poolUsage ? buildPoolUsageSeries(eventsForPool, poolUsage, resetsAt, now) : null,
    poolDepletion: poolUsage ? projectPoolDepletion(poolUsage, resetsAt, now) : null,
    poolRecommended: poolUsage ? computeRecommendedPoolUsage(resetsAt, now) : null,
    modelPricing: {
      catalog,
      usedModelIds: pricingAggregate.usedModelIds,
      theoreticalByModel: pricingAggregate.theoreticalByModel,
    },
    pricingCatalogSyncedAt: getPricingCatalogSyncedAt(),
    pricingRuntimeOnlyModels: getPricingRuntimeOnlyModels(),
    error,
    cardHelp: CARD_HELP,
    conversationTitles,
    storedEventCount,
    warnings,
    eventsComplete,
    eventHistorySyncInProgress,
  };
}

export function filterEventsForRange(
  events: UsageEvent[],
  range: UsageDuration,
  resetAtIso: string | null,
  usageFilter: UsageFilter,
  now: number,
): UsageEvent[] {
  const cutoff = getDurationCutoff(range, resetAtIso, now);
  return events.filter((e) => eventTimestampMs(e) >= cutoff && matchesUsageFilter(e, usageFilter));
}

/** Same event filter used by the usage chart (range + usage filter + day buckets). */
export function filterEventsForChartRange(
  events: UsageEvent[],
  range: UsageDuration,
  resetAtIso: string | null,
  usageFilter: UsageFilter,
  now: number,
): UsageEvent[] {
  const cutoff = getDurationCutoff(range, resetAtIso, now);
  const allowedDays = new Set(buildDayBuckets(cutoff, now, range, resetAtIso));
  return events.filter((event) => {
    const ts = eventTimestampMs(event);
    if (!Number.isFinite(ts) || ts < cutoff) return false;
    if (!matchesUsageFilter(event, usageFilter)) return false;
    return allowedDays.has(startOfUtcDay(ts));
  });
}

export function filterDashboardEvents(
  events: UsageEvent[],
  prefs: { range: UsageDuration; usageFilter: UsageFilter } | null,
  resetAtIso: string | null,
  now: number,
): UsageEvent[] {
  if (!prefs) return events;
  return filterEventsForRange(events, prefs.range, resetAtIso, prefs.usageFilter, now);
}

export function buildDayBuckets(
  cutoff: number,
  now: number,
  range?: UsageDuration,
  resetAtIso?: string | null,
): number[] {
  const start = startOfUtcDay(cutoff);
  let end = startOfUtcDay(now);
  if (range === "billingCycle" && resetAtIso) {
    const reset = new Date(resetAtIso);
    if (!Number.isNaN(reset.getTime())) {
      const cycleEnd = startOfUtcDay(reset.getTime() - DAY_MS);
      if (cycleEnd > end) end = cycleEnd;
    }
  }
  if (end < start) end = start;
  const days: number[] = [];
  for (let d = start; d <= end; d += DAY_MS) {
    days.push(d);
  }
  if (days.length === 0) days.push(end);
  return days;
}

export function formatChartDayLabel(dayMs: number, locale: string = "en-US"): string {
  const d = new Date(dayMs);
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}

function eventValue(event: UsageEvent, metric: ChartMetric, quotaAwareEventDisplay: boolean): number {
  if (metric === "tokens") return eventTokenCount(event);
  if (metric === "requests") return eventRequestCount(event);
  return chartSpendDollars(event, quotaAwareEventDisplay);
}

function chartSpendDollars(event: UsageEvent, quotaAwareEventDisplay: boolean): number {
  const billable = billableSpendCents(event, quotaAwareEventDisplay) / 100;
  if (billable > 0) return billable;
  if (quotaAwareEventDisplay && isIncluded(event)) {
    const tokenCost = (event.tokenCostCents || 0) / 100;
    if (tokenCost > 0) return tokenCost;
  }
  return 0;
}

function eventTimestampMs(event: UsageEvent): number {
  return parseTimestamp(event.timestamp);
}

export function aggregateChartSeries(
  events: UsageEvent[],
  dailySpend: DailySpendRow[],
  range: UsageDuration,
  resetAtIso: string | null,
  metric: ChartMetric,
  usageFilter: UsageFilter,
  now: number,
  quotaAwareEventDisplay = true,
  locale: string = "en-US",
): ChartSeries {
  const cutoff = getDurationCutoff(range, resetAtIso, now);
  const days = buildDayBuckets(cutoff, now, range, resetAtIso);
  const dayIndex = new Map<number, number>();
  days.forEach((d, i) => dayIndex.set(d, i));

  const perModelDaily = new Map<string, number[]>();
  const perModelSpend = new Map<string, number[]>();
  const ensureModel = (map: Map<string, number[]>, model: string): number[] => {
    let arr = map.get(model);
    if (!arr) {
      arr = new Array(days.length).fill(0);
      map.set(model, arr);
    }
    return arr;
  };

  // All metrics (spend/tokens/requests) come from per-event data so the usage filter applies uniformly.
  // dailySpend is kept as a fallback signal for team membership but is no longer used for the chart series.
  void dailySpend;
  const filtered = filterEventsForChartRange(events, range, resetAtIso, usageFilter, now);
  for (const event of filtered) {
    const ts = eventTimestampMs(event);
    const day = startOfUtcDay(ts);
    const idx = dayIndex.get(day);
    if (idx === undefined) continue;
    const arr = ensureModel(perModelDaily, event.model);
    arr[idx] = (arr[idx] ?? 0) + eventValue(event, metric, quotaAwareEventDisplay);
    const spendArr = ensureModel(perModelSpend, event.model);
    spendArr[idx] = (spendArr[idx] ?? 0) + chartSpendDollars(event, quotaAwareEventDisplay);
  }

  // Per-day (non-cumulative) totals per model.
  const datasets: ChartDataset[] = [];
  for (const [model, arr] of perModelDaily.entries()) {
    datasets.push({
      model,
      data: arr.slice(),
      spendByDay: (perModelSpend.get(model) ?? new Array(days.length).fill(0)).slice(),
    });
  }

  // Sort datasets by total over the range (descending) for consistent stacking order.
  const totalOf = (ds: ChartDataset) => ds.data.reduce((a, b) => a + (b ?? 0), 0);
  datasets.sort((a, b) => totalOf(b) - totalOf(a));

  return {
    labels: days.map((day) => formatChartDayLabel(day, locale)),
    dayMs: days,
    datasets,
  };
}

export type ModelBreakdownTotals = {
  model: string;
  requests: number;
  totalTokens: number;
  spendDollars: number;
};

function sumChartValues(values: number[]): number {
  return values.reduce((sum, value) => sum + (value ?? 0), 0);
}

/** Per-model requests/tokens/spend totals — same aggregation path as the usage chart. */
export function aggregateModelBreakdownTotals(
  events: UsageEvent[],
  dailySpend: DailySpendRow[],
  range: UsageDuration,
  resetAtIso: string | null,
  usageFilter: UsageFilter,
  now: number,
  quotaAwareEventDisplay = true,
): ModelBreakdownTotals[] {
  const tokensSeries = aggregateChartSeries(
    events, dailySpend, range, resetAtIso, "tokens", usageFilter, now, quotaAwareEventDisplay,
  );
  const requestsSeries = aggregateChartSeries(
    events, dailySpend, range, resetAtIso, "requests", usageFilter, now, quotaAwareEventDisplay,
  );
  const spendSeries = aggregateChartSeries(
    events, dailySpend, range, resetAtIso, "spend", usageFilter, now, quotaAwareEventDisplay,
  );

  const models = new Set<string>();
  for (const series of [tokensSeries, requestsSeries, spendSeries]) {
    for (const dataset of series.datasets) models.add(dataset.model);
  }

  const rows: ModelBreakdownTotals[] = [];
  for (const model of models) {
    const tokenData = tokensSeries.datasets.find((d) => d.model === model)?.data ?? [];
    const requestData = requestsSeries.datasets.find((d) => d.model === model)?.data ?? [];
    const spendData = spendSeries.datasets.find((d) => d.model === model)?.data ?? [];
    rows.push({
      model,
      totalTokens: sumChartValues(tokenData),
      requests: sumChartValues(requestData),
      spendDollars: sumChartValues(spendData),
    });
  }

  rows.sort((a, b) => b.totalTokens - a.totalTokens);
  return rows;
}

export type RangeSummary = {
  totalRequests: number;
  includedRequests: number;
  onDemandSpendDollars: number;
  totalTokens: number;
};

export function summarizeRange(
  events: UsageEvent[],
  range: UsageDuration,
  resetAtIso: string | null,
  now: number,
): RangeSummary {
  const cutoff = getDurationCutoff(range, resetAtIso, now);
  let includedRequests = 0;
  let totalTokens = 0;
  let onDemandSpendCents = 0;

  for (const event of events) {
    if (eventTimestampMs(event) < cutoff) continue;
    totalTokens += eventTokenCount(event);
    if (isIncluded(event)) includedRequests += eventRequestCount(event);
    onDemandSpendCents += billableSpendCents(event, true);
  }

  return {
    totalRequests: includedRequests,
    includedRequests,
    onDemandSpendDollars: onDemandSpendCents / 100,
    totalTokens,
  };
}

export const DEFAULT_EVENTS_PAGE_SIZE = 50;
export const EVENTS_PAGE_SIZES = [25, 50, 100, 200] as const;

export type PaginatedList<T> = {
  items: T[];
  totalItems: number;
  totalPages: number;
  page: number;
  pageSize: number;
  startIndex: number;
  endIndex: number;
};

export function paginateList<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): PaginatedList<T> {
  const safePageSize = Math.max(1, pageSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);

  return {
    items: items.slice(startIndex, endIndex),
    totalItems,
    totalPages,
    page: safePage,
    pageSize: safePageSize,
    startIndex,
    endIndex,
  };
}
