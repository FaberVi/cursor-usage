import type { DailySpendRow, UsageEvent, UsagePayload } from "./cursor-api";
import { CARD_HELP } from "./card-help";
import { getEurPerUsd } from "./eur-usd-rate";
import { getDurationCutoff, type UsageDuration } from "./model-breakdown";
import { eventRequestCount, eventTokenCount } from "./cursor-usage-parsing";
import {
  aggregateChartSeries,
  billableSpendCents,
  eventTimestampMs,
  isIncluded,
  matchesUsageFilter,
  type UsageFilter,
} from "./chart-series";

export type { ChartDataset, ChartMetric, ChartSeries, UsageFilter } from "./chart-series";
export {
  aggregateChartSeries,
  buildDayBuckets,
  filterEventsForChartRange,
  formatChartDayLabel,
} from "./chart-series";
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


export type ModelPricingState = {
  catalog: ModelPricingCatalog;
  usedModelIds: string[];
  theoreticalByModel: Record<string, TheoreticalModelCost>;
};

/** User-facing banner line with optional technical detail for the info control. */
export type DashboardNotice = {
  message: string;
  detail: string | null;
};

export function dashboardNotice(message: string, detail?: string | null): DashboardNotice {
  return { message, detail: detail ?? null };
}

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
  errorDetail: string | null;
  cardHelp: typeof CARD_HELP;
  conversationTitles: Record<string, string>;
  storedEventCount: number;
  /** SQLite rows whose model id is a Grok Bot slug. The activity Grok Bot list uses this count. */
  grokBotStoredEventCount: number;
  warnings: DashboardNotice[];
  eventsComplete: boolean;
  eventHistorySyncInProgress: boolean;
  /** USD to EUR multiplier used for display. Falls back to the bundled rate until a refresh. */
  eurPerUsd: number;
};


// The heavy per-event aggregations below are day-granular (UTC day buckets and
// billing-cycle cutoffs), so they can be reused across publishes within the
// same day while the input references stay unchanged.
const AGGREGATE_CACHE_DAY_MS = 86_400_000;
// Senza resetsAt valido il cutoff è now-31g e scorre infrasettimanente:
// si usa un bucket orario per limitare la finestra di dati stale.
const AGGREGATE_CACHE_HOUR_MS = 3_600_000;

type PricingAggregateCacheEntry = {
  events: UsageEvent[];
  resetsAt: string | null;
  bucket: number;
  catalog: ModelPricingCatalog;
  isTeamPlan: boolean;
  quotaAwareEventDisplay: boolean;
  value: ReturnType<typeof aggregateTheoreticalByModel>;
};
let pricingAggregateCache: PricingAggregateCacheEntry | null = null;

type PoolSeriesCacheEntry = {
  events: UsageEvent[];
  poolUsage: NonNullable<UsagePayload["poolUsage"]>;
  resetsAt: string | null;
  bucket: number;
  evenDailyShape: boolean;
  // buildPoolUsageSeries classifica i modelli via resolveModelPricing: un sync
  // del catalogo deve invalidare la serie come avviene per il pricing aggregate.
  catalog: ModelPricingCatalog;
  value: PoolUsageSeries | null;
};
let poolSeriesCache: PoolSeriesCacheEntry | null = null;

type PoolUsageSnapshot = NonNullable<UsagePayload["poolUsage"]>;

// poolUsage arriva come oggetto nuovo a ogni fetch: il confronto per
// riferimento non centrerebbe mai tra due refresh, quindi si confrontano i campi.
function samePoolUsageSnapshot(a: PoolUsageSnapshot, b: PoolUsageSnapshot): boolean {
  return (
    a.autoPercentUsed === b.autoPercentUsed &&
    a.apiPercentUsed === b.apiPercentUsed &&
    a.totalPercentUsed === b.totalPercentUsed
  );
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
  warnings: DashboardNotice[] = [],
  eventsComplete = true,
  eventHistorySyncInProgress = false,
  grokBotStoredEventCount = 0,
  errorDetail: string | null = null,
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
  const hasStableCycle = resetsAt !== null && !Number.isNaN(new Date(resetsAt).getTime());
  const aggregateBucket = Math.floor(
    now / (hasStableCycle ? AGGREGATE_CACHE_DAY_MS : AGGREGATE_CACHE_HOUR_MS),
  );
  const cachedPricing = pricingAggregateCache;
  const pricingAggregate =
    cachedPricing &&
    cachedPricing.events === events &&
    cachedPricing.resetsAt === resetsAt &&
    cachedPricing.bucket === aggregateBucket &&
    cachedPricing.catalog === catalog &&
    cachedPricing.isTeamPlan === isTeamPlan &&
    cachedPricing.quotaAwareEventDisplay === quotaAwareEventDisplay
      ? cachedPricing.value
      : aggregateTheoreticalByModel(
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
  pricingAggregateCache = {
    events,
    resetsAt,
    bucket: aggregateBucket,
    catalog,
    isTeamPlan,
    quotaAwareEventDisplay,
    value: pricingAggregate,
  };

  const evenDailyShape = !eventsComplete;
  const cachedPoolSeries = poolSeriesCache;
  const poolUsageSeries = poolUsage
    ? cachedPoolSeries &&
      cachedPoolSeries.events === eventsForPool &&
      samePoolUsageSnapshot(cachedPoolSeries.poolUsage, poolUsage) &&
      cachedPoolSeries.resetsAt === resetsAt &&
      cachedPoolSeries.bucket === aggregateBucket &&
      cachedPoolSeries.evenDailyShape === evenDailyShape &&
      cachedPoolSeries.catalog === catalog
      ? cachedPoolSeries.value
      : buildPoolUsageSeries(eventsForPool, poolUsage, resetsAt, now, {
          evenDailyShape,
        })
    : null;
  if (poolUsage) {
    poolSeriesCache = {
      events: eventsForPool,
      poolUsage,
      resetsAt,
      bucket: aggregateBucket,
      evenDailyShape,
      catalog,
      value: poolUsageSeries,
    };
  }

  return {
    generatedAt: now,
    data,
    events,
    dailySpend,
    resetsAt,
    isTeamMember,
    showPremiumRequests,
    quotaAwareEventDisplay,
    poolUsageSeries,
    poolDepletion: poolUsage
      ? projectPoolDepletion(poolUsage, resetsAt, now, poolUsageSeries ?? undefined)
      : null,
    poolRecommended: poolUsage ? computeRecommendedPoolUsage(resetsAt, now) : null,
    modelPricing: {
      catalog,
      usedModelIds: pricingAggregate.usedModelIds,
      theoreticalByModel: pricingAggregate.theoreticalByModel,
    },
    pricingCatalogSyncedAt: getPricingCatalogSyncedAt(),
    pricingRuntimeOnlyModels: getPricingRuntimeOnlyModels(),
    error,
    errorDetail,
    cardHelp: CARD_HELP,
    conversationTitles,
    storedEventCount,
    grokBotStoredEventCount,
    warnings,
    eventsComplete,
    eventHistorySyncInProgress,
    eurPerUsd: getEurPerUsd(),
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

export function filterDashboardEvents(
  events: UsageEvent[],
  prefs: { range: UsageDuration; usageFilter: UsageFilter } | null,
  resetAtIso: string | null,
  now: number,
): UsageEvent[] {
  if (!prefs) return events;
  return filterEventsForRange(events, prefs.range, resetAtIso, prefs.usageFilter, now);
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

