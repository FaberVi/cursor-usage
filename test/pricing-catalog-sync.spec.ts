/// <reference path="../types/bun-test.d.ts" />
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  getBundledModelPricingCatalog,
  getModelPricingCatalog,
  getPricingRuntimeOnlyModels,
  invalidatePricingCatalogCache,
  setPricingCatalogOverlay,
} from "../src/model-pricing";
import { mergeCatalogsWithStats } from "../src/pricing-catalog-merge";
import { PricingCatalogStore } from "../src/pricing-catalog-store";
import {
  buildOverlayFromMarkdown,
  parseCursorModelsTable,
  parseCursorTokenRate,
  parseMarkdownPlans,
  parseMarkdownPricingTable,
  syncPricingCatalogFromMarkdown,
} from "../src/pricing-catalog-sync";

const fixturePath = join(import.meta.dir, "fixtures", "models-and-pricing.md");
const fixtureMarkdown = readFileSync(fixturePath, "utf8");

afterEach(() => {
  setPricingCatalogOverlay(null, null, null);
  invalidatePricingCatalogCache();
});

describe("pricing catalog sync parser", () => {
  it("parses model pricing rows from markdown", () => {
    const rows = parseMarkdownPricingTable(fixtureMarkdown);
    expect(rows.length).toBe(7);
    expect(rows[0]?.displayName).toBe("Claude Opus 5");
    expect(rows[0]?.rates.output).toBe(25);
    expect(rows[1]?.displayName).toBe("Claude Fable 5.1");
    expect(rows[1]?.rates.cacheRead).toBe(0.25);
    expect(rows[3]?.hidden).toBe(true);
    expect(rows[5]?.hidden).toBe(true);
  });

  it("parses Cursor Models base rows and skips Fast variants", () => {
    const rows = parseCursorModelsTable(fixtureMarkdown);
    expect(rows.map((row) => row.displayName)).toEqual(["Grok 4.7", "Grok 4.6", "Grok 4.5", "Composer 2.5"]);
    expect(rows[0]?.rates.input).toBe(2);
    expect(rows[0]?.rates.output).toBe(6);
  });

  it("parses Cursor models table under Included usage (X Subscription docs)", () => {
    const markdown = `### Cursor models

| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |
| Grok 4.7 500k | Cursor | $4 | - | $1 | $12 | Yes | - |
| Grok 4.7 500k (Fast) | Cursor | $6 | - | $1.5 | $18 | Yes | - |
`;
    const rows = parseCursorModelsTable(markdown);
    expect(rows.map((row) => row.displayName)).toEqual(["Grok 4.7 500k"]);
    expect(rows[0]?.rates.output).toBe(12);
  });

  it("parses plans and cursor token rate", () => {
    const plans = parseMarkdownPlans(fixtureMarkdown);
    expect(plans.map((plan) => plan.id)).toEqual(["start", "pro", "pro-plus"]);
    expect(plans[0]?.priceMonthly).toBe(649);
    expect(plans[0]?.apiUsageIncluded).toBe(0);
    expect(plans[1]?.apiUsageIncluded).toBeUndefined();
    expect(parseCursorTokenRate(fixtureMarkdown)).toBe(0.25);
  });

  it("preserves bundled apiUsageIncluded when plans table omits dollar amounts", () => {
    const bundled = getBundledModelPricingCatalog();
    const { overlay } = buildOverlayFromMarkdown(fixtureMarkdown, bundled);
    const { catalog } = mergeCatalogsWithStats(bundled, overlay);
    const pro = catalog.plans.find((plan) => plan.id === "pro");
    const proPlus = catalog.plans.find((plan) => plan.id === "pro-plus");
    expect(pro?.apiUsageIncluded).toBe(20);
    expect(proPlus?.apiUsageIncluded).toBe(70);
    expect(catalog.plans.find((plan) => plan.id === "start")?.apiUsageIncluded).toBe(0);
  });

  it("builds overlay and merges with bundled catalog", () => {
    const bundled = getBundledModelPricingCatalog();
    const { overlay, updated, added, runtimeOnlyModelIds } = buildOverlayFromMarkdown(
      fixtureMarkdown,
      bundled,
    );
    expect(updated).toBeGreaterThanOrEqual(5);
    expect(added).toBe(1);
    expect(runtimeOnlyModelIds).toEqual(["future-model-x"]);
    expect(overlay.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const { catalog, stats } = mergeCatalogsWithStats(bundled, overlay);
    expect(stats.updated).toBe(updated);
    const kimi = catalog.models.find((entry) => entry.id === "kimi-k3");
    expect(kimi?.hidden).toBe(true);
    expect(kimi?.rates.output).toBe(15);
    const grok46 = catalog.models.find((entry) => entry.id === "grok-4.6");
    expect(grok46?.pool).toBe("firstParty");
    expect(grok46?.rates.input).toBe(2);
  });

  it("applies runtime overlay without changing bundled aliases", () => {
    const bundled = getBundledModelPricingCatalog();
    const opus = bundled.models.find((entry) => entry.id === "claude-opus-5");
    expect(opus).toBeDefined();

    setPricingCatalogOverlay({
      lastUpdated: "2099-01-01",
      models: [
        {
          id: "claude-opus-5",
          displayName: "Claude Opus 5",
          provider: "Anthropic",
          pool: "api",
          rates: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 42 },
        },
      ],
    });

    const merged = getModelPricingCatalog();
    expect(merged.lastUpdated).toBe("2099-01-01");
    expect(merged.models.find((entry) => entry.id === "claude-opus-5")?.rates.output).toBe(42);
    expect(merged.models.find((entry) => entry.id === "claude-opus-5")?.variants?.length).toBe(
      opus?.variants?.length,
    );
  });

  it("exposes runtime-only models until bundled catches up", () => {
    setPricingCatalogOverlay(
      {
        models: [
          {
            id: "future-model-x",
            displayName: "Future Model X",
            provider: "Example",
            pool: "api",
            rates: { input: 9, cacheRead: 0.9, output: 45 },
          },
        ],
      },
      Date.now(),
      ["future-model-x"],
    );

    expect(getPricingRuntimeOnlyModels()).toEqual([
      { id: "future-model-x", displayName: "Future Model X" },
    ]);

    setPricingCatalogOverlay(
      {
        models: [
          {
            id: "claude-opus-5",
            displayName: "Claude Opus 5",
            provider: "Anthropic",
            pool: "api",
            rates: { input: 5, output: 25 },
          },
        ],
      },
      Date.now(),
      [],
    );
    expect(getPricingRuntimeOnlyModels()).toEqual([]);
  });

  it("persists overlay via store", async () => {
    const dir = join(import.meta.dir, ".tmp-pricing-store");
    const store = new PricingCatalogStore(dir);
    store.clear();

    const result = await syncPricingCatalogFromMarkdown(fixtureMarkdown, store);
    expect(result.updated).toBeGreaterThanOrEqual(3);
    expect(result.added).toBe(1);
    expect(result.runtimeOnlyModelIds).toEqual(["future-model-x"]);
    const loaded = store.load();
    expect(loaded?.catalog.models?.length).toBeGreaterThanOrEqual(7);
    expect(loaded?.runtimeOnlyModelIds).toEqual(["future-model-x"]);
    store.clear();
  });
});
