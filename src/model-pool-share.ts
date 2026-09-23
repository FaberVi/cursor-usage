import type { UsageEvent } from "./cursor-api-types";
import { countsTowardCursorMonthlyPools, isAutoPoolEvent, poolIncludedCostCents } from "./pool-usage-series";
import { startOfUtcDay } from "./utc-day";

export type ModelPoolKind = "firstParty" | "api";

export type ModelPoolMetrics = {
  pool: ModelPoolKind;
  poolSharePercent: number;
  quotaPointsPercent: number;
};

export type ModelDaySpend = {
  auto: number[];
  api: number[];
};

export type PoolSpendIndex = {
  autoByDay: number[];
  apiByDay: number[];
  modelByDay: Map<string, ModelDaySpend>;
};

function emptyDayArray(length: number): number[] {
  return new Array(length).fill(0);
}

function ensureModelDay(index: PoolSpendIndex, modelId: string, dayCount: number): ModelDaySpend {
  let entry = index.modelByDay.get(modelId);
  if (!entry) {
    entry = { auto: emptyDayArray(dayCount), api: emptyDayArray(dayCount) };
    index.modelByDay.set(modelId, entry);
  }
  return entry;
}

export function buildPoolSpendIndex(
  events: UsageEvent[],
  dayMs: number[],
  cycleStart: number,
): PoolSpendIndex {
  const dayCount = dayMs.length;
  const dayIndex = new Map(dayMs.map((day, i) => [day, i]));
  const index: PoolSpendIndex = {
    autoByDay: emptyDayArray(dayCount),
    apiByDay: emptyDayArray(dayCount),
    modelByDay: new Map(),
  };

  for (const event of events) {
    if (event.timestamp < cycleStart) continue;
    if (!countsTowardCursorMonthlyPools(event)) continue;
    const cost = poolIncludedCostCents(event);
    if (cost <= 0) continue;
    const day = startOfUtcDay(event.timestamp);
    const idx = dayIndex.get(day);
    if (idx === undefined) continue;

    const model = ensureModelDay(index, event.model, dayCount);
    if (isAutoPoolEvent(event)) {
      index.autoByDay[idx] = (index.autoByDay[idx] ?? 0) + cost;
      model.auto[idx] = (model.auto[idx] ?? 0) + cost;
    } else {
      index.apiByDay[idx] = (index.apiByDay[idx] ?? 0) + cost;
      model.api[idx] = (model.api[idx] ?? 0) + cost;
    }
  }

  return index;
}

function metricsForDaySpend(
  modelSpend: number,
  poolSpend: number,
  dailyPoolPercent: number,
  pool: ModelPoolKind,
): ModelPoolMetrics | null {
  if (modelSpend <= 0 || poolSpend <= 0) return null;
  const poolSharePercent = (modelSpend / poolSpend) * 100;
  const quotaPointsPercent = (poolSharePercent * dailyPoolPercent) / 100;
  return { pool, poolSharePercent, quotaPointsPercent };
}

export function computeModelPoolMetricsForDay(
  modelId: string,
  dayIndex: number,
  index: PoolSpendIndex,
  dailyAutoPercent: number[],
  dailyApiPercent: number[],
): ModelPoolMetrics | null {
  if (dayIndex < 0 || dayIndex >= index.autoByDay.length) return null;
  const model = index.modelByDay.get(modelId);
  if (!model) return null;

  const autoSpend = model.auto[dayIndex] ?? 0;
  const apiSpend = model.api[dayIndex] ?? 0;

  if (autoSpend > 0) {
    return metricsForDaySpend(
      autoSpend,
      index.autoByDay[dayIndex] ?? 0,
      dailyAutoPercent[dayIndex] ?? 0,
      "firstParty",
    );
  }
  if (apiSpend > 0) {
    return metricsForDaySpend(
      apiSpend,
      index.apiByDay[dayIndex] ?? 0,
      dailyApiPercent[dayIndex] ?? 0,
      "api",
    );
  }
  return null;
}

export function computeModelPoolMetricsForRange(
  modelId: string,
  dayIndices: number[],
  index: PoolSpendIndex,
  dailyAutoPercent: number[],
  dailyApiPercent: number[],
): ModelPoolMetrics | null {
  const model = index.modelByDay.get(modelId);
  if (!model || dayIndices.length === 0) return null;

  let autoSpend = 0;
  let apiSpend = 0;
  let autoPoolSpend = 0;
  let apiPoolSpend = 0;
  let autoQuota = 0;
  let apiQuota = 0;

  for (const dayIndex of dayIndices) {
    if (dayIndex < 0 || dayIndex >= index.autoByDay.length) continue;
    const dayAuto = model.auto[dayIndex] ?? 0;
    const dayApi = model.api[dayIndex] ?? 0;
    const poolAuto = index.autoByDay[dayIndex] ?? 0;
    const poolApi = index.apiByDay[dayIndex] ?? 0;

    autoSpend += dayAuto;
    apiSpend += dayApi;
    autoPoolSpend += poolAuto;
    apiPoolSpend += poolApi;

    if (dayAuto > 0 && poolAuto > 0) {
      const share = (dayAuto / poolAuto) * 100;
      autoQuota += (share * (dailyAutoPercent[dayIndex] ?? 0)) / 100;
    }
    if (dayApi > 0 && poolApi > 0) {
      const share = (dayApi / poolApi) * 100;
      apiQuota += (share * (dailyApiPercent[dayIndex] ?? 0)) / 100;
    }
  }

  // Prefer the pool with more included spend for this model in the range.
  if (autoSpend >= apiSpend && autoSpend > 0 && autoPoolSpend > 0) {
    return {
      pool: "firstParty",
      poolSharePercent: (autoSpend / autoPoolSpend) * 100,
      quotaPointsPercent: autoQuota,
    };
  }
  if (apiSpend > 0 && apiPoolSpend > 0) {
    return {
      pool: "api",
      poolSharePercent: (apiSpend / apiPoolSpend) * 100,
      quotaPointsPercent: apiQuota,
    };
  }
  return null;
}

export function dayIndicesInRange(
  dayMs: number[],
  cutoffMs: number,
  endMs: number = Number.POSITIVE_INFINITY,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < dayMs.length; i++) {
    const day = dayMs[i]!;
    if (day >= cutoffMs && day <= endMs) indices.push(i);
  }
  return indices;
}
