/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import {
  formatDailyBudgetResetCountdown,
  getNextDailyBudgetResetMs,
} from "../src/daily-budget-reset";

const DAY_MS = 86_400_000;

describe("getNextDailyBudgetResetMs", () => {
  it("returns the next UTC midnight after the given timestamp", () => {
    const now = Date.UTC(2026, 6, 5, 12, 0, 0);
    expect(getNextDailyBudgetResetMs(now)).toBe(Date.UTC(2026, 6, 6, 0, 0, 0));
  });

  it("returns the next midnight when the timestamp is already UTC midnight", () => {
    const now = Date.UTC(2026, 6, 5, 0, 0, 0);
    expect(getNextDailyBudgetResetMs(now)).toBe(Date.UTC(2026, 6, 6, 0, 0, 0));
  });
});

describe("formatDailyBudgetResetCountdown", () => {
  it("shows hours and minutes when more than one hour remains", () => {
    const now = Date.UTC(2026, 6, 5, 12, 0, 0);
    const text = formatDailyBudgetResetCountdown("en", now);
    expect(text).toContain("12h");
    expect(text).toContain("0m");
    expect(text).toMatch(/\(.+\)/);
  });

  it("shows minutes only when less than one hour remains", () => {
    const now = Date.UTC(2026, 6, 5, 23, 50, 0);
    const text = formatDailyBudgetResetCountdown("en", now);
    expect(text).toContain("10m");
    expect(text).not.toContain("0h");
  });

  it("renders Italian labels", () => {
    const now = Date.UTC(2026, 6, 5, 12, 0, 0);
    const text = formatDailyBudgetResetCountdown("it", now);
    expect(text).toContain("Reset tra");
    expect(text).toContain("12h");
  });

  it("uses resetting-now text when reset is due", () => {
    const resetMs = Date.UTC(2026, 6, 6, 0, 0, 0);
    const text = formatDailyBudgetResetCountdown("en", resetMs + 1_000, resetMs);
    expect(text).toContain("Resetting now");
  });
});
