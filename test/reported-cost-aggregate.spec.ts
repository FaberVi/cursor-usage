import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseUsageEvent, type UsageEvent } from "../src/cursor-api";
import {
  aggregateTheoreticalByModel,
  eventReportedUsageCostCents,
} from "../src/model-pricing";

const fixturesDir = join(import.meta.dir, "fixtures");

function loadUsageEventsFixture(): UsageEvent[] {
  const raw = JSON.parse(
    readFileSync(join(fixturesDir, "usage-events-page1.json"), "utf8").replace(/^\uFEFF/, ""),
  ) as { usageEventsDisplay?: unknown[] };
  const events = raw.usageEventsDisplay ?? [];
  return events
    .map((row) => parseUsageEvent(row))
    .filter((e): e is UsageEvent => e !== null);
}

describe("reported usage cost (Cursor Included Usage alignment)", () => {
  const fixtureEvents = loadUsageEventsFixture();
  const latestTs = Math.max(...fixtureEvents.map((event) => event.timestamp));
  const now = latestTs + 60_000;
  const resetAt = new Date(now).toISOString();

  it("parseUsageEvent maps tokenUsage.totalCents to tokenCostCents", () => {
    const events = loadUsageEventsFixture();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tokenCostCents).toBeGreaterThan(0);
      expect(eventReportedUsageCostCents(event)).toBe(event.tokenCostCents);
    }
  });

  it("aggregate reportedCostCents equals sum of tokenCostCents for included fixture events", () => {
    const events = loadUsageEventsFixture();
    const expected = events.reduce((sum, e) => sum + eventReportedUsageCostCents(e), 0);
    const result = aggregateTheoreticalByModel(events, "billingCycle", resetAt, now);
    const reportedTotal = Object.values(result.theoreticalByModel).reduce(
      (sum, row) => sum + row.reportedCostCents,
      0,
    );
    expect(reportedTotal).toBeCloseTo(expected, 4);
    expect(reportedTotal).toBeGreaterThan(0);
  });

  it("computes catalog theoretical cost for first-party included events", () => {
    const events = loadUsageEventsFixture();
    const withoutFee = aggregateTheoreticalByModel(events, "billingCycle", resetAt, now, {
      applyCursorTokenRate: false,
    });
    const withFee = aggregateTheoreticalByModel(events, "billingCycle", resetAt, now, {
      applyCursorTokenRate: true,
    });
    const reportedTotal = Object.values(withoutFee.theoreticalByModel).reduce(
      (sum, row) => sum + row.reportedCostCents,
      0,
    );
    const theoreticalWithoutFee = Object.values(withoutFee.theoreticalByModel).reduce(
      (sum, row) => sum + row.theoreticalCents,
      0,
    );
    const theoreticalWithFee = Object.values(withFee.theoreticalByModel).reduce(
      (sum, row) => sum + row.theoreticalCents,
      0,
    );
    expect(reportedTotal).toBeGreaterThan(0);
    expect(theoreticalWithoutFee).toBeGreaterThan(0);
    expect(theoreticalWithFee).toBeGreaterThan(theoreticalWithoutFee);
  });
});
