/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it, mock } from "bun:test";
import type { UsageEvent } from "../src/cursor-api-types";

const fetchCalls: Array<{ startDateMs?: number; lookbackDays?: number }> = [];
const syncSince: number[] = [];

mock.module("../src/cursor-api", () => ({
  enrichUsageFromEvents: (data: unknown) => data,
  fetchDailySpendByCategory: async () => [],
  fetchUsageData: async () => null,
  fetchUsageEvents: async (opts: { startDateMs?: number; lookbackDays?: number }) => {
    fetchCalls.push(opts);
    const event = {
      timestamp: Date.now(),
      model: "default",
      kind: "Included",
      totalTokens: 1,
      requests: 1,
      spendCents: 0,
      maxMode: false,
      inputTokens: 1,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      tokenCostCents: 0,
      cursorTokenFee: 0,
      isTokenBasedCall: true,
      isHeadless: false,
      isChargeable: true,
      conversationId: null,
    } satisfies UsageEvent;
    return {
      events: [event],
      complete: true,
      truncated: false,
      totalCovered: true,
      failureReason: null,
    };
  },
}));

const { runEventHistorySync } = await import("../src/usage-refresh-fetch");

describe("full history sync window", () => {
  it("requests events from the same cutoff it deletes from", async () => {
    await runEventHistorySync(
      {
        lastData: null,
        lastError: null,
        lastErrorDetail: null,
        lastFetchTime: 0,
        lastEvents: null,
        lastDailySpend: null,
        lastWarnings: [],
        lastEventsComplete: false,
        quickFetchTruncated: false,
        fullHistoryAttempted: false,
        fullHistorySynced: false,
        eventHistorySyncInProgress: false,
      },
      {
        log: () => {},
        publishState: () => {},
        locale: () => "en",
        loadStoredEvents: async () => [],
        refreshConversationTitles: async () => 0,
        ensureEventStore: async () => ({
          purgeEventsBefore: () => 0,
          syncEventsFromApi: (_events: UsageEvent[], sinceMs: number) => {
            syncSince.push(sinceMs);
          },
          upsertEvents: () => {},
          flushPersist: () => {},
        }),
        statusBarItem: () => ({}),
        statusBarContext: () => ({}),
        globalState: () => ({ get: () => undefined, update: async () => {} }),
      } as never,
    );

    expect(fetchCalls).toHaveLength(1);
    expect(typeof fetchCalls[0]!.startDateMs).toBe("number");
    expect(fetchCalls[0]!.lookbackDays).toBeUndefined();
    expect(syncSince).toEqual([fetchCalls[0]!.startDateMs]);
  });
});
