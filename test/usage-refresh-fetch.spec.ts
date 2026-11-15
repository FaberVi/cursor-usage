/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import { getBillingCycleCutoff } from "../src/cursor-api-utils";
import {
  EVENT_RETENTION_DAYS,
  eventRetentionCutoffMs,
  eventRetentionLookbackDays,
} from "../src/usage-refresh-fetch";

const DAY_MS = 86_400_000;

describe("event retention cutoff", () => {
  const now = Date.UTC(2026, 6, 15);

  it("uses 60 days when the reset time is missing or invalid", () => {
    const expected = now - EVENT_RETENTION_DAYS * DAY_MS;
    expect(eventRetentionCutoffMs(now, null)).toBe(expected);
    expect(eventRetentionCutoffMs(now, "not-a-date")).toBe(expected);
    expect(expected).not.toBe(now - 31 * DAY_MS);
  });

  it("keeps the 60-day mark when the billing cycle started inside that window", () => {
    const resetsAt = new Date(Date.UTC(2026, 7, 1)).toISOString();
    const cycleStart = getBillingCycleCutoff(resetsAt, now);
    expect(cycleStart).toBeGreaterThan(now - EVENT_RETENTION_DAYS * DAY_MS);
    expect(eventRetentionCutoffMs(now, resetsAt)).toBe(now - EVENT_RETENTION_DAYS * DAY_MS);
  });

  it("keeps a billing cycle that started before the 60-day mark", () => {
    const resetsAt = new Date(Date.UTC(2026, 4, 15)).toISOString();
    const cycleStart = getBillingCycleCutoff(resetsAt, now);
    expect(cycleStart).toBeLessThan(now - EVENT_RETENTION_DAYS * DAY_MS);
    expect(eventRetentionCutoffMs(now, resetsAt)).toBe(cycleStart);
  });

  it("rounds the download window up so its start is not after the cutoff", () => {
    const sixty = now - 60 * DAY_MS;
    expect(eventRetentionLookbackDays(now, sixty)).toBe(60);
    expect(now - 60 * DAY_MS).toBeLessThanOrEqual(sixty);

    const cutoff = now - 90 * DAY_MS - 1;
    const days = eventRetentionLookbackDays(now, cutoff);
    expect(now - days * DAY_MS).toBeLessThanOrEqual(cutoff);
  });
});
