/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import {
  isGrokBotUsageCacheValid,
  resolveGrokBotUsageWithCache,
  type StoredGrokBotUsage,
} from "../src/grok-bot-usage-cache";

function memento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("grok-bot-usage-cache", () => {
  it("saves live readings and returns them without stale flag", () => {
    const m = memento();
    const live = {
      percentUsed: 12.5,
      periodStartIso: "2026-10-20T00:00:00.000Z",
      resetsAtIso: "2026-10-27T00:00:00.000Z",
    };
    const result = resolveGrokBotUsageWithCache(m, live, Date.parse("2026-10-25T00:00:00.000Z"));
    expect(result.stale).toBeFalse();
    expect(result.usage).toEqual(live);
  });

  it("falls back to cache when live API returns null", () => {
    const cached: StoredGrokBotUsage = {
      percentUsed: 33,
      periodStartIso: "2026-10-20T00:00:00.000Z",
      resetsAtIso: "2026-10-30T00:00:00.000Z",
      cachedAtIso: "2026-10-24T12:00:00.000Z",
    };
    const m = memento({ "cursorUsage.grokBotWeeklyCache": cached });
    const now = Date.parse("2026-10-25T00:00:00.000Z");
    expect(isGrokBotUsageCacheValid(cached, now)).toBeTrue();
    const result = resolveGrokBotUsageWithCache(m, null, now);
    expect(result.stale).toBeTrue();
    expect(result.usage?.percentUsed).toBe(33);
  });

  it("does not use expired cache after weekly reset", () => {
    const cached: StoredGrokBotUsage = {
      percentUsed: 90,
      periodStartIso: "2026-10-13T00:00:00.000Z",
      resetsAtIso: "2026-10-20T00:00:00.000Z",
      cachedAtIso: "2026-10-19T00:00:00.000Z",
    };
    const m = memento({ "cursorUsage.grokBotWeeklyCache": cached });
    const now = Date.parse("2026-10-28T00:00:00.000Z");
    expect(isGrokBotUsageCacheValid(cached, now)).toBeFalse();
    const result = resolveGrokBotUsageWithCache(m, null, now);
    expect(result.usage).toBeNull();
    expect(result.stale).toBeFalse();
  });
});
