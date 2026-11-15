import type { UsageEvent } from "./cursor-api-types";
import { eventRequestCount, eventTokenCount } from "./cursor-usage-parsing";
import type { UsageDuration } from "./model-breakdown";
import { getDurationCutoff } from "./model-breakdown";
import type {
  ComponentCostBreakdown,
  EstimateEventOptions,
  LongContextPricing,
  ModelPricingEntry,
  TheoreticalModelCost,
  TokenRatesPerMillion,
} from "./model-pricing-types";
import { applyRateMultiplier } from "./model-pricing-match";
import {
  getModelPricingCatalog,
  resolveModelPricing,
  resolveModelPricingDetailed,
} from "./model-pricing-resolve";

const MILLION = 1_000_000;

function rateCostCents(tokens: number, ratePerMillion: number | undefined): number {
  if (!tokens || !ratePerMillion) return 0;
  return (tokens / MILLION) * ratePerMillion * 100;
}

export function estimateComponentCost(
  rates: TokenRatesPerMillion,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  },
  opts: EstimateEventOptions = {},
): ComponentCostBreakdown {
  let inputCents = 0;
  let cacheWriteCents = 0;

  if (rates.inputPlusCacheWrite !== undefined) {
    const promptTokens = tokens.inputTokens + tokens.cacheWriteTokens;
    inputCents = rateCostCents(promptTokens, rates.inputPlusCacheWrite);
  } else {
    inputCents = rateCostCents(tokens.inputTokens, rates.input);
    cacheWriteCents = rateCostCents(tokens.cacheWriteTokens, rates.cacheWrite);
  }

  const cacheReadCents = rateCostCents(tokens.cacheReadTokens, rates.cacheRead);
  const outputCents = rateCostCents(tokens.outputTokens, rates.output);

  const componentTotal = inputCents + cacheWriteCents + cacheReadCents + outputCents;
  const totalTokens =
    tokens.inputTokens + tokens.outputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens;
  const cursorTokenFeeCents =
    opts.applyCursorTokenRate && totalTokens > 0
      ? rateCostCents(totalTokens, opts.cursorTokenRatePerMillion ?? getModelPricingCatalog().cursorTokenRatePerMillion)
      : 0;

  return {
    inputCents,
    cacheWriteCents,
    cacheReadCents,
    outputCents,
    cursorTokenFeeCents,
    totalCents: componentTotal + cursorTokenFeeCents,
  };
}

function scaleCacheRates(rates: TokenRatesPerMillion, multiplier: number): TokenRatesPerMillion {
  const scale = (value: number | undefined) =>
    value === undefined ? undefined : value * multiplier;
  return {
    ...rates,
    cacheWrite: scale(rates.cacheWrite),
    cacheRead: scale(rates.cacheRead),
  };
}

function applyLongContextRates(
  rates: TokenRatesPerMillion,
  longContext: LongContextPricing,
): TokenRatesPerMillion {
  let next = rates;
  if (longContext.rateMultiplier) {
    next = applyRateMultiplier(next, longContext.rateMultiplier);
  }
  if (longContext.inputMultiplier) {
    next = applyRateMultiplier(next, longContext.inputMultiplier, true);
  }
  if (longContext.outputMultiplier && next.output !== undefined) {
    next = { ...next, output: next.output * longContext.outputMultiplier };
  }
  return next;
}

export function estimateEventTheoreticalCost(
  event: Pick<
    UsageEvent,
    | "model"
    | "inputTokens"
    | "outputTokens"
    | "cacheWriteTokens"
    | "cacheReadTokens"
    | "totalTokens"
    | "maxMode"
  >,
  entry: ModelPricingEntry,
  opts: EstimateEventOptions = {},
): ComponentCostBreakdown {
  const resolved = resolveModelPricingDetailed(event.model, event.maxMode);
  const pricedEntry = resolved?.entry ?? entry;
  let rates = resolved?.effectiveRates ?? entry.rates;
  const longContext = pricedEntry.longContext ?? entry.longContext;
  const inputTokens = event.inputTokens ?? 0;
  if (longContext && inputTokens > longContext.aboveInputTokens) {
    rates = applyLongContextRates(rates, longContext);
    if (
      longContext.fastCacheMultiplier &&
      resolved?.variant?.priceImpact === "rateMultiplier"
    ) {
      rates = scaleCacheRates(rates, longContext.fastCacheMultiplier);
    }
  }
  return estimateComponentCost(
    rates,
    {
      inputTokens,
      outputTokens: event.outputTokens ?? 0,
      cacheWriteTokens: event.cacheWriteTokens ?? 0,
      cacheReadTokens: event.cacheReadTokens ?? 0,
    },
    opts,
  );
}

export function formatRateUsd(rate: number | undefined): string {
  if (rate === undefined) return "—";
  return "$" + rate.toFixed(rate < 1 ? 3 : 2);
}

/** Cost shown on Cursor's Included Usage page — API token value for included rows, spend for on-demand. */
export function eventReportedUsageCostCents(
  event: Pick<UsageEvent, "kind" | "spendCents" | "tokenCostCents">,
): number {
  if (event.kind === "On-Demand") {
    return event.spendCents || 0;
  }
  const tokenCost = event.tokenCostCents || 0;
  if (tokenCost > 0) return tokenCost;
  return event.spendCents || 0;
}

export function aggregateTheoreticalByModel(
  events: UsageEvent[],
  duration: UsageDuration,
  resetAtIso: string | null,
  now: number,
  opts: EstimateEventOptions = {},
): { usedModelIds: string[]; theoreticalByModel: Record<string, TheoreticalModelCost> } {
  const cutoff = getDurationCutoff(duration, resetAtIso, now);
  const byCanonical = new Map<string, TheoreticalModelCost>();

  for (const event of events) {
    if (event.timestamp < cutoff) continue;
    const entry = resolveModelPricing(event.model);
    if (!entry) continue;

    const estimate = estimateEventTheoreticalCost(event, entry, opts);
    const existing = byCanonical.get(entry.id) ?? {
      modelId: entry.id,
      eventModelIds: [],
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      requests: 0,
      actualSpendCents: 0,
      reportedCostCents: 0,
      theoreticalCents: 0,
      deltaCents: 0,
      deltaPercent: null,
    };

    if (!existing.eventModelIds.includes(event.model)) {
      existing.eventModelIds.push(event.model);
    }
    existing.totalTokens += eventTokenCount(event);
    existing.inputTokens += event.inputTokens || 0;
    existing.outputTokens += event.outputTokens || 0;
    existing.cacheWriteTokens += event.cacheWriteTokens || 0;
    existing.cacheReadTokens += event.cacheReadTokens || 0;
    existing.requests += eventRequestCount(event);
    const billableSpend =
      opts.quotaAwareEventDisplay && event.kind !== "On-Demand" ? 0 : event.spendCents || 0;
    existing.actualSpendCents += billableSpend;
    existing.reportedCostCents += eventReportedUsageCostCents(event);
    existing.theoreticalCents += estimate.totalCents;
    byCanonical.set(entry.id, existing);
  }

  const theoreticalByModel: Record<string, TheoreticalModelCost> = {};
  const usedModelIds: string[] = [];

  for (const [modelId, row] of byCanonical.entries()) {
    row.deltaCents = row.reportedCostCents - row.theoreticalCents;
    row.deltaPercent =
      row.reportedCostCents > 0 && row.theoreticalCents > 0
        ? (row.deltaCents / row.theoreticalCents) * 100
        : null;
    theoreticalByModel[modelId] = row;
    usedModelIds.push(...row.eventModelIds);
  }

  return {
    usedModelIds: [...new Set(usedModelIds)].sort(),
    theoreticalByModel,
  };
}
