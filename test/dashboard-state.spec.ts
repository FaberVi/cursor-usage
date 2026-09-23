import { describe, expect, it } from "bun:test";
import type { UsageEvent, UsagePayload } from "../src/cursor-api";
import {
  aggregateChartSeries,
  aggregateModelBreakdownTotals,
  buildDashboardState,
  filterEventsForChartRange,
  filterEventsForRange,
  paginateList,
  summarizeRange,
} from "../src/dashboard-state";

const dayMs = 86_400_000;
const now = Date.UTC(2026, 3, 20, 12, 0, 0);

const baseEvent = {
  spendCents: 0,
  maxMode: false,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  tokenCostCents: 0,
  cursorTokenFee: 0,
  isTokenBasedCall: false,
  isHeadless: false,
  isChargeable: true,
  conversationId: null,
};

const sampleData: UsagePayload = {
  includedRequests: { used: 100, limit: 500 },
  onDemand: { state: "limited", onDemandEnabled: true, spendDollars: 12.5, limitDollars: 100 },
  poolUsage: null,
  grokBotUsage: null,
  planInfo: null,
  resetsAt: null,
};

const sampleEvents: UsageEvent[] = [
  { ...baseEvent, timestamp: now - 1 * dayMs, model: "gpt-5.3-codex", kind: "Included", totalTokens: 2000, requests: 2 },
  { ...baseEvent, timestamp: now - 1 * dayMs, model: "gpt-5.3-codex", kind: "On-Demand", totalTokens: 3000, requests: 1.5, spendCents: 320, maxMode: true },
  { ...baseEvent, timestamp: now - 2 * dayMs, model: "composer-2", kind: "Included", totalTokens: 500, requests: 4 },
  { ...baseEvent, timestamp: now - 2 * dayMs, model: "composer-2", kind: "On-Demand", totalTokens: 100, requests: 0.6, spendCents: 50 },
  { ...baseEvent, timestamp: now - 8 * dayMs, model: "gpt-5.3-codex", kind: "Included", totalTokens: 9999, requests: 9 },
];

describe("buildDashboardState", () => {
  it("returns a serializable snapshot of inputs", () => {
    const state = buildDashboardState(sampleData, sampleEvents, [], true, null, now);
    expect(state.generatedAt).toBe(now);
    expect(state.data).toBe(sampleData);
    expect(state.events.length).toBe(5);
    expect(state.isTeamMember).toBeTrue();
    expect(state.showPremiumRequests).toBeTrue();
    expect(state.quotaAwareEventDisplay).toBeTrue();
    expect(state.poolUsageSeries).toBeNull();
    expect(state.poolDepletion).toBeNull();
    expect(state.poolRecommended).toBeNull();
    expect(state.error).toBeNull();
    expect(state.resetsAt).toBeNull();
    expect(state.warnings).toEqual([]);
    expect(state.eventsComplete).toBeTrue();
    expect(state.cardHelp.includedRequests).toContain("Legacy");
  });

  it("propagates warnings and eventsComplete flags", () => {
    const state = buildDashboardState(
      sampleData,
      sampleEvents,
      [],
      false,
      null,
      now,
      true,
      {},
      0,
      sampleEvents,
      ["Events outdated"],
      false,
    );
    expect(state.warnings).toEqual(["Events outdated"]);
    expect(state.eventsComplete).toBeFalse();
  });

  it("hides legacy request counter for team accounts with pool usage", () => {
    const teamData: UsagePayload = {
      ...sampleData,
      planInfo: {
        accountType: "team",
        planKind: "enterprise",
        seatType: null,
        tier: "Enterprise",
        priceLabel: null,
        displayName: "Enterprise",
      },
      poolUsage: { autoPercentUsed: 50, apiPercentUsed: 100, totalPercentUsed: 75 },
    };
    const state = buildDashboardState(teamData, [], [], true, null, now);
    expect(state.showPremiumRequests).toBeFalse();
  });

  it("shows legacy request counter for personal accounts without pool usage", () => {
    const state = buildDashboardState(sampleData, [], [], false, null, now);
    expect(state.showPremiumRequests).toBeTrue();
  });

  it("propagates resetsAt from data", () => {
    const dataWithReset: UsagePayload = { ...sampleData, resetsAt: "2026-05-01T00:00:00.000Z" };
    const state = buildDashboardState(dataWithReset, [], [], false, null, now);
    expect(state.resetsAt).toBe("2026-05-01T00:00:00.000Z");
    expect(state.isTeamMember).toBeFalse();
  });

  it("handles null data without throwing", () => {
    const state = buildDashboardState(null, [], [], false, "boom", now);
    expect(state.data).toBeNull();
    expect(state.error).toBe("boom");
  });

  it("keeps pool daily budget independent of the display event range", () => {
    const poolNow = Date.UTC(2026, 6, 14, 12, 0, 0);
    const resetsAt = "2026-08-02T15:37:46.000Z";
    const early = Date.UTC(2026, 6, 3, 14, 0, 0);
    const recent = Date.UTC(2026, 6, 14, 10, 0, 0);
    const poolData: UsagePayload = {
      ...sampleData,
      resetsAt,
      poolUsage: { autoPercentUsed: 40, apiPercentUsed: 20, totalPercentUsed: 30 },
      planInfo: {
        accountType: "individual",
        planKind: "ultra",
        seatType: null,
        tier: "Ultra",
        priceLabel: null,
        displayName: "Ultra",
      },
    };
    const cycleEvents: UsageEvent[] = [
      {
        ...baseEvent,
        timestamp: early,
        model: "default",
        kind: "Included",
        totalTokens: 1000,
        requests: 1,
        spendCents: 200,
      },
      {
        ...baseEvent,
        timestamp: recent,
        model: "default",
        kind: "Included",
        totalTokens: 1000,
        requests: 1,
        spendCents: 50,
      },
    ];
    const recentOnly = cycleEvents.filter((e) => e.timestamp >= poolNow - 2 * dayMs);
    const withFilteredOnly = buildDashboardState(poolData, recentOnly, [], false, null, poolNow);
    const withFullPoolHistory = buildDashboardState(
      poolData,
      recentOnly,
      [],
      false,
      null,
      poolNow,
      true,
      {},
      0,
      cycleEvents,
    );

    expect(recentOnly).toHaveLength(1);
    expect(withFilteredOnly.poolUsageSeries?.todayAutoPace?.used).toBeCloseTo(40, 5);
    expect(withFullPoolHistory.poolUsageSeries?.todayAutoPace?.used).toBeCloseTo(8, 5);
    expect(withFullPoolHistory.events).toEqual(recentOnly);
  });
});

describe("filterEventsForRange", () => {
  it("respects the 7d cutoff", () => {
    const filtered = filterEventsForRange(sampleEvents, "7d", null, "all", now);
    expect(filtered.length).toBe(4); // 8-day-old excluded
  });

  it("includes everything in 30d", () => {
    const filtered = filterEventsForRange(sampleEvents, "30d", null, "all", now);
    expect(filtered.length).toBe(5);
  });

  it("filters by Included kind", () => {
    const filtered = filterEventsForRange(sampleEvents, "7d", null, "included", now);
    expect(filtered.every((e) => e.kind === "Included")).toBeTrue();
    expect(filtered.length).toBe(2);
  });

  it("filters by On-Demand kind", () => {
    const filtered = filterEventsForRange(sampleEvents, "7d", null, "ondemand", now);
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.kind === "On-Demand")).toBeTrue();
  });
});

describe("aggregateChartSeries", () => {
  const sumOf = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  it("produces per-day (non-cumulative) tokens per model", () => {
    const series = aggregateChartSeries(sampleEvents, [], "7d", null, "tokens", "all", now);
    expect(series.labels.length).toBeGreaterThan(0);
    expect(series.datasets.length).toBe(2);
    const codex = series.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    const composer = series.datasets.find((d) => d.model === "composer-2")!;
    // Sum of per-day buckets equals total over the range.
    expect(sumOf(codex.data)).toBe(5000); // 2000 + 3000
    expect(sumOf(composer.data)).toBe(600); // 500 + 100
    // Confirm at least one zero day exists between the two activity days for codex (1d ago and never else in this range).
    expect(codex.data.some((v) => v === 0)).toBeTrue();
  });

  it("produces fractional requests per model (per-day)", () => {
    const series = aggregateChartSeries(sampleEvents, [], "7d", null, "requests", "all", now);
    const codex = series.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    const composer = series.datasets.find((d) => d.model === "composer-2")!;
    expect(sumOf(codex.data)).toBeCloseTo(3.5, 5); // 2 + 1.5
    expect(sumOf(composer.data)).toBeCloseTo(4.6, 5); // 4 + 0.6
  });

  it("uses per-event spend (chargedCents) for spend metric", () => {
    const series = aggregateChartSeries(sampleEvents, [], "7d", null, "spend", "all", now);
    const codex = series.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    const composer = series.datasets.find((d) => d.model === "composer-2")!;
    expect(sumOf(codex.data)).toBeCloseTo(3.2, 5); // 320c = $3.20
    expect(sumOf(composer.data)).toBeCloseTo(0.5, 5); // 50c = $0.50
  });

  it("applies usage filter to spend (only on-demand events have spend)", () => {
    const onlyIncluded = aggregateChartSeries(sampleEvents, [], "7d", null, "spend", "included", now);
    expect(onlyIncluded.datasets.every((d) => sumOf(d.data) === 0)).toBeTrue();
    const onlyOnDemand = aggregateChartSeries(sampleEvents, [], "7d", null, "spend", "ondemand", now);
    const codex = onlyOnDemand.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    expect(sumOf(codex.data)).toBeCloseTo(3.2, 5);
  });

  it("does not count chargedCents as spend while requests are included by default", () => {
    const events: UsageEvent[] = [
      { ...baseEvent, timestamp: now - dayMs, model: "gpt-5.3-codex", kind: "Included", totalTokens: 2000, requests: 2, spendCents: 450 },
      { ...baseEvent, timestamp: now - dayMs, model: "gpt-5.3-codex", kind: "On-Demand", totalTokens: 3000, requests: 1.5, spendCents: 320, maxMode: true },
    ];

    const series = aggregateChartSeries(events, [], "7d", null, "spend", "all", now);
    const codex = series.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    expect(sumOf(codex.data)).toBeCloseTo(3.2, 5);
  });

  it("keeps included chargedCents in spend when quota-aware display is disabled", () => {
    const events: UsageEvent[] = [
      { ...baseEvent, timestamp: now - dayMs, model: "gpt-5.3-codex", kind: "Included", totalTokens: 2000, requests: 2, spendCents: 450 },
      { ...baseEvent, timestamp: now - dayMs, model: "gpt-5.3-codex", kind: "On-Demand", totalTokens: 3000, requests: 1.5, spendCents: 320, maxMode: true },
    ];

    const series = aggregateChartSeries(events, [], "7d", null, "spend", "all", now, false);
    const codex = series.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    expect(sumOf(codex.data)).toBeCloseTo(7.7, 5);
  });

  it("respects usage filter for token metric", () => {
    const onlyIncluded = aggregateChartSeries(sampleEvents, [], "7d", null, "tokens", "included", now);
    const incCodex = onlyIncluded.datasets.find((d) => d.model === "gpt-5.3-codex")!;
    expect(sumOf(incCodex.data)).toBe(2000);
  });

  it("returns empty datasets when no events fall in range", () => {
    const series = aggregateChartSeries([], [], "7d", null, "tokens", "all", now);
    expect(series.datasets.length).toBe(0);
    expect(series.labels.length).toBeGreaterThan(0);
  });

  it("orders datasets by descending range total", () => {
    const series = aggregateChartSeries(sampleEvents, [], "7d", null, "tokens", "all", now);
    const totals = series.datasets.map((d) => sumOf(d.data));
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i - 1]).toBeGreaterThanOrEqual(totals[i]!);
    }
  });

  it("varies day bucket count by selected range", () => {
    const oneDay = aggregateChartSeries(sampleEvents, [], "1d", null, "tokens", "all", now);
    const sevenDay = aggregateChartSeries(sampleEvents, [], "7d", null, "tokens", "all", now);
    const thirtyDay = aggregateChartSeries(sampleEvents, [], "30d", null, "tokens", "all", now);
    expect(oneDay.labels.length).toBe(1);
    expect(sevenDay.labels.length).toBe(8);
    expect(thirtyDay.labels.length).toBe(31);
    expect(oneDay.labels.length).toBeLessThan(sevenDay.labels.length);
    expect(sevenDay.labels.length).toBeLessThan(thirtyDay.labels.length);
  });

  it("includes only same-day events for the 1d (today) range", () => {
    const empty = aggregateChartSeries(sampleEvents, [], "1d", null, "tokens", "all", now);
    expect(empty.datasets.length).toBe(0);

    const todayEvents: UsageEvent[] = [
      { ...baseEvent, timestamp: now - 2 * 3_600_000, model: "gpt-5.3-codex", kind: "Included", totalTokens: 1200, requests: 1 },
    ];
    const series = aggregateChartSeries(todayEvents, [], "1d", null, "tokens", "all", now);
    expect(sumOf(series.datasets[0]!.data)).toBe(1200);
  });

  it("filterEventsForChartRange matches chart series token totals", () => {
    const filtered = filterEventsForChartRange(sampleEvents, "7d", null, "all", now);
    const series = aggregateChartSeries(sampleEvents, [], "7d", null, "tokens", "all", now);
    const filteredTokens = filtered.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
    const chartTokens = series.datasets.reduce(
      (sum, d) => sum + d.data.reduce((a, b) => a + b, 0),
      0,
    );
    expect(filteredTokens).toBe(chartTokens);
  });

  it("aggregateModelBreakdownTotals matches chart per-model token sums", () => {
    const breakdown = aggregateModelBreakdownTotals(sampleEvents, [], "7d", null, "all", now);
    const series = aggregateChartSeries(sampleEvents, [], "7d", null, "tokens", "all", now);
    const sumBreakdown = breakdown.reduce((sum, row) => sum + row.totalTokens, 0);
    const sumChart = series.datasets.reduce(
      (sum, d) => sum + d.data.reduce((a, b) => a + b, 0),
      0,
    );
    expect(sumBreakdown).toBe(sumChart);
    const codex = breakdown.find((r) => r.model === "gpt-5.3-codex");
    expect(codex?.totalTokens).toBe(5000);
  });

  it("extends billing cycle axis through day before reset", () => {
    const resetAtIso = new Date(now + 5 * dayMs).toISOString();
    const series = aggregateChartSeries(sampleEvents, [], "billingCycle", resetAtIso, "tokens", "all", now);
    expect(series.labels.length).toBeGreaterThan(30);
    expect(series.dayMs?.length).toBe(series.labels.length);
  });
});

describe("paginateList", () => {
  const items = Array.from({ length: 105 }, (_, i) => i + 1);

  it("returns the requested page slice", () => {
    const page = paginateList(items, 2, 50);
    expect(page.items).toEqual(Array.from({ length: 50 }, (_, i) => i + 51));
    expect(page.totalItems).toBe(105);
    expect(page.totalPages).toBe(3);
    expect(page.page).toBe(2);
    expect(page.startIndex).toBe(50);
    expect(page.endIndex).toBe(100);
  });

  it("clamps page when out of range", () => {
    const page = paginateList(items, 99, 50);
    expect(page.page).toBe(3);
    expect(page.items.length).toBe(5);
  });

  it("handles empty lists", () => {
    const page = paginateList([], 5, 50);
    expect(page.items).toEqual([]);
    expect(page.totalItems).toBe(0);
    expect(page.totalPages).toBe(1);
    expect(page.page).toBe(1);
  });
});

describe("summarizeRange", () => {
  it("counts included requests and on-demand spend separately", () => {
    const s = summarizeRange(sampleEvents, "7d", null, now);
    // Included in 7d: 2 (codex) + 4 (composer) = 6
    expect(s.includedRequests).toBe(6);
    expect(s.totalRequests).toBe(6); // matches Cursor's "Total" tile, which counts included
    // On-demand spend in 7d: 320 + 50 = 370c = $3.70
    expect(s.onDemandSpendDollars).toBeCloseTo(3.7, 5);
    // Tokens across all events in 7d
    expect(s.totalTokens).toBe(2000 + 3000 + 500 + 100);
  });

  it("excludes events outside the cutoff", () => {
    const s = summarizeRange(sampleEvents, "1d", null, now);
    // 1d is calendar today (UTC); sample events are 1+ days old
    expect(s.includedRequests).toBe(0);
    expect(s.onDemandSpendDollars).toBe(0);
    expect(s.totalTokens).toBe(0);

    const todayEvents: UsageEvent[] = [
      { ...baseEvent, timestamp: now - 2 * 3_600_000, model: "gpt-5.3-codex", kind: "Included", totalTokens: 2000, requests: 2 },
      { ...baseEvent, timestamp: now - 2 * 3_600_000, model: "gpt-5.3-codex", kind: "On-Demand", totalTokens: 3000, requests: 1.5, spendCents: 320, maxMode: true },
    ];
    const today = summarizeRange(todayEvents, "1d", null, now);
    expect(today.includedRequests).toBe(2);
    expect(today.onDemandSpendDollars).toBeCloseTo(3.2, 5);
  });
});
