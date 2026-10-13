/** Match an API model slug to a catalog entry and variant. */
import type {
  ModelPricingEntry,
  ModelPricingVariant,
  ResolvedModelPricing,
  TokenRatesPerMillion,
} from "./model-pricing-types";

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/** Longest-first suffixes stripped from unknown API slugs before resolving the base model. */
const MODEL_ID_STRIP_SUFFIXES = [
  "-thinking-xhigh",
  "-thinking-high",
  "-thinking-medium",
  "-thinking-low",
  "-medium-thinking",
  "-high-thinking",
  "-xhigh-thinking",
  "-thinking",
  "-xhigh",
  "-medium",
  "-high",
  "-fast",
] as const;

const THINKING_EFFORT_TIERS = ["xhigh", "high", "medium", "low"] as const;

function slugForms(slug: string): string[] {
  const forms = new Set<string>([slug]);
  if (slug.includes(".")) forms.add(slug.replace(/\./g, "-"));
  if (slug.includes("-")) forms.add(slug.replace(/-/g, "."));
  return [...forms];
}

function isThinkingLikeVariant(variant: ModelPricingVariant): boolean {
  const id = variant.id.toLowerCase();
  const label = variant.label.toLowerCase();
  return id.includes("thinking") || label.includes("thinking");
}

function isReasoningEffortVariant(variant: ModelPricingVariant): boolean {
  if (variant.priceImpact !== "sameRateMoreTokens") return false;
  const id = variant.id.toLowerCase();
  const label = variant.label.toLowerCase();
  return id === "high" || id === "medium" || label.includes("reasoning") || isThinkingLikeVariant(variant);
}

export function generateVariantAliases(entry: ModelPricingEntry, variant: ModelPricingVariant): string[] {
  const out = new Set<string>(variant.aliases ?? []);
  const roots = new Set<string>([entry.id, ...(entry.aliases ?? [])]);
  for (const alias of variant.aliases ?? []) roots.add(alias);

  for (const root of roots) {
    for (const form of slugForms(root)) {
      if (isThinkingLikeVariant(variant)) {
        out.add(`${form}-thinking`);
        for (const effort of THINKING_EFFORT_TIERS) {
          out.add(`${form}-thinking-${effort}`);
          out.add(`${form}-${effort}-thinking`);
        }
        if (variant.id === "medium-thinking") {
          out.add(`${form}-medium-thinking`);
          out.add(`${form}-thinking-medium`);
        }
        if (variant.id === "high-thinking") {
          out.add(`${form}-high-thinking`);
        }
      }

      if (variant.id === "high" && isReasoningEffortVariant(variant)) {
        out.add(`${form}-high`);
        for (const effort of THINKING_EFFORT_TIERS) {
          if (effort !== "high") out.add(`${form}-${effort}`);
        }
      }

      if (variant.id === "medium" && variant.priceImpact === "sameRateMoreTokens") {
        out.add(`${form}-medium`);
        for (const effort of THINKING_EFFORT_TIERS) {
          if (effort !== "medium") out.add(`${form}-${effort}`);
        }
      }
    }
  }

  return [...out];
}

function findReasoningVariant(entry: ModelPricingEntry): ModelPricingVariant | null {
  const variants = entry.variants ?? [];
  return (
    variants.find((variant) => isThinkingLikeVariant(variant)) ??
    variants.find((variant) => variant.id === "high-thinking" || variant.id === "medium-thinking") ??
    variants.find((variant) => isReasoningEffortVariant(variant)) ??
    null
  );
}

function stripModelSuffixes(normalized: string): string {
  let id = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of MODEL_ID_STRIP_SUFFIXES) {
      if (id.endsWith(suffix)) {
        id = id.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return id;
}

export type ModelLookup = (id: string) => ModelPricingEntry | undefined;

export function registerAlias(
  index: Map<string, ResolvedModelPricing>,
  alias: string,
  resolved: ResolvedModelPricing,
): void {
  for (const form of slugForms(alias)) {
    index.set(normalizeModelId(form), resolved);
  }
}

export function applyRateMultiplier(
  rates: TokenRatesPerMillion,
  multiplier: number,
  inputOnly = false,
): TokenRatesPerMillion {
  const scale = (value: number | undefined) =>
    value === undefined ? undefined : value * multiplier;
  if (inputOnly) {
    return {
      ...rates,
      input: scale(rates.input),
      inputPlusCacheWrite: scale(rates.inputPlusCacheWrite),
    };
  }
  return {
    input: scale(rates.input),
    cacheWrite: scale(rates.cacheWrite),
    cacheRead: scale(rates.cacheRead),
    output: scale(rates.output),
    inputPlusCacheWrite: scale(rates.inputPlusCacheWrite),
  };
}

export function resolveEffectiveRates(
  entry: ModelPricingEntry,
  variant: ModelPricingVariant | null,
  maxMode = false,
  findModel?: ModelLookup,
): TokenRatesPerMillion {
  if (variant?.priceImpact === "separateModel" && variant.separateModelId) {
    const separate = findModel?.(variant.separateModelId);
    if (separate) return separate.rates;
  }
  if (variant?.priceImpact === "customRates" && variant.rates) {
    return variant.rates;
  }

  let rates = entry.rates;
  if (variant?.priceImpact === "rateMultiplier" && variant.rateMultiplier) {
    rates = applyRateMultiplier(rates, variant.rateMultiplier);
  }
  if (variant?.priceImpact === "inputMultiplier" && variant.inputRateMultiplier) {
    rates = applyRateMultiplier(rates, variant.inputRateMultiplier, true);
  }
  if (variant?.requiresMaxMode && !maxMode) {
    return rates;
  }
  if (maxMode) {
    const maxVariant = entry.variants?.find((v) => v.id === "max-long-context");
    if (maxVariant?.inputRateMultiplier) {
      rates = applyRateMultiplier(rates, maxVariant.inputRateMultiplier, true);
    }
  }
  return rates;
}

export function resolveFromAliasIndex(
  index: Map<string, ResolvedModelPricing> | null,
  modelId: string,
): ResolvedModelPricing | null {
  if (!index) return null;
  return index.get(normalizeModelId(modelId)) ?? null;
}

function resolveThinkingFallback(
  index: Map<string, ResolvedModelPricing> | null,
  normalized: string,
  findModel?: ModelLookup,
): ResolvedModelPricing | null {
  const baseId = stripModelSuffixes(normalized);
  const base = resolveFromAliasIndex(index, baseId);
  if (!base) return null;

  const reasoning = findReasoningVariant(base.entry);
  if (reasoning) {
    return {
      entry: base.entry,
      variant: reasoning,
      effectiveRates: resolveEffectiveRates(base.entry, reasoning, false, findModel),
    };
  }

  return base;
}

export function resolveWithSuffixFallback(
  index: Map<string, ResolvedModelPricing> | null,
  modelId: string,
  findModel?: ModelLookup,
): ResolvedModelPricing | null {
  const normalized = normalizeModelId(modelId);

  for (const suffix of MODEL_ID_STRIP_SUFFIXES) {
    if (!normalized.endsWith(suffix)) continue;
    const stem = normalized.slice(0, -suffix.length);
    let parent = resolveFromAliasIndex(index, stem);

    if (!parent && normalized.includes("thinking")) {
      parent = resolveFromAliasIndex(index, stripModelSuffixes(normalized));
    }

    if (!parent) continue;

    if (suffix === "-fast") {
      const fastVariant = parent.entry.variants?.find((variant) => variant.id === "fast");
      if (fastVariant) {
        return {
          entry: parent.entry,
          variant: fastVariant,
          effectiveRates: resolveEffectiveRates(parent.entry, fastVariant, false, findModel),
        };
      }
    }

    const wantsThinking = suffix.includes("thinking") || normalized.includes("thinking");
    if (wantsThinking && !parent.variant) {
      const reasoning = findReasoningVariant(parent.entry);
      if (reasoning) {
        return {
          entry: parent.entry,
          variant: reasoning,
          effectiveRates: resolveEffectiveRates(parent.entry, reasoning, false, findModel),
        };
      }
    }

    return {
      entry: parent.entry,
      variant: parent.variant,
      effectiveRates: resolveEffectiveRates(parent.entry, parent.variant, false, findModel),
    };
  }

  if (normalized.includes("thinking")) {
    return resolveThinkingFallback(index, normalized, findModel);
  }

  return null;
}
