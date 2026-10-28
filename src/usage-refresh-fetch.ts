import * as vscode from "vscode";
import {
  enrichUsageFromEvents,
  fetchDailySpendByCategory,
  fetchUsageData,
  fetchUsageEvents,
  type DailySpendRow,
  type UsageEvent,
  type UsagePayload,
} from "./cursor-api";
import { MAX_STORE_SYNC_PAGES, MAX_USAGE_EVENT_PAGES } from "./cursor-api-utils";
import { dashboardNotice, type DashboardNotice } from "./dashboard-state";
import { invalidateSetupCache } from "./cursor-setup-cache";
import type { DashboardLocale } from "./dashboard-locale";
import { resolveGrokBotUsageWithCache } from "./grok-bot-usage-cache";
import { t } from "./i18n";
import { updateStatusBar } from "./status-bar-content";
import { UsageEventStore } from "./usage-event-store";

export const STORE_LOOKBACK_DAYS = 120;

type StatusBarContext = Parameters<typeof updateStatusBar>[1];

function failureMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return String(reason);
}

/** Mutable refresh session owned by extension-refresh. */
export type UsageRefreshState = {
  lastData: UsagePayload | null;
  lastError: string | null;
  lastErrorDetail: string | null;
  lastFetchTime: number;
  lastEvents: UsageEvent[] | null;
  lastDailySpend: DailySpendRow[] | null;
  lastWarnings: DashboardNotice[];
  lastEventsComplete: boolean;
  quickFetchTruncated: boolean;
  fullHistoryAttempted: boolean;
  fullHistorySynced: boolean;
  eventHistorySyncInProgress: boolean;
};

export type UsageRefreshHost = {
  log: (msg: string) => void;
  ensureEventStore: () => Promise<UsageEventStore>;
  loadStoredEvents: () => Promise<UsageEvent[]>;
  refreshConversationTitles: (events: UsageEvent[]) => Promise<number>;
  locale: () => DashboardLocale;
  statusBarItem: () => vscode.StatusBarItem;
  statusBarContext: () => StatusBarContext;
  publishState: () => void;
  globalState: () => vscode.Memento;
};

let backgroundEventSyncPromise: Promise<void> | null = null;
let backgroundSyncPending = false;

/** Remember that a full history sync should run after the current fetch. */
export function markBackgroundEventSyncPending(): void {
  backgroundSyncPending = true;
}

/** Drop a queued history sync. An in-flight sync still finishes. */
export function clearBackgroundEventSyncPending(): void {
  backgroundSyncPending = false;
}

/** Await any in-flight background history sync (for tests and teardown). */
export async function waitForBackgroundEventSyncIdle(): Promise<void> {
  while (backgroundEventSyncPromise) {
    await backgroundEventSyncPromise;
  }
}

/** Start one background drain. Further calls only set the pending flag. */
export function requestBackgroundEventHistorySync(runFullSync: () => Promise<void>): void {
  backgroundSyncPending = true;
  if (backgroundEventSyncPromise) return;
  backgroundEventSyncPromise = drainBackgroundEventHistorySync(runFullSync).finally(() => {
    backgroundEventSyncPromise = null;
  });
}

async function drainBackgroundEventHistorySync(runFullSync: () => Promise<void>): Promise<void> {
  while (backgroundSyncPending) {
    backgroundSyncPending = false;
    await runFullSync();
    if (!backgroundSyncPending) break;
  }
}

function withoutIncompleteEventWarning(warnings: DashboardNotice[], locale: DashboardLocale): DashboardNotice[] {
  const incomplete = t(locale, "warningEventsIncomplete");
  return warnings.filter((warning) => warning.message !== incomplete);
}

/** Download the 120-day event history and replace or upsert the local archive. */
export async function runEventHistorySync(state: UsageRefreshState, host: UsageRefreshHost): Promise<void> {
  const storeSince = Date.now() - STORE_LOOKBACK_DAYS * 86_400_000;
  const locale = host.locale();
  state.fullHistoryAttempted = true;
  state.eventHistorySyncInProgress = true;
  host.publishState();
  host.log("Background event history sync started");

  try {
    const eventsResult = await fetchUsageEvents({
      maxPages: MAX_STORE_SYNC_PAGES,
      lookbackDays: STORE_LOOKBACK_DAYS,
    });
    const warnings = withoutIncompleteEventWarning(state.lastWarnings, locale);
    let eventsComplete = eventsResult.complete && !eventsResult.truncated;
    if (eventsResult.truncated) {
      warnings.push(
        dashboardNotice(t(locale, "warningEventsIncomplete"), eventsResult.failureReason),
      );
    } else if (!eventsResult.complete) {
      warnings.push(
        dashboardNotice(t(locale, "warningEventsFetchFailed"), eventsResult.failureReason),
      );
    }

    try {
      const store = await host.ensureEventStore();
      if (eventsComplete) {
        store.syncEventsFromApi(eventsResult.events, storeSince, {
          allowEmpty: true,
          totalCovered: eventsResult.totalCovered,
        });
        store.flushPersist();
      } else {
        store.upsertEvents(eventsResult.events);
      }
      state.lastEvents = await host.loadStoredEvents();
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      host.log(`Event store sync failed: ${detail}`);
      warnings.push(dashboardNotice(t(locale, "warningEventStoreSyncFailed"), detail));
      state.lastEvents = eventsResult.events;
      eventsComplete = false;
    }

    await host.refreshConversationTitles(state.lastEvents ?? []);
    state.fullHistorySynced = eventsComplete;
    state.lastWarnings = warnings;
    state.lastEventsComplete = eventsComplete;

    if (state.lastData) {
      const enriched = enrichUsageFromEvents(state.lastData, state.lastEvents ?? [], Date.now());
      state.lastData = enriched;
      updateStatusBar(enriched, host.statusBarContext());
    }

    host.publishState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    host.log(`Background event history sync failed: ${msg}`);
  } finally {
    state.eventHistorySyncInProgress = false;
    host.publishState();
    host.log("Background event history sync finished");
  }
}

/** Fetch usage, spend, and the quick event page window, then upsert the archive. */
export async function runUpdateUsage(
  force: boolean,
  state: UsageRefreshState,
  host: UsageRefreshHost,
): Promise<void> {
  const statusBarItem = host.statusBarItem();

  if (force) {
    invalidateSetupCache();
  }

  const locale = host.locale();
  const warnings: DashboardNotice[] = [];
  let eventsComplete = true;

  try {
    const [dataResult, eventsResult] = await Promise.allSettled([
      fetchUsageData(),
      fetchUsageEvents({ maxPages: MAX_USAGE_EVENT_PAGES, lookbackDays: STORE_LOOKBACK_DAYS }),
    ]);

    const data = dataResult.status === "fulfilled" ? dataResult.value : null;
    if (dataResult.status === "rejected") {
      host.log(`Usage data fetch failed: ${dataResult.reason}`);
    }

    const resetsAtForSpend = data?.resetsAt ?? state.lastData?.resetsAt ?? null;
    try {
      state.lastDailySpend = await fetchDailySpendByCategory({ resetAtIso: resetsAtForSpend });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      host.log(`Daily spend fetch failed: ${detail}`);
      warnings.push(dashboardNotice(t(locale, "warningSpendFetchFailed"), detail));
    }

    if (eventsResult.status === "fulfilled") {
      const { events: apiEvents, complete, truncated, failureReason } = eventsResult.value;
      if (!complete && !truncated) {
        eventsComplete = false;
        warnings.push(dashboardNotice(t(locale, "warningEventsFetchFailed"), failureReason));
      } else if (truncated) {
        if (state.fullHistorySynced) {
          eventsComplete = true;
        } else if (state.eventHistorySyncInProgress || !state.fullHistoryAttempted) {
          if (!state.fullHistoryAttempted && !state.eventHistorySyncInProgress) {
            state.quickFetchTruncated = true;
          }
          eventsComplete = state.lastEventsComplete;
        } else {
          eventsComplete = false;
          warnings.push(dashboardNotice(t(locale, "warningEventsIncomplete"), failureReason));
        }
      } else {
        eventsComplete = true;
        state.fullHistorySynced = true;
      }
      try {
        const store = await host.ensureEventStore();
        store.upsertEvents(apiEvents);
        state.lastEvents = await host.loadStoredEvents();
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        host.log(`Event store sync failed: ${detail}`);
        warnings.push(dashboardNotice(t(locale, "warningEventStoreSyncFailed"), detail));
        state.lastEvents = apiEvents;
      }
      await host.refreshConversationTitles(state.lastEvents ?? []);
    } else if (eventsResult.status === "rejected") {
      host.log(`Usage events fetch failed: ${eventsResult.reason}`);
      eventsComplete = false;
      warnings.push(
        dashboardNotice(t(locale, "warningEventsFetchFailed"), failureMessage(eventsResult.reason)),
      );
    }

    state.lastWarnings = warnings;
    state.lastEventsComplete = eventsComplete;

    if (data) {
      const grokResolved = resolveGrokBotUsageWithCache(
        host.globalState(),
        data.grokBotUsage,
        Date.now(),
      );
      let payload = data;
      if (grokResolved.usage !== data.grokBotUsage) {
        payload = { ...data, grokBotUsage: grokResolved.usage };
      }
      if (grokResolved.stale) {
        warnings.push(dashboardNotice(t(locale, "warningGrokBotUsageCached")));
        host.log("Grok Bot weekly meter: using cached value (sand API unavailable)");
      }

      const eventsForEnrichment = state.lastEvents ?? [];
      const enriched = enrichUsageFromEvents(payload, eventsForEnrichment, Date.now());
      state.lastData = enriched;
      state.lastError = null;
      state.lastErrorDetail = null;
      updateStatusBar(enriched, host.statusBarContext());
    } else {
      state.lastError = t(locale, "fetchUsageFailed");
      state.lastErrorDetail =
        dataResult.status === "rejected"
          ? failureMessage(dataResult.reason)
          : t(locale, "errorDetailUsageDataUnavailable");
      if (!state.lastData) {
        statusBarItem.text = `$(warning) ${t(locale, "usageUnavailable")}`;
        statusBarItem.tooltip = t(locale, "fetchError");
      } else {
        updateStatusBar(state.lastData, host.statusBarContext());
      }
    }

    host.publishState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    host.log(`Error in updateUsage: ${msg}`);
    state.lastError = t(locale, "fetchUsageFailed");
    state.lastErrorDetail = msg;
    if (!state.lastData) {
      statusBarItem.text = `$(warning) ${t(locale, "usageUnavailable")}`;
      statusBarItem.tooltip = `${t(locale, "errorPrefix")}: ${msg}`;
    } else if (state.lastData) {
      updateStatusBar(state.lastData, host.statusBarContext());
    }
    host.publishState();
  } finally {
    state.lastFetchTime = Date.now();
  }
}
