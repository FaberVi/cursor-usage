import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type * as vscode from "vscode";
import type { SetupCache } from "../src/cursor-api-types";
import { UsageEventStore } from "../src/usage-event-store";

const invalidateSetupCache = mock(() => {});

const getCursorToken = mock(async () => ({
  userId: "auth-uuid",
  sessionToken: "session",
  accessToken: "access",
  email: "user@example.com" as string | null,
}));

const soloSetup: SetupCache = {
  isTeamMember: false,
  teamId: undefined,
  maxRequestUsage: 100,
  onDemandEnabled: false,
  stripeRecord: null,
  planInfo: {
    displayName: "Pro",
    tier: "Pro",
    accountType: "personal",
    planKind: "pro",
    priceLabel: null,
  } as SetupCache["planInfo"],
};

const ensureSetup = mock(async (): Promise<SetupCache | null> => soloSetup);

mock.module("../src/cursor-setup-cache", () => ({
  invalidateSetupCache,
  getCachedSetup: () => null,
  storeSetupCache: () => {},
  getCachedMaxRequestUsage: () => 100,
  isTeamMemberCached: () => false,
}));

mock.module("../src/cursor-auth", () => ({
  getCursorToken,
  cursorHeaders: () => ({ Authorization: "Bearer session" }),
}));

mock.module("../src/cursor-setup", () => ({
  ensureSetup,
  withPlanInfo: (payload: { planInfo: unknown }, setup: SetupCache) => ({
    ...payload,
    planInfo: setup.planInfo,
  }),
}));

mock.module("../src/dashboard-panel", () => ({
  DashboardPanel: {
    currentPanel: {
      postState: () => {
        postStateCalls += 1;
      },
    },
    getDashboardEventFilter: () => null,
  },
  OPEN_DASHBOARD_COMMAND: "cursor-usage.openDashboard",
}));

mock.module("../src/conversation-titles", () => ({
  buildConversationTitleMap: async () => ({}),
}));

let fetchUsageDataCalls = 0;
let firstFetchGate: Promise<void> | null = null;
let releaseFirstFetch: (() => void) | null = null;
let secondFetchGate: Promise<void> | null = null;
let releaseSecondFetch: (() => void) | null = null;
let usageEventsHttpCalls = 0;
let syncEventsFromApiCalls = 0;
let upsertEventsCalls = 0;
let eventsFetchComplete = true;
let eventsFetchRejected = false;
let spendFetchRejected = false;
let usageDataRejected = false;
let postStateCalls = 0;

const summaryWithPlan = {
  individualUsage: {
    plan: {
      enabled: true,
      used: 1,
      limit: 100,
      autoPercentUsed: 0,
      apiPercentUsed: 0,
      totalPercentUsed: 0,
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;
let originalSyncEventsFromApi: typeof UsageEventStore.prototype.syncEventsFromApi;
let originalUpsertEvents: typeof UsageEventStore.prototype.upsertEvents;
let storageDir: string;

function installFetchMock(): void {
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("/api/usage-summary")) {
      fetchUsageDataCalls += 1;
      if (usageDataRejected) {
        throw new Error("usage data failed");
      }
      if (fetchUsageDataCalls === 1 && firstFetchGate) {
        await firstFetchGate;
      }
      if (fetchUsageDataCalls === 2 && secondFetchGate) {
        await secondFetchGate;
      }
      return jsonResponse(summaryWithPlan);
    }

    if (url.includes("get-filtered-usage-events")) {
      if (eventsFetchRejected) {
        throw new Error("events failed");
      }
      usageEventsHttpCalls += 1;
      if (!eventsFetchComplete) {
        const pageSize = 500;
        const fullPage = Array.from({ length: pageSize }, (_, i) => ({
          timestamp: String(Date.now() - i),
          model: "default",
          kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
          tokenUsage: { inputTokens: 1, outputTokens: 0, totalCents: 0 },
          chargedCents: 0,
        }));
        return jsonResponse({ usageEventsDisplay: fullPage });
      }
      const events = [
            {
              timestamp: String(Date.now()),
              model: "default",
              kind: "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS",
              tokenUsage: { inputTokens: 10, outputTokens: 0, totalCents: 0 },
              chargedCents: 0,
            },
          ];
      return jsonResponse({ usageEventsDisplay: events });
    }

    if (url.includes("get-daily-spend-by-category")) {
      if (spendFetchRejected) {
        throw new Error("spend failed");
      }
      return jsonResponse([]);
    }

    if (url.includes("GetCurrentPeriodUsage")) {
      return jsonResponse({});
    }

    if (url.includes("get-sand-usage-status")) {
      return jsonResponse({});
    }

    return jsonResponse({}, 404);
  };
}

describe("updateUsage force refresh", () => {
  let updateUsage: (opts?: { force?: boolean }) => Promise<void>;
  let getDashboardState: () => import("../src/dashboard-state").DashboardState;
  let initExtensionRefresh: (
    context: vscode.ExtensionContext,
    barItem: vscode.StatusBarItem,
    channel: vscode.OutputChannel,
  ) => void;
  let cleanupExtensionRefresh: () => void;

  const statusBarItem = { text: "$(pulse) Usage", show: () => {} } as vscode.StatusBarItem;
  const outputChannel = { appendLine: () => {} } as vscode.OutputChannel;
  const extensionContext = {
    globalState: {
      get: () => false,
      update: async () => {},
    },
    globalStorageUri: { fsPath: "" },
    extensionPath: process.cwd(),
  } as unknown as vscode.ExtensionContext;

  beforeEach(async () => {
    fetchUsageDataCalls = 0;
    usageEventsHttpCalls = 0;
    syncEventsFromApiCalls = 0;
    upsertEventsCalls = 0;
    invalidateSetupCache.mockClear();
    eventsFetchComplete = true;
    eventsFetchRejected = false;
    spendFetchRejected = false;
    usageDataRejected = false;
    postStateCalls = 0;
    firstFetchGate = null;
    releaseFirstFetch = null;
    secondFetchGate = null;
    releaseSecondFetch = null;

    storageDir = mkdtempSync(join(tmpdir(), "cursor-usage-ext-refresh-"));
    extensionContext.globalStorageUri.fsPath = storageDir;

    originalFetch = globalThis.fetch;
    originalSyncEventsFromApi = UsageEventStore.prototype.syncEventsFromApi;
    originalUpsertEvents = UsageEventStore.prototype.upsertEvents;
    UsageEventStore.prototype.syncEventsFromApi = function (...args) {
      syncEventsFromApiCalls += 1;
      return originalSyncEventsFromApi.apply(this, args);
    };
    UsageEventStore.prototype.upsertEvents = function (...args) {
      upsertEventsCalls += 1;
      return originalUpsertEvents.apply(this, args);
    };
    installFetchMock();

    const mod = await import("../src/extension-refresh");
    updateUsage = mod.updateUsage;
    getDashboardState = mod.getDashboardState;
    initExtensionRefresh = mod.initExtensionRefresh;
    cleanupExtensionRefresh = mod.cleanupExtensionRefresh;
    initExtensionRefresh(extensionContext, statusBarItem, outputChannel);
  });

  afterEach(() => {
    cleanupExtensionRefresh();
    globalThis.fetch = originalFetch;
    UsageEventStore.prototype.syncEventsFromApi = originalSyncEventsFromApi;
    UsageEventStore.prototype.upsertEvents = originalUpsertEvents;
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("invalidates setup cache and upserts events on interactive force refresh", async () => {
    await updateUsage({ force: true });
    expect(invalidateSetupCache).toHaveBeenCalledTimes(1);
    expect(upsertEventsCalls).toBeGreaterThanOrEqual(1);
    expect(usageEventsHttpCalls).toBeGreaterThanOrEqual(1);
  });

  it("full-syncs event store in background after interactive force refresh", async () => {
    await updateUsage({ force: true });
    for (let i = 0; i < 100 && syncEventsFromApiCalls === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(syncEventsFromApiCalls).toBe(1);
    expect(usageEventsHttpCalls).toBeGreaterThanOrEqual(2);
  });

  it("uses upsert on automatic refresh with a short event fetch", async () => {
    await updateUsage();
    expect(invalidateSetupCache).not.toHaveBeenCalled();
    expect(syncEventsFromApiCalls).toBe(0);
    expect(upsertEventsCalls).toBe(1);
    expect(usageEventsHttpCalls).toBe(1);
  });

  it("uses upsert when force refresh receives an incomplete event snapshot", async () => {
    eventsFetchComplete = false;
    await updateUsage({ force: true });
    expect(syncEventsFromApiCalls).toBe(0);
    expect(upsertEventsCalls).toBe(1);
  });

  it("coalesces concurrent force refreshes into one extra fetch", async () => {
    firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });

    const first = updateUsage({ force: true });
    await new Promise((r) => setTimeout(r, 0));
    const second = updateUsage({ force: true });
    const third = updateUsage({ force: true });

    releaseFirstFetch?.();
    await Promise.all([first, second, third]);

    expect(fetchUsageDataCalls).toBe(2);
  });

  it("awaits queued force refresh before resolving concurrent callers", async () => {
    firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    secondFetchGate = new Promise<void>((resolve) => {
      releaseSecondFetch = resolve;
    });

    const first = updateUsage({ force: true });
    await new Promise((r) => setTimeout(r, 0));
    const second = updateUsage({ force: true });

    releaseFirstFetch?.();
    for (let i = 0; i < 50 && fetchUsageDataCalls < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fetchUsageDataCalls).toBe(2);

    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(firstSettled).toBeFalse();
    expect(secondSettled).toBeFalse();

    releaseSecondFetch?.();
    await Promise.all([first, second]);
    expect(fetchUsageDataCalls).toBe(2);
  });

  it("queues a non-force refresh until the in-flight fetch finishes", async () => {
    firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });

    const first = updateUsage({ force: true });
    await new Promise((r) => setTimeout(r, 0));
    const queued = updateUsage();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchUsageDataCalls).toBe(1);

    releaseFirstFetch?.();
    await Promise.all([first, queued]);

    expect(fetchUsageDataCalls).toBe(2);
  });

  it("records warnings when events fetch fails but still posts state", async () => {
    eventsFetchRejected = true;
    await updateUsage({ force: true });
    const state = getDashboardState();
    expect(state.warnings.length).toBeGreaterThan(0);
    expect(state.eventsComplete).toBeFalse();
    expect(postStateCalls).toBeGreaterThan(0);
  });

  it("records partial sync warning when event snapshot is incomplete", async () => {
    eventsFetchComplete = false;
    await updateUsage({ force: true });
    const state = getDashboardState();
    expect(state.eventsComplete).toBeFalse();
    expect(state.warnings.some((w) => w.toLowerCase().includes("partial") || w.toLowerCase().includes("parziale"))).toBeTrue();
  });
});
