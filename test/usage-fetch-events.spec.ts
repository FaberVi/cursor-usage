import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const getCursorToken = mock(async () => ({
  userId: "1",
  sessionToken: "session",
  accessToken: "access",
  email: "user@example.com",
}));

const ensureSetup = mock(async () => ({
  isTeamMember: false,
  teamId: undefined,
  maxRequestUsage: 500,
  onDemandEnabled: false,
  stripeRecord: null,
  planInfo: null,
}));

mock.module("../src/cursor-auth", () => ({
  getCursorToken,
  cursorHeaders: () => ({ Authorization: "Bearer session" }),
}));

mock.module("../src/cursor-setup", () => ({
  ensureSetup,
}));

describe("fetchUsageEvents", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchUsageEvents: typeof import("../src/usage-fetch-events").fetchUsageEvents;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    getCursorToken.mockClear();
    ensureSetup.mockClear();
    const mod = await import("../src/usage-fetch-events");
    fetchUsageEvents = mod.fetchUsageEvents;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns complete:false when auth is unavailable", async () => {
    getCursorToken.mockResolvedValueOnce(null);
    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 2 });
    expect(result.events).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("returns complete:true when the last page is short", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          usageEventsDisplay: [
            {
              timestamp: String(Date.now()),
              model: "default",
              kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
              tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
              chargedCents: 0.5,
            },
          ],
        }),
        { status: 200 },
      );

    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 5 });
    expect(result.events).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("returns complete:false when HTTP fails", async () => {
    globalThis.fetch = async () => new Response("error", { status: 500 });
    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 5 });
    expect(result.events).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("returns complete:false when page cap is hit on a full page", async () => {
    const pageSize = 500;
    const fullPage = Array.from({ length: pageSize }, (_, i) => ({
      timestamp: String(Date.now() - i),
      model: "default",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalCents: 0.1 },
      chargedCents: 0.05,
    }));

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ usageEventsDisplay: fullPage }), { status: 200 });
    };

    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 2 });
    expect(calls).toBe(2);
    expect(result.events.length).toBe(pageSize * 2);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("returns complete:true when a full last page matches totalUsageEventsCount", async () => {
    const pageSize = 500;
    const fullPage = Array.from({ length: pageSize }, (_, i) => ({
      timestamp: String(Date.now() - i),
      model: "default",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalCents: 0.1 },
      chargedCents: 0.05,
    }));

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ totalUsageEventsCount: pageSize, usageEventsDisplay: fullPage }),
        { status: 200 },
      );

    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 1 });
    expect(result.events).toHaveLength(pageSize);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("stays truncated when an empty page does not cover totalUsageEventsCount", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ totalUsageEventsCount: 1200, usageEventsDisplay: [] }),
        { status: 200 },
      );
    };

    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 5 });
    expect(calls).toBe(1);
    expect(result.events).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.totalCovered).toBe(false);
  });

  it("stays truncated when a short page does not cover totalUsageEventsCount", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          totalUsageEventsCount: 800,
          usageEventsDisplay: [
            {
              timestamp: String(Date.now()),
              model: "default",
              kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
              tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
              chargedCents: 0.5,
            },
          ],
        }),
        { status: 200 },
      );
    };

    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 5 });
    expect(calls).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.totalCovered).toBe(false);
  });

  it("returns complete:true when a short page length equals totalUsageEventsCount", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          totalUsageEventsCount: 1,
          usageEventsDisplay: [
            {
              timestamp: String(Date.now()),
              model: "default",
              kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
              tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
              chargedCents: 0.5,
            },
          ],
        }),
        { status: 200 },
      );

    const result = await fetchUsageEvents({ lookbackDays: 7, maxPages: 5 });
    expect(result.events).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.totalCovered).toBe(true);
  });
});
