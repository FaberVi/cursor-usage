import { describe, expect, it } from "bun:test";
import type { UsageEvent, UsagePayload } from "../src/cursor-api";
import { getBillingCycleCutoff } from "../src/cursor-api-utils";
import {
  buildPoolUsageSeries,
  computeDailyPoolPacing,
  computeRecommendedPoolUsage,
  isAutoPoolEvent,
  countsTowardCursorMonthlyPools,
  isGrokBotUsageModel,
  projectPoolDepletion,
} from "../src/pool-usage-series";

const dayMs = 86_400_000;
const now = Date.UTC(2026, 6, 5, 12, 0, 0);
const resetsAt = "2026-08-02T15:37:46.000Z";
const cycleStart = getBillingCycleCutoff(resetsAt, now);

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

const poolUsage: NonNullable<UsagePayload["poolUsage"]> = {
  autoPercentUsed: 60,
  apiPercentUsed: 20,
  totalPercentUsed: 40,
};

describe("isAutoPoolEvent", () => {
  it("treats catalog first-party models as the Auto/first-party pool", () => {
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "default", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "auto", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "composer-2", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "composer-2.5", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "grok-4.5", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "cursor-grok-4.5-high", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "grok-4.6", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "cursor-grok-4.6-fast", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "grok-4.7-high-fast", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "cursor-grok-4.7-high-fast", spendCents: 100 })).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "cursor-grok-4.6-high-fast", spendCents: 100 })).toBeTrue();
  });

  it("treats API-pool models as the API pool", () => {
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "gpt-5", spendCents: 100 })).toBeFalse();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "composer-1", spendCents: 100 })).toBeFalse();
  });

  it("excludes Grok Bot usage from monthly Cursor pools", () => {
    expect(isGrokBotUsageModel("grok-bot-default")).toBeTrue();
    expect(isGrokBotUsageModel("grok-bot-automation")).toBeTrue();
    expect(isGrokBotUsageModel("grok-bot-cua")).toBeTrue();
    expect(isAutoPoolEvent({ ...baseEvent, timestamp: now, model: "grok-bot-default", spendCents: 100 })).toBeFalse();
    expect(
      countsTowardCursorMonthlyPools({ ...baseEvent, timestamp: now, model: "grok-bot-cua", spendCents: 100 }),
    ).toBeFalse();
  });
});

describe("buildPoolUsageSeries", () => {
  const events: UsageEvent[] = [
    { ...baseEvent, timestamp: cycleStart + 3_600_000, model: "default", spendCents: 100 },
    { ...baseEvent, timestamp: cycleStart + dayMs + 3_600_000, model: "default", spendCents: 200 },
    { ...baseEvent, timestamp: cycleStart + dayMs + 3_600_000, model: "gpt-5", spendCents: 50 },
    { ...baseEvent, timestamp: cycleStart + 2 * dayMs + 3_600_000, model: "gpt-5", spendCents: 150 },
    { ...baseEvent, timestamp: now, model: "default", spendCents: 100, kind: "On-Demand" },
  ];

  it("returns cumulative percentages anchored to current pool usage", () => {
    const series = buildPoolUsageSeries(events, poolUsage, resetsAt, now)!;
    expect(series.labels.length).toBe(4);
    expect(series.autoPercent.at(-1)).toBeCloseTo(60, 5);
    expect(series.apiPercent.at(-1)).toBeCloseTo(20, 5);
  });

  it("marks spend-weighted series and leaves the even fallback unmarked", () => {
    const series = buildPoolUsageSeries(events, poolUsage, resetsAt, now)!;
    expect(series.autoFromSpend).toBe(true);
    expect(series.apiFromSpend).toBe(true);
    const even = buildPoolUsageSeries(events, poolUsage, resetsAt, now, { evenDailyShape: true })!;
    expect(even.autoFromSpend).toBe(false);
    expect(even.apiFromSpend).toBe(false);
  });

  it("allocates daily increments proportionally to included spend", () => {
    const series = buildPoolUsageSeries(events, poolUsage, resetsAt, now)!;
    expect(series.dailyAutoPercent[0]).toBeCloseTo(20, 5);
    expect(series.dailyAutoPercent[1]).toBeCloseTo(40, 5);
    expect(series.dailyApiPercent[1]).toBeCloseTo(5, 5);
    expect(series.dailyApiPercent[2]).toBeCloseTo(15, 5);
    expect(series.autoPercent[2]).toBeCloseTo(60, 5);
    expect(series.apiPercent[2]).toBeCloseTo(20, 5);
  });

  it("counts Composer and Grok included spend toward the first-party pool", () => {
    const firstPartyEvents: UsageEvent[] = [
      { ...baseEvent, timestamp: cycleStart + 3_600_000, model: "composer-2", spendCents: 150 },
      { ...baseEvent, timestamp: cycleStart + dayMs + 3_600_000, model: "grok-4.5", spendCents: 50 },
      { ...baseEvent, timestamp: cycleStart + dayMs + 3_600_000, model: "gpt-5", spendCents: 100 },
    ];
    const series = buildPoolUsageSeries(
      firstPartyEvents,
      { autoPercentUsed: 40, apiPercentUsed: 10, totalPercentUsed: 25 },
      resetsAt,
      now,
    )!;

    expect(series.dailyAutoPercent[0]).toBeCloseTo(30, 5);
    expect(series.dailyAutoPercent[1]).toBeCloseTo(10, 5);
    expect(series.dailyApiPercent[1]).toBeCloseTo(10, 5);
    expect(series.autoPercent.at(-1)).toBeCloseTo(40, 5);
    expect(series.apiPercent.at(-1)).toBeCloseTo(10, 5);
  });

  it("ignores Grok Bot included events when reconstructing monthly pool series", () => {
    const mixed: UsageEvent[] = [
      { ...baseEvent, timestamp: cycleStart + 3_600_000, model: "default", spendCents: 100 },
      { ...baseEvent, timestamp: cycleStart + 3_600_000, model: "grok-bot-default", spendCents: 900 },
      { ...baseEvent, timestamp: cycleStart + 3_600_000, model: "grok-bot-automation", spendCents: 500 },
    ];
    const series = buildPoolUsageSeries(
      mixed,
      { autoPercentUsed: 10, apiPercentUsed: 0, totalPercentUsed: 5 },
      resetsAt,
      now,
    )!;
    expect(series.dailyAutoPercent[0]).toBeCloseTo(10, 5);
    expect(series.dailyApiPercent[0]).toBeCloseTo(0, 5);
  });

  it("falls back to an even daily shape when included spend events are missing", () => {
    const series = buildPoolUsageSeries(
      [],
      { autoPercentUsed: 40, apiPercentUsed: 20, totalPercentUsed: 30 },
      resetsAt,
      now,
    )!;
    const dayCount = series.labels.length;
    expect(series.autoPercent.at(-1)).toBeCloseTo(40, 5);
    expect(series.apiPercent.at(-1)).toBeCloseTo(20, 5);
    expect(series.dailyAutoPercent[0]).toBeCloseTo(40 / dayCount, 5);
    expect(series.dailyApiPercent[0]).toBeCloseTo(20 / dayCount, 5);
  });

  it("computes daily pacing residual against even spread until reset", () => {
    const series = buildPoolUsageSeries(events, poolUsage, resetsAt, now)!;
    const resetDay = Date.UTC(2026, 7, 2, 0, 0, 0);
    const startDay = Date.UTC(2026, 6, 2, 0, 0, 0);
    const totalCycleDays = Math.round((resetDay - startDay) / dayMs) + 1;
    const firstAuto = series.dailyAutoPace[0]!;
    expect(firstAuto.allowance).toBeCloseTo(100 / totalCycleDays, 4);
    expect(firstAuto.residual).toBeCloseTo(firstAuto.allowance - firstAuto.used, 5);
    expect(series.todayAutoPace).toEqual(series.dailyAutoPace.at(-1) ?? null);
  });

  it("does not count the reset midnight as an extra budget day", () => {
    const midnightReset = "2026-08-02T00:00:00.000Z";
    const series = buildPoolUsageSeries([], poolUsage, midnightReset, now)!;
    const startDay = Date.UTC(2026, 6, 2);
    const lastDay = Date.UTC(2026, 7, 1);
    const totalCycleDays = Math.round((lastDay - startDay) / dayMs) + 1;
    expect(series.dailyAutoPace[0]!.allowance).toBeCloseTo(100 / totalCycleDays, 4);
    expect(totalCycleDays).toBe(31);
  });

  it("spreads a partial event snapshot evenly instead of assigning the whole percent to those days", () => {
    const partial: UsageEvent[] = [
      { ...baseEvent, timestamp: now, model: "default", spendCents: 50 },
    ];
    const series = buildPoolUsageSeries(partial, poolUsage, resetsAt, now, { evenDailyShape: true })!;
    const evenShare = 60 / series.labels.length;
    expect(series.dailyAutoPercent.every((value) => Math.abs(value - evenShare) < 1e-9)).toBeTrue();
    expect(series.autoPercent.at(-1)).toBeCloseTo(60, 5);
  });
});

describe("computeDailyPoolPacing", () => {
  it("shrinks the daily allowance as the cycle progresses", () => {
    const pace = computeDailyPoolPacing([10, 25], [10, 15], 10);
    expect(pace[0]!.allowance).toBeCloseTo(10, 5);
    expect(pace[0]!.residual).toBeCloseTo(0, 5);
    expect(pace[1]!.allowance).toBeCloseTo(10, 5);
    expect(pace[1]!.residual).toBeCloseTo(-5, 5);
    expect(pace[0]!.exhausted).toBe(false);
    expect(pace[1]!.exhausted).toBe(false);
  });

  it("marks a day exhausted once cumulative usage has reached 100%", () => {
    const pace = computeDailyPoolPacing([100, 100], [80, 0], 10);
    expect(pace[0]!.exhausted).toBe(true);
    expect(pace[1]!.allowance).toBe(0);
    expect(pace[1]!.residual).toBeCloseTo(0, 5);
    expect(pace[1]!.exhausted).toBe(true);
  });
});

describe("computeRecommendedPoolUsage", () => {
  it("returns even-spread cumulative target for the elapsed cycle", () => {
    const recommended = computeRecommendedPoolUsage(resetsAt, now)!;
    const resetMs = new Date(resetsAt).getTime();
    const elapsedMs = now - cycleStart;
    const cycleDurationMs = resetMs - cycleStart;
    expect(recommended.autoRecommended).toBeCloseTo((elapsedMs / cycleDurationMs) * 100, 4);
    expect(recommended.apiRecommended).toBe(recommended.autoRecommended);
  });

  it("reaches 100% at billing reset", () => {
    const resetMs = new Date(resetsAt).getTime();
    const recommended = computeRecommendedPoolUsage(resetsAt, resetMs)!;
    expect(recommended.autoRecommended).toBeCloseTo(100, 5);
  });
});

describe("projectPoolDepletion", () => {
  it("projects depletion from average daily consumption since cycle start", () => {
    const estimate = projectPoolDepletion(poolUsage, resetsAt, now);
    const elapsedDays = (now - cycleStart) / dayMs;
    expect(estimate.auto.avgDailyPercent).toBeCloseTo(60 / elapsedDays, 4);
    expect(estimate.api.avgDailyPercent).toBeCloseTo(20 / elapsedDays, 4);

    const autoDaysRemaining = (100 - 60) / estimate.auto.avgDailyPercent;
    const autoProjected = now + autoDaysRemaining * dayMs;
    expect(new Date(estimate.auto.projectedAtIso!).getTime()).toBeCloseTo(autoProjected, -3);
    expect(estimate.auto.status).toBe("ok");
  });

  it("uses the real elapsed fraction during the first hour", () => {
    const cycleStart = getBillingCycleCutoff(resetsAt, now);
    const early = cycleStart + 30 * 60_000;
    const estimate = projectPoolDepletion(
      { autoPercentUsed: 10, apiPercentUsed: 0, totalPercentUsed: 5 },
      resetsAt,
      early,
    );
    const elapsedDays = (early - cycleStart) / dayMs;
    expect(elapsedDays).toBeLessThan(1 / 24);
    expect(estimate.auto.avgDailyPercent).toBeCloseTo(10 / elapsedDays, 4);
    expect(estimate.auto.status).toBe("ok");
  });

  it("marks exhausted pools", () => {
    const estimate = projectPoolDepletion(
      { autoPercentUsed: 100, apiPercentUsed: 10, totalPercentUsed: 55 },
      resetsAt,
      now,
    );
    expect(estimate.auto.status).toBe("exhausted");
    expect(estimate.auto.projectedAtIso).toBeNull();
  });

  it("marks pools at the displayed 100% threshold as exhausted", () => {
    const estimate = projectPoolDepletion(
      { autoPercentUsed: 99.97, apiPercentUsed: 99.96, totalPercentUsed: 99.96 },
      resetsAt,
      now,
    );
    expect(estimate.auto.status).toBe("exhausted");
    expect(estimate.api.status).toBe("exhausted");
    expect(estimate.auto.projectedAtIso).toBeNull();
  });

  it("marks projections that fall after billing reset", () => {
    const slowUsage = { autoPercentUsed: 5, apiPercentUsed: 2, totalPercentUsed: 3.5 };
    const estimate = projectPoolDepletion(slowUsage, resetsAt, now);
    expect(estimate.auto.status).toBe("after_reset");
    expect(estimate.api.status).toBe("after_reset");
  });

  it("projects from the last 7 finished days when spend history is complete", () => {
    const later = Date.UTC(2026, 7, 19, 12, 0, 0);
    const longReset = "2026-09-02T15:37:46.000Z";
    const finished = [...Array(10).fill(1), ...Array(7).fill(4)];
    const today = 2;
    const daily = [...finished, today];
    const current = finished.reduce((sum, value) => sum + value, 0) + today;
    const history = {
      dailyAutoPercent: daily,
      dailyApiPercent: daily.map(() => 0),
      autoFromSpend: true,
      apiFromSpend: false,
    };
    const usage = { autoPercentUsed: current, apiPercentUsed: 0, totalPercentUsed: current / 2 };
    const estimate = projectPoolDepletion(usage, longReset, later, history);
    const cycle = projectPoolDepletion(usage, longReset, later);
    expect(estimate.auto.avgDailyPercent).toBeCloseTo(4, 5);
    const projected = later + ((100 - current) / 4) * dayMs;
    expect(new Date(estimate.auto.projectedAtIso!).getTime()).toBeCloseTo(projected, -3);
    expect(estimate.auto.avgDailyPercent).toBeGreaterThan(cycle.auto.avgDailyPercent);
    expect(estimate.api.status).toBe("no_usage");
  });

  it("keeps the cycle average when the daily shape is not from spend", () => {
    const later = Date.UTC(2026, 6, 20, 12, 0, 0);
    const daily = [...Array(17).fill(1), 20];
    const usage = { autoPercentUsed: 40, apiPercentUsed: 0, totalPercentUsed: 20 };
    const estimate = projectPoolDepletion(usage, resetsAt, later, {
      dailyAutoPercent: daily,
      dailyApiPercent: daily,
      autoFromSpend: false,
      apiFromSpend: false,
    });
    const elapsedDays = (later - getBillingCycleCutoff(resetsAt, later)) / dayMs;
    expect(estimate.auto.avgDailyPercent).toBeCloseTo(40 / elapsedDays, 4);
  });

  it("keeps the cycle average until two UTC days have finished", () => {
    const estimate = projectPoolDepletion(poolUsage, resetsAt, now, {
      dailyAutoPercent: [20, 40],
      dailyApiPercent: [5, 15],
      autoFromSpend: true,
      apiFromSpend: true,
    });
    const elapsedDays = (now - cycleStart) / dayMs;
    expect(estimate.auto.avgDailyPercent).toBeCloseTo(60 / elapsedDays, 4);
  });

  it("treats a week of finished idle days as a pace that will not exhaust the pool", () => {
    const quietReset = "2026-08-15T00:00:00.000Z";
    const quietNow = Date.UTC(2026, 6, 25, 0, 0, 0);
    const usage = { autoPercentUsed: 60, apiPercentUsed: 0, totalPercentUsed: 30 };
    const daily = [30, 30, 0, 0, 0, 0, 0, 0, 0, 0];
    const estimate = projectPoolDepletion(usage, quietReset, quietNow, {
      dailyAutoPercent: daily,
      dailyApiPercent: daily.map(() => 0),
      autoFromSpend: true,
      apiFromSpend: false,
    });
    const cycle = projectPoolDepletion(usage, quietReset, quietNow);
    expect(cycle.auto.status).toBe("ok");
    expect(estimate.auto.status).toBe("after_reset");
    expect(estimate.auto.avgDailyPercent).toBe(0);
    expect(estimate.auto.projectedAtIso).toBeNull();
  });

  it("falls back to the cycle average when usage starts on the open day", () => {
    const estimate = projectPoolDepletion(
      { autoPercentUsed: 12, apiPercentUsed: 0, totalPercentUsed: 6 },
      resetsAt,
      now,
      {
        dailyAutoPercent: [0, 0, 0, 12],
        dailyApiPercent: [0, 0, 0, 0],
        autoFromSpend: true,
        apiFromSpend: false,
      },
    );
    const elapsedDays = (now - cycleStart) / dayMs;
    expect(estimate.auto.avgDailyPercent).toBeCloseTo(12 / elapsedDays, 4);
    expect(estimate.auto.status).toBe("ok");
  });
});
