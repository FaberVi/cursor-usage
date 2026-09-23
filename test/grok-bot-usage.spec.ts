/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseSandUsageStatus } from "../src/grok-bot-usage";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "sand-usage-status.json"), "utf8"),
);

describe("parseSandUsageStatus", () => {
  it("parses eligible weekly usage from fixture", () => {
    const usage = parseSandUsageStatus(fixture.included);
    expect(usage).not.toBeNull();
    expect(usage!.percentUsed).toBeCloseTo(42.5, 5);
    expect(usage!.periodStartIso).toBe("2026-09-16T00:00:00.000Z");
    expect(usage!.resetsAtIso).toBe("2026-09-23T00:00:00.000Z");
  });

  it("returns null when plan excludes Grok Bot", () => {
    expect(parseSandUsageStatus(fixture.notIncluded)).toBeNull();
  });

  it("returns null for pooled enterprise allowance", () => {
    expect(parseSandUsageStatus(fixture.pooledEnterprise)).toBeNull();
  });

  it("returns null when usagePercent is absent", () => {
    expect(parseSandUsageStatus({ hasNonZeroIncludedLimit: true })).toBeNull();
  });
});
