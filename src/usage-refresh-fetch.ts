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
import { getBillingCycleCutoff, MAX_STORE_SYNC_PAGES, MAX_USAGE_EVENT_PAGES } from "./cursor-api-utils";
import { dashboardNotice, type DashboardNotice } from "./dashboard-state";
import { invalidateSetupCache } from "./cursor-setup-cache";
import type { DashboardLocale } from "./dashboard-locale";
import { refreshEurPerUsd } from "./eur-usd-rate";
import { resolveGrokBotUsageWithCache } from "./grok-bot-usage-cache";
import { t } from "./i18n";
import { updateStatusBar } from "./status-bar-content";
import type { UsageEventStoreApi } from "./db-worker-client";

/** Local archive, API download, and dashboard load share this window. */
export const EVENT_RETENTION_DAYS = 60;

const DAY_MS = 86_400_000;

/**
 * Oldest timestamp to keep. A billing cycle that started before the 60-day
 * mark is kept in full; a missing or invalid reset uses only the 60-day mark.
 */
export function eventRetentionCutoffMs(now: number, resetsAt: string | null): number {
  const retentionCutoff = now - EVENT_RETENTION_DAYS * DAY_MS;
  if (!resetsAt) return retentionCutoff;
  const resetAt = new Date(resetsAt);
  if (Number.isNaN(resetAt.getTime())) return retentionCutoff;
  return Math.min(retentionCutoff, getBillingCycleCutoff(resetsAt, now));
}

/** Whole days so an API start date computed from `now` is not after `cutoffMs`. */
export function eventRetentionLookbackDays(now: number, cutoffMs: number): number {
  return Math.ceil((now - cutoffMs) / DAY_MS);
}

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
  ensureEventStore: () => Promise<UsageEventStoreApi>;
  loadStoredEvents: (sinceMs: number) => Promise<UsageEvent[]>;
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

async function purgeStoredEvents(host: UsageRefreshHost, cutoffMs: number): Promise<void> {
  try {
    const store = await host.ensureEventStore();
    const removed = await store.purgeEventsBefore(cutoffMs);
    if (removed > 0) {
      host.log(`Purged ${removed} usage events older than the retention cutoff`);
    }
  } catch (err: unknown) {
    host.log(`Usage event purge failed: ${failureMessage(err)}`);
  }
}

function withoutIncompleteEventWarning(warnings: DashboardNotice[], locale: DashboardLocale): DashboardNotice[] {
  const incomplete = t(locale, "warningEventsIncomplete");
  return warnings.filter((warning) => warning.message !== incomplete);
}

/** Download the retained event history and replace or upsert the local archive. */
export async function runEventHistorySync(state: UsageRefreshState, host: UsageRefreshHost): Promise<void> {
  const now = Date.now();
  const cutoffMs = eventRetentionCutoffMs(now, state.lastData?.resetsAt ?? null);
  const locale = host.locale();
  state.fullHistoryAttempted = true;
  state.eventHistorySyncInProgress = true;
  host.publishState();
  host.log("Background event history sync started");

  try {
    const eventsResult = await fetchUsageEvents({
      maxPages: MAX_STORE_SYNC_PAGES,
      startDateMs: cutoffMs,
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

    let storeWriteOk = false;
    try {
      const store = await host.ensureEventStore();
      if (eventsComplete) {
        await store.syncEventsFromApi(eventsResult.events, cutoffMs, {
          allowEmpty: true,
          totalCovered: eventsResult.totalCovered,
        });
        await store.flushPersist();
      } else {
        await store.upsertEvents(eventsResult.events);
      }
      storeWriteOk = true;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      host.log(`Event store sync failed: ${detail}`);
      warnings.push(dashboardNotice(t(locale, "warningEventStoreSyncFailed"), detail));
      state.lastEvents = eventsResult.events;
      eventsComplete = false;
    }
    await purgeStoredEvents(host, cutoffMs);
    if (storeWriteOk) {
      state.lastEvents = await host.loadStoredEvents(cutoffMs);
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
    await purgeStoredEvents(host, cutoffMs);
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
  const now = Date.now();
  const eurRefresh = refreshEurPerUsd();

  try {
    const dataResult = await Promise.allSettled([fetchUsageData()]).then((results) => results[0]!);
    const data = dataResult.status === "fulfilled" ? dataResult.value : null;
    if (dataResult.status === "rejected") {
      host.log(`Usage data fetch failed: ${dataResult.reason}`);
    }

    const resetsAt = data?.resetsAt ?? state.lastData?.resetsAt ?? null;
    const cutoffMs = eventRetentionCutoffMs(now, resetsAt);
    const lookbackDays = eventRetentionLookbackDays(now, cutoffMs);
    const eventsResult = await Promise.allSettled([
      fetchUsageEvents({ maxPages: MAX_USAGE_EVENT_PAGES, lookbackDays }),
    ]).then((results) => results[0]!);

    const resetsAtForSpend = resetsAt;
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
      let storeWriteOk = false;
      try {
        const store = await host.ensureEventStore();
        await store.upsertEvents(apiEvents);
        storeWriteOk = true;
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        host.log(`Event store sync failed: ${detail}`);
        warnings.push(dashboardNotice(t(locale, "warningEventStoreSyncFailed"), detail));
        state.lastEvents = apiEvents;
      }
      await purgeStoredEvents(host, cutoffMs);
      if (storeWriteOk) {
        state.lastEvents = await host.loadStoredEvents(cutoffMs);
      }
      await host.refreshConversationTitles(state.lastEvents ?? []);
    } else if (eventsResult.status === "rejected") {
      host.log(`Usage events fetch failed: ${eventsResult.reason}`);
      eventsComplete = false;
      warnings.push(
        dashboardNotice(t(locale, "warningEventsFetchFailed"), failureMessage(eventsResult.reason)),
      );
      await purgeStoredEvents(host, cutoffMs);
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
    publishSettledEurRate(eurRefresh, state, host);
  }
}

/** The FX request must not hold the refresh spinner. Republish when it settles. */
function publishSettledEurRate(
  eurRefresh: Promise<number>,
  state: UsageRefreshState,
  host: UsageRefreshHost,
): void {
  void eurRefresh.then(() => {
    try {
      if (state.lastData) {
        updateStatusBar(state.lastData, host.statusBarContext());
      }
      host.publishState();
    } catch (err: unknown) {
      host.log(`EUR rate publish failed: ${failureMessage(err)}`);
    }
  });
}
