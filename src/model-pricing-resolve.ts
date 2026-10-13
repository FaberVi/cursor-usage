import rawCatalog from "./data/model-pricing.json";
import {
  generateVariantAliases,
  registerAlias,
  resolveEffectiveRates,
  resolveFromAliasIndex,
  resolveWithSuffixFallback,
} from "./model-pricing-match";
import { mergeCatalogs } from "./pricing-catalog-merge";
import type {
  ModelPricingCatalog,
  ModelPricingCatalogOverlay,
  ModelPricingEntry,
  ModelPricingVariant,
  ResolvedModelPricing,
} from "./model-pricing-types";

function validateCatalog(data: unknown): ModelPricingCatalog {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid model pricing catalog");
  }
  const catalog = data as ModelPricingCatalog;
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("Model pricing catalog has no models");
  }
  for (const entry of catalog.models) {
    if (!entry.rates.output && !entry.rates.inputPlusCacheWrite) {
      throw new Error(`Model ${entry.id} is missing output pricing`);
    }
  }
  return catalog;
}

let cachedCatalog: ModelPricingCatalog | null = null;
let aliasIndex: Map<string, ResolvedModelPricing> | null = null;
let catalogOverlay: ModelPricingCatalogOverlay | null = null;
let pricingCatalogSyncedAt: number | null = null;
let catalogRuntimeOnlyModelIds: string[] = [];

export type RuntimeOnlyPricingModel = {
  id: string;
  displayName: string;
};

function normalizeDisplayNameForMatch(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function setPricingCatalogOverlay(
  overlay: ModelPricingCatalogOverlay | null,
  syncedAt?: number | null,
  runtimeOnlyModelIds?: string[] | null,
): void {
  catalogOverlay = overlay;
  pricingCatalogSyncedAt = syncedAt ?? null;
  catalogRuntimeOnlyModelIds = overlay ? (runtimeOnlyModelIds ?? []) : [];
  invalidatePricingCatalogCache();
}

export function getPricingRuntimeOnlyModels(): RuntimeOnlyPricingModel[] {
  if (!catalogRuntimeOnlyModelIds.length) return [];

  const bundled = getBundledModelPricingCatalog();
  const merged = getModelPricingCatalog();

  return catalogRuntimeOnlyModelIds
    .map((id) => merged.models.find((entry) => entry.id === id))
    .filter((entry): entry is ModelPricingEntry => !!entry)
    .filter(
      (entry) =>
        !bundled.models.some(
          (bundledEntry) =>
            bundledEntry.id === entry.id ||
            normalizeDisplayNameForMatch(bundledEntry.displayName) ===
              normalizeDisplayNameForMatch(entry.displayName),
        ),
    )
    .map((entry) => ({ id: entry.id, displayName: entry.displayName }));
}

export function getPricingCatalogSyncedAt(): number | null {
  return pricingCatalogSyncedAt;
}

export function invalidatePricingCatalogCache(): void {
  cachedCatalog = null;
  aliasIndex = null;
}

export function getBundledModelPricingCatalog(): ModelPricingCatalog {
  return validateCatalog(rawCatalog);
}

export { validateCatalog };

function findCatalogModel(id: string): ModelPricingEntry | undefined {
  return getModelPricingCatalog().models.find((entry) => entry.id === id);
}

function buildAliasIndex(catalog: ModelPricingCatalog): Map<string, ResolvedModelPricing> {
  const index = new Map<string, ResolvedModelPricing>();
  for (const entry of catalog.models) {
    const baseResolved: ResolvedModelPricing = {
      entry,
      variant: null,
      effectiveRates: entry.rates,
    };
    registerAlias(index, entry.id, baseResolved);
    for (const alias of entry.aliases ?? []) {
      registerAlias(index, alias, baseResolved);
    }
    for (const variant of entry.variants ?? []) {
      const variantResolved: ResolvedModelPricing = {
        entry,
        variant,
        effectiveRates: resolveEffectiveRates(entry, variant, false, (id) =>
          catalog.models.find((model) => model.id === id),
        ),
      };
      for (const alias of generateVariantAliases(entry, variant)) {
        registerAlias(index, alias, variantResolved);
      }
    }
  }
  return index;
}

export function getModelPricingCatalog(): ModelPricingCatalog {
  if (!cachedCatalog) {
    const bundled = getBundledModelPricingCatalog();
    cachedCatalog = validateCatalog(mergeCatalogs(bundled, catalogOverlay));
    aliasIndex = buildAliasIndex(cachedCatalog);
  }
  return cachedCatalog;
}

export function resolveModelPricingDetailed(
  modelId: string,
  maxMode = false,
): ResolvedModelPricing | null {
  getModelPricingCatalog();
  const resolved =
    resolveFromAliasIndex(aliasIndex, modelId) ??
    resolveWithSuffixFallback(aliasIndex, modelId, findCatalogModel);
  if (!resolved) return null;
  return {
    ...resolved,
    effectiveRates: resolveEffectiveRates(resolved.entry, resolved.variant, maxMode, findCatalogModel),
  };
}

export function resolveModelPricing(modelId: string): ModelPricingEntry | null {
  return resolveModelPricingDetailed(modelId)?.entry ?? null;
}

export function formatVariantPriceImpact(variant: ModelPricingVariant): string {
  if (variant.priceImpact === "sameRateMoreTokens") {
    return "same $/M, more tokens";
  }
  if (variant.priceImpact === "rateMultiplier" && variant.rateMultiplier) {
    return variant.rateMultiplier + "× all rates";
  }
  if (variant.priceImpact === "inputMultiplier" && variant.inputRateMultiplier) {
    return variant.inputRateMultiplier + "× input";
  }
  if (variant.priceImpact === "customRates") {
    return "custom rates";
  }
  if (variant.priceImpact === "separateModel" && variant.separateModelId) {
    return "→ " + variant.separateModelId;
  }
  return variant.priceImpact;
}

