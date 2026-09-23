export type TokenRatesPerMillion = {
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  inputPlusCacheWrite?: number;
};

export type ModelPool = "firstParty" | "api" | "grokBot";

export type VariantPriceImpact =
  | "sameRateMoreTokens"
  | "rateMultiplier"
  | "inputMultiplier"
  | "customRates"
  | "separateModel";

export type ModelPricingVariant = {
  id: string;
  label: string;
  aliases?: string[];
  priceImpact: VariantPriceImpact;
  rateMultiplier?: number;
  inputRateMultiplier?: number;
  rates?: TokenRatesPerMillion;
  separateModelId?: string;
  description?: string;
  legacyNote?: string;
  requiresMaxMode?: boolean;
};

export type ModelPricingEntry = {
  id: string;
  displayName: string;
  provider: string;
  pool: ModelPool;
  rates: TokenRatesPerMillion;
  aliases?: string[];
  variants?: ModelPricingVariant[];
  hidden?: boolean;
  notes?: string;
  docsUrl?: string;
};

export type ResolvedModelPricing = {
  entry: ModelPricingEntry;
  variant: ModelPricingVariant | null;
  effectiveRates: TokenRatesPerMillion;
};

export type PlanPricingInfo = {
  id: string;
  name: string;
  priceMonthly: number;
  apiUsageIncluded: number;
};

/** Parsed from docs when the plans table omits explicit dollar amounts for API usage. */
export type ParsedPlanPricingInfo = Omit<PlanPricingInfo, "apiUsageIncluded"> & {
  apiUsageIncluded?: number;
};

export type ModelPricingCatalogOverlay = Omit<Partial<ModelPricingCatalog>, "plans"> & {
  plans?: ParsedPlanPricingInfo[];
};

export type ModelPricingCatalog = {
  sourceUrl: string;
  lastUpdated: string;
  cursorTokenRatePerMillion: number;
  plans: PlanPricingInfo[];
  models: ModelPricingEntry[];
};

export type ComponentCostBreakdown = {
  inputCents: number;
  cacheWriteCents: number;
  cacheReadCents: number;
  outputCents: number;
  cursorTokenFeeCents: number;
  totalCents: number;
};

export type TheoreticalModelCost = {
  modelId: string;
  eventModelIds: string[];
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  requests: number;
  actualSpendCents: number;
  /** Cursor API token value (included) or on-demand charge — matches official Included Usage. */
  reportedCostCents: number;
  /** Catalog-based estimate from public list prices. */
  theoreticalCents: number;
  deltaCents: number;
  deltaPercent: number | null;
};

export type EstimateEventOptions = {
  applyCursorTokenRate?: boolean;
  cursorTokenRatePerMillion?: number;
  /** When true, Actual spend counts only On-Demand charges (included pool usage = 0). */
  quotaAwareEventDisplay?: boolean;
};
