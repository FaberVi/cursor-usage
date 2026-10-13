/** Per-day usage chart series built from filtered events. */
import type { UsageEvent } from "./cursor-api";
import { parseTimestamp } from "./cursor-api-utils";
import { eventRequestCount, eventTokenCount } from "./cursor-usage-parsing";
import { getDurationCutoff, type UsageDuration } from "./model-breakdown";
import { startOfUtcDay } from "./utc-day";

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

const DAY_MS = 86_400_000;

export function isIncluded(event: UsageEvent): boolean {
  return event.kind === "Included";
}

function isOnDemand(event: UsageEvent): boolean {
  return event.kind === "On-Demand";
}

export function billableSpendCents(event: UsageEvent, quotaAwareEventDisplay: boolean): number {
  return quotaAwareEventDisplay && !isOnDemand(event) ? 0 : event.spendCents;
}

export function matchesUsageFilter(event: UsageEvent, filter: UsageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "included") return isIncluded(event);
  return isOnDemand(event);
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

export function eventTimestampMs(event: UsageEvent): number {
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
