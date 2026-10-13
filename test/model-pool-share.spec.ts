/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import type { UsageEvent } from "../src/cursor-api-types";
import {
  buildPoolSpendIndex,
  computeModelPoolMetricsForDay,
  computeModelPoolMetricsForRange,
  dayIndicesInRange,
} from "../src/model-pool-share";

const DAY_MS = 86_400_000;
const day0 = Date.UTC(2026, 6, 1);
const day1 = Date.UTC(2026, 6, 2);
const day2 = Date.UTC(2026, 6, 3);
const dayMs = [day0, day1, day2];

const baseEvent = {
  kind: "Included" as const,
  totalTokens: 1000,
  requests: 1,
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

function event(partial: Partial<UsageEvent> & Pick<UsageEvent, "timestamp" | "model" | "spendCents">): UsageEvent {
  return { ...baseEvent, ...partial };
}

describe("buildPoolSpendIndex", () => {
  it("splits included spend by pool and model per day", () => {
    const events: UsageEvent[] = [
      event({ timestamp: day0 + 1000, model: "default", spendCents: 200 }),
      event({ timestamp: day0 + 2000, model: "claude-4.6-sonnet", spendCents: 100 }),
      event({ timestamp: day1 + 1000, model: "composer-2.5", spendCents: 300 }),
      event({ timestamp: day1 + 2000, model: "claude-4.6-sonnet", spendCents: 50 }),
      event({ timestamp: day1 + 3000, model: "gpt-5.3-codex", spendCents: 50, kind: "On-Demand" }),
    ];

    const index = buildPoolSpendIndex(events, dayMs, day0);
    expect(index.autoByDay[0]).toBe(200);
    expect(index.apiByDay[0]).toBe(100);
    expect(index.autoByDay[1]).toBe(300);
    expect(index.apiByDay[1]).toBe(50);
    expect(index.modelByDay.get("default")?.auto[0]).toBe(200);
    expect(index.modelByDay.get("claude-4.6-sonnet")?.api[0]).toBe(100);
    expect(index.modelByDay.get("claude-4.6-sonnet")?.api[1]).toBe(50);
    expect(index.modelByDay.has("gpt-5.3-codex")).toBe(false);
  });

  it("does not count Grok Bot included spend toward monthly pool indices", () => {
    const events: UsageEvent[] = [
      event({ timestamp: day0 + 1000, model: "default", spendCents: 100 }),
      event({ timestamp: day0 + 2000, model: "grok-bot-default", spendCents: 800 }),
      event({ timestamp: day0 + 3000, model: "grok-bot-cua", spendCents: 400 }),
    ];
    const index = buildPoolSpendIndex(events, dayMs, day0);
    expect(index.autoByDay[0]).toBe(100);
    expect(index.apiByDay[0]).toBe(0);
    expect(index.modelByDay.has("grok-bot-default")).toBe(false);
  });
});

describe("computeModelPoolMetricsForDay", () => {
  it("returns share of pool spend and quota points for the day", () => {
    const events: UsageEvent[] = [
      event({ timestamp: day0 + 1000, model: "default", spendCents: 150 }),
      event({ timestamp: day0 + 2000, model: "composer-2.5", spendCents: 50 }),
      event({ timestamp: day0 + 3000, model: "claude-4.6-sonnet", spendCents: 80 }),
      event({ timestamp: day0 + 4000, model: "gpt-5.3-codex", spendCents: 20 }),
    ];
    const index = buildPoolSpendIndex(events, dayMs, day0);
    const dailyAuto = [4, 0, 0];
    const dailyApi = [2, 0, 0];

    const autoMetrics = computeModelPoolMetricsForDay("default", 0, index, dailyAuto, dailyApi);
    expect(autoMetrics).toEqual({
      pool: "firstParty",
      poolSharePercent: 75,
      quotaPointsPercent: 3,
    });

    const apiMetrics = computeModelPoolMetricsForDay("claude-4.6-sonnet", 0, index, dailyAuto, dailyApi);
    expect(apiMetrics).toEqual({
      pool: "api",
      poolSharePercent: 80,
      quotaPointsPercent: 1.6,
    });
  });

  it("reports the day's model spend against the cycle pool total", () => {
    const events: UsageEvent[] = [
      event({ timestamp: day0 + 1000, model: "composer-2.5", spendCents: 150 }),
      event({ timestamp: day0 + 2000, model: "default", spendCents: 50 }),
      event({ timestamp: day1 + 1000, model: "default", spendCents: 300 }),
      event({ timestamp: day0 + 3000, model: "claude-4.6-sonnet", spendCents: 80 }),
      event({ timestamp: day1 + 2000, model: "claude-4.6-sonnet", spendCents: 20 }),
    ];
    const index = buildPoolSpendIndex(events, dayMs, day0);

    const composer = computeModelPoolMetricsForDay("composer-2.5", 0, index, [4, 8, 0], [2, 1, 0]);
    expect(composer?.poolSharePercent).toBeCloseTo(30, 5);
    expect(composer?.quotaPointsPercent).toBeCloseTo(3, 5);

    const soleDayModel = computeModelPoolMetricsForDay("claude-4.6-sonnet", 1, index, [4, 8, 0], [2, 1, 0]);
    expect(soleDayModel?.poolSharePercent).toBeCloseTo(20, 5);
    expect(soleDayModel?.quotaPointsPercent).toBeCloseTo(1, 5);
  });

  it("returns null when model or pool spend is zero", () => {
    const index = buildPoolSpendIndex([], dayMs, day0);
    expect(computeModelPoolMetricsForDay("default", 0, index, [1], [1])).toBeNull();
  });
});

describe("computeModelPoolMetricsForRange", () => {
  it("aggregates share and sums quota points across days", () => {
    const events: UsageEvent[] = [
      event({ timestamp: day0 + 1000, model: "claude-4.6-sonnet", spendCents: 50 }),
      event({ timestamp: day0 + 2000, model: "gpt-5.3-codex", spendCents: 50 }),
      event({ timestamp: day1 + 1000, model: "claude-4.6-sonnet", spendCents: 90 }),
      event({ timestamp: day1 + 2000, model: "gpt-5.3-codex", spendCents: 10 }),
    ];
    const index = buildPoolSpendIndex(events, dayMs, day0);
    const dailyAuto = [0, 0, 0];
    const dailyApi = [2, 4, 0];

    const metrics = computeModelPoolMetricsForRange(
      "claude-4.6-sonnet",
      [0, 1],
      index,
      dailyAuto,
      dailyApi,
    );
    expect(metrics?.pool).toBe("api");
    expect(metrics?.poolSharePercent).toBeCloseTo((140 / 200) * 100, 5);
    // day0: 50% of 2 = 1; day1: 90% of 4 = 3.6 → 4.6
    expect(metrics?.quotaPointsPercent).toBeCloseTo(4.6, 5);
  });

  it("uses billing-cycle pool total as denominator, not only the selected days", () => {
    const events: UsageEvent[] = [
      event({ timestamp: day0 + 1000, model: "claude-4.6-sonnet", spendCents: 40 }),
      event({ timestamp: day0 + 2000, model: "gpt-5.3-codex", spendCents: 60 }),
      event({ timestamp: day1 + 1000, model: "gpt-5.3-codex", spendCents: 100 }),
    ];
    const index = buildPoolSpendIndex(events, dayMs, day0);
    const metrics = computeModelPoolMetricsForRange(
      "claude-4.6-sonnet",
      [0],
      index,
      [0, 0, 0],
      [2, 4, 0],
    );
    expect(metrics?.poolSharePercent).toBeCloseTo(20, 5);
    expect(metrics?.quotaPointsPercent).toBeCloseTo(0.8, 5);
  });
});

describe("dayIndicesInRange", () => {
  it("filters day indices by cutoff", () => {
    expect(dayIndicesInRange(dayMs, day1)).toEqual([1, 2]);
    expect(dayIndicesInRange(dayMs, day0, day1)).toEqual([0, 1]);
  });
});
