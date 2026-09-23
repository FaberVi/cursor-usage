/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  enrichUsageFromEvents,
  eventRequestCount,
  eventTokenCount,
  extractUsageFromSummary,
  extractUsageTotals,
  mergeTeamIncludedRequests,
  parseTimestamp,
  parseUsageEvent,
} from "../src/cursor-api";
import type { UsageEvent, UsagePayload } from "../src/cursor-api";
import { usageEvent } from "./usage-event-fixture";

const fixturesDir = join(import.meta.dir, "fixtures");

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(fixturesDir, `${name}.json`), "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

describe("extractUsageFromSummary", () => {
  it("parses real usage-summary fixture with plan used/limit and pool usage", () => {
    const summary = loadFixture("usage-summary") as {
      billingCycleEnd?: string;
      individualUsage?: { plan?: Record<string, unknown> };
    };
    const plan = summary.individualUsage?.plan ?? {};
    const payload = extractUsageFromSummary(summary, true);

    expect(payload).not.toBeNull();
    expect(payload!.includedRequests).toEqual({
      used: plan.used,
      limit: plan.limit,
    });
    expect(payload!.resetsAt).toBe(summary.billingCycleEnd ?? null);
    expect(payload!.onDemand.state).toBe("unlimited");
    expect(payload!.onDemand.spendDollars).toBe(0);
    expect(payload!.poolUsage).toEqual({
      autoPercentUsed: plan.autoPercentUsed,
      apiPercentUsed: plan.apiPercentUsed,
      totalPercentUsed: plan.totalPercentUsed,
    });
  });

  it("returns null when plan is disabled", () => {
    expect(
      extractUsageFromSummary(
        { individualUsage: { plan: { enabled: false, used: 1, limit: 2 } } },
        true,
      ),
    ).toBeNull();
  });

  it("maps on-demand cents to dollars with a limit", () => {
    const payload = extractUsageFromSummary(
      {
        billingCycleEnd: "2026-08-01T00:00:00.000Z",
        individualUsage: {
          plan: { enabled: true, used: 10, limit: 100 },
          onDemand: { enabled: true, used: 12345, limit: 50000 },
        },
      },
      true,
    );

    expect(payload!.onDemand).toEqual({
      state: "limited",
      onDemandEnabled: true,
      spendDollars: 123.45,
      limitDollars: 500,
    });
  });
});

describe("extractUsageTotals", () => {
  it("defaults legacy usage fixture to 0/0", () => {
    const legacy = loadFixture("usage-legacy");
    expect(extractUsageTotals(legacy)).toEqual({ used: 0, limit: 0, source: "none" });
  });

  it("reads gpt-4 bucket totals", () => {
    expect(
      extractUsageTotals({
        "gpt-4": { numRequests: 42, maxRequestUsage: 500 },
      }),
    ).toEqual({ used: 42, limit: 500, source: "gpt-4" });
  });

  it("prefers bucket with non-zero limit when legacy buckets are empty", () => {
    expect(
      extractUsageTotals({
        "gpt-4": { numRequests: 0, maxRequestUsage: null },
        "claude-4": { includedRequestsUsed: 5, includedRequestLimit: 500 },
      }),
    ).toEqual({ used: 5, limit: 500, source: "claude-4" });
  });
});

describe("mergeTeamIncludedRequests", () => {
  it("uses usage API limit even when used is zero", () => {
    const merged = mergeTeamIncludedRequests(
      { used: 0, limit: 500, source: "gpt-4" },
      { value: 99, source: "includedRequestsUsed" },
      { value: 0, source: "fallback:0" },
    );

    expect(merged.used).toBe(0);
    expect(merged.limit).toBe(500);
    expect(merged.limitSource).toBe("usage.gpt-4.limit");
  });

  it("falls back to member fields when usage API is unparsed", () => {
    const merged = mergeTeamIncludedRequests(
      { used: 0, limit: 0, source: "none" },
      { value: 12, source: "numRequests" },
      { value: 500, source: "includedRequestLimit" },
    );

    expect(merged).toEqual({
      used: 12,
      limit: 500,
      usedSource: "member.numRequests",
      limitSource: "member.includedRequestLimit",
    });
  });
});

describe("parseTimestamp", () => {
  it("parses numeric and string millisecond timestamps", () => {
    expect(parseTimestamp(1775418973898)).toBe(1775418973898);
    expect(parseTimestamp("1775418973898")).toBe(1775418973898);
  });

  it("parses ISO date strings", () => {
    expect(parseTimestamp("2026-07-02T15:37:46.000Z")).toBe(
      Date.parse("2026-07-02T15:37:46.000Z"),
    );
  });

  it("returns 0 for invalid values", () => {
    expect(parseTimestamp("")).toBe(0);
    expect(parseTimestamp(null)).toBe(0);
  });
});

describe("parseUsageEvent", () => {
  it("parses token breakdown and billing metadata from raw API events", () => {
    const parsed = parseUsageEvent({
      timestamp: "1775418973898",
      model: "claude-4.6-opus-high-thinking",
      kind: "USAGE_EVENT_KIND_USAGE_BASED",
      requestsCosts: 30.4,
      maxMode: true,
      isTokenBasedCall: true,
      isHeadless: false,
      isChargeable: true,
      cursorTokenFee: 3.32,
      chargedCents: 124.73,
      tokenUsage: {
        inputTokens: 3,
        outputTokens: 20525,
        cacheWriteTokens: 112151,
        cacheReadTokens: 45000,
        totalCents: 121.41,
      },
    });

    expect(parsed).toEqual({
      timestamp: 1775418973898,
      model: "claude-4.6-opus-high-thinking",
      kind: "On-Demand",
      totalTokens: 177679,
      requests: 1,
      spendCents: 124.73,
      maxMode: true,
      inputTokens: 3,
      outputTokens: 20525,
      cacheWriteTokens: 112151,
      cacheReadTokens: 45000,
      tokenCostCents: 121.41,
      cursorTokenFee: 3.32,
      isTokenBasedCall: true,
      isHeadless: false,
      isChargeable: true,
      conversationId: null,
    });
  });

  it("maps included and non-charged event kinds", () => {
    expect(parseUsageEvent({ kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS", tokenUsage: {} })?.kind).toBe("Included");
    expect(parseUsageEvent({ kind: "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED", tokenUsage: {} })?.kind).toBe("Errored");
    expect(parseUsageEvent({ kind: "USAGE_EVENT_KIND_ABORTED_NOT_CHARGED", tokenUsage: {} })?.kind).toBe("Aborted");
  });

  it("parses events from the usage-events-page1 fixture", () => {
    const page = loadFixture("usage-events-page1") as { usageEventsDisplay?: unknown[] };
    const raw = page.usageEventsDisplay?.[0];
    expect(raw).toBeDefined();

    const parsed = parseUsageEvent(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("Included");
    expect(parsed!.model).toBe("default");
    expect(parsed!.isTokenBasedCall).toBe(true);
    expect(parsed!.inputTokens).toBeGreaterThan(0);
    expect(parsed!.cacheReadTokens).toBeGreaterThan(0);
    expect(parsed!.totalTokens).toBe(
      parsed!.inputTokens + parsed!.outputTokens + parsed!.cacheWriteTokens + parsed!.cacheReadTokens,
    );
    expect(parsed!.conversationId).toBe("b1992beb-b50f-4b7d-aaff-af4e0ef47e36");
    expect(parsed!.requests).toBe(1);
  });

  it("counts one call per included token-metered event instead of summing requestsCosts", () => {
    const parsed = parseUsageEvent({
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
      isTokenBasedCall: true,
      requestsCosts: 29648584,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(parsed!.requests).toBe(1);
    expect(eventRequestCount(parsed!)).toBe(1);
  });

  it("heals archived rows that stored token-scale values in requests", () => {
    expect(
      eventRequestCount({
        kind: "Included",
        isTokenBasedCall: true,
        requests: 29_648_584,
        totalTokens: 29_648_584,
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1);
    expect(
      eventRequestCount({
        kind: "Included",
        isTokenBasedCall: true,
        requests: 23.2,
        totalTokens: 500_000,
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1);
    expect(
      eventRequestCount({
        kind: "On-Demand",
        isTokenBasedCall: true,
        requests: 30.4,
        totalTokens: 177_679,
        inputTokens: 3,
        outputTokens: 20525,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1);
    expect(
      eventRequestCount({
        kind: "Included",
        isTokenBasedCall: false,
        requests: 160_958_528,
        totalTokens: 160_958_528,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1);
    expect(
      eventRequestCount({
        kind: "Included",
        isTokenBasedCall: false,
        requests: 58_077_533,
        totalTokens: 58_077_533,
        inputTokens: 4089,
        outputTokens: 1442,
        cacheWriteTokens: 0,
        cacheReadTokens: 587_296,
      }),
    ).toBe(1);
  });

  it("heals archived rows that stored token-scale values in totalTokens", () => {
    expect(
      eventTokenCount({
        totalTokens: 58_077_533,
        inputTokens: 4089,
        outputTokens: 1442,
        cacheWriteTokens: 0,
        cacheReadTokens: 587_296,
      }),
    ).toBe(592_827);
    expect(
      eventTokenCount({
        totalTokens: 29_648_584,
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1500);
    expect(
      eventTokenCount({
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
    expect(
      eventTokenCount({
        totalTokens: 12_500,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(12_500);
  });

  it("keeps fractional counts on legacy request-metered plans", () => {
    expect(
      eventRequestCount({
        kind: "Included",
        isTokenBasedCall: false,
        requests: 2,
      }),
    ).toBe(2);
    expect(
      eventRequestCount({
        kind: "On-Demand",
        isTokenBasedCall: false,
        requests: 1.5,
      }),
    ).toBe(1.5);
  });
});

describe("enrichUsageFromEvents", () => {
  const base: UsagePayload = {
    includedRequests: { used: 0, limit: 0 },
    onDemand: { state: "unlimited", onDemandEnabled: true, spendDollars: 0, limitDollars: null },
    poolUsage: null,
    grokBotUsage: null,
    resetsAt: "2026-08-02T15:37:46.000Z",
    planInfo: null,
  };

  const events: UsageEvent[] = [
    usageEvent({
      timestamp: Date.parse("2026-07-04T12:00:00.000Z"),
      model: "default",
      kind: "Included",
      totalTokens: 1000,
      requests: 42,
      inputTokens: 800,
      outputTokens: 200,
      isTokenBasedCall: true,
      isChargeable: false,
    }),
  ];

  it("fills included usage from billing-cycle events when API totals are zero", () => {
    const enriched = enrichUsageFromEvents(base, events, Date.parse("2026-07-05T12:00:00.000Z"));
    expect(enriched.includedRequests.used).toBe(1);
    expect(enriched.includedRequests.limit).toBe(1);
  });
});
