import * as vscode from "vscode";
import {
  enrichUsageFromEvents,
  fetchDailySpendByCategory,
  fetchUsageData,
  fetchUsageEvents,
  isTeamMemberCached,
  type DailySpendRow,
  type UsagePayload,
  type UsageEvent,
} from "./cursor-api";
import { normalizeUsageEventRequests } from "./cursor-usage-parsing";
import { DashboardPanel, OPEN_DASHBOARD_COMMAND } from "./dashboard-panel";
import { buildConversationTitleMap } from "./conversation-titles";
import { CONVERSATION_PREVIEW_KEY } from "./dashboard-locale";
import { getDashboardLocale } from "./dashboard-locale-state";
import { getDashboardCurrency } from "./dashboard-currency-state";
import type { DashboardCurrency, DashboardLocale } from "./dashboard-locale";
import { isOnDemandVisible } from "./on-demand";
import { buildDashboardState, type DashboardState } from "./dashboard-state";
import { MAX_STORE_SYNC_PAGES, MAX_USAGE_EVENT_PAGES } from "./cursor-api-utils";
import { invalidateSetupCache } from "./cursor-setup-cache";
import { formatResetCountdown, t, tf } from "./i18n";
import { formatStatusBarUsageText } from "./pool-usage";
import { shouldShowPremiumRequestsQuota } from "./usage-display";
import { UsageEventStore } from "./usage-event-store";
import { usageEventFingerprint } from "./usage-event-fingerprint";
import { updateStatusBar, type StatusBarConfig } from "./status-bar-content";
import { initPricingCatalogRefresh, refreshPricingCatalog } from "./pricing-catalog-refresh";
import { PricingCatalogStore } from "./pricing-catalog-store";

export { refreshPricingCatalog };

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let lastData: UsagePayload | null = null;
let lastError: string | null = null;
let lastFetchTime = 0;
let fetchPromise: Promise<void> | null = null;
let queuedNonForce = false;
let queuedForce = false;
let lastEvents: UsageEvent[] | null = null;
let lastDailySpend: DailySpendRow[] | null = null;
let extensionContext: vscode.ExtensionContext;
let eventStore: UsageEventStore | null = null;
let conversationTitles: Record<string, string> = {};
let conversationPreviewEnabled = false;
let storedEventCount = 0;
let lastWarnings: string[] = [];
let lastEventsComplete = true;
let pricingCatalogStore: PricingCatalogStore | null = null;
let eventHistorySyncInProgress = false;
let pendingBackgroundEventSync = false;
let backgroundEventSyncPromise: Promise<void> | null = null;

const STORE_LOOKBACK_DAYS = 120;
const DEBOUNCE_MS = 30_000;

export type UpdateUsageOptions = {
  force?: boolean;
  /** Full 120-day / 100-page event store sync (background; skips usage API refetch). */
  fullEventSync?: boolean;
};

export function initExtensionRefresh(
  context: vscode.ExtensionContext,
  barItem: vscode.StatusBarItem,
  channel: vscode.OutputChannel,
): void {
  extensionContext = context;
  statusBarItem = barItem;
  outputChannel = channel;
  conversationPreviewEnabled = isConversationPreviewEnabled();
  pricingCatalogStore = new PricingCatalogStore(context.globalStorageUri.fsPath);
  initPricingCatalogRefresh(
    pricingCatalogStore,
    getDashboardState,
    log,
    () => DashboardPanel.currentPanel?.postState(getDashboardState()),
  );
}

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

export function getConfig(): StatusBarConfig & { pollInterval: number; quotaAwareEventDisplay: boolean } {
  const cfg = vscode.workspace.getConfiguration("cursorUsage");
  const modelBreakdownSortBy = cfg.get<StatusBarConfig["modelBreakdownSortBy"]>("modelBreakdownSortBy", "tokens");
  const modelBreakdownSortOrder = cfg.get<StatusBarConfig["modelBreakdownSortOrder"]>("modelBreakdownSortOrder", "desc");
  return {
    pollInterval: cfg.get<number>("pollInterval", 5),
    minimalMode: cfg.get<boolean>("minimalMode", false),
    usageDuration: cfg.get<string>("usageDuration", "billingCycle"),
    modelBreakdownSortBy,
    modelBreakdownSortOrder,
    excludeZeroTokenModels: cfg.get<boolean>("excludeZeroTokenModels", false),
    quotaAwareEventDisplay: cfg.get<boolean>("quotaAwareEventDisplay", true),
  };
}

function getCooldownMs(): number {
  return getConfig().pollInterval * 60_000;
}

export function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    if (Date.now() - lastFetchTime >= getCooldownMs()) {
      updateUsage();
    }
  }, DEBOUNCE_MS);
}

export function refreshOnFocus(state: vscode.WindowState): void {
  if (state.focused && Date.now() - lastFetchTime >= getCooldownMs()) {
    updateUsage();
  }
}

function getLocale(): DashboardLocale {
  return getDashboardLocale(extensionContext);
}

function getCurrency(): DashboardCurrency {
  return getDashboardCurrency(extensionContext);
}

function isConversationPreviewEnabled(): boolean {
  return extensionContext.globalState.get<boolean>(CONVERSATION_PREVIEW_KEY) === true;
}

async function ensureEventStore(): Promise<UsageEventStore> {
  if (!eventStore) {
    eventStore = new UsageEventStore(
      extensionContext.globalStorageUri.fsPath,
      extensionContext.extensionPath,
    );
    await eventStore.init();
  }
  return eventStore;
}

async function refreshConversationTitles(events: UsageEvent[]): Promise<number> {
  conversationPreviewEnabled = isConversationPreviewEnabled();
  if (!conversationPreviewEnabled) {
    conversationTitles = {};
    return 0;
  }
  const ids = events.map((event) => event.conversationId).filter((id): id is string => Boolean(id));
  conversationTitles = await buildConversationTitleMap(ids, extensionContext.extensionPath);
  return Object.keys(conversationTitles).length;
}

export async function handleConversationPreviewChange(previewEnabled: boolean): Promise<void> {
  conversationPreviewEnabled = previewEnabled;
  await extensionContext.globalState.update(CONVERSATION_PREVIEW_KEY, previewEnabled);
  const conversationCount = previewEnabled
    ? new Set((lastEvents ?? []).map((e) => e.conversationId).filter(Boolean)).size
    : 0;
  const titleCount = previewEnabled && lastEvents ? await refreshConversationTitles(lastEvents) : 0;
  if (!previewEnabled) {
    conversationTitles = {};
  }
  DashboardPanel.currentPanel?.postPreviewStatus(previewEnabled, titleCount, conversationCount);
  DashboardPanel.currentPanel?.postState(getDashboardState());
}

async function loadStoredEvents(): Promise<UsageEvent[]> {
  const store = await ensureEventStore();
  storedEventCount = store.getEventCount();
  const since = Date.now() - STORE_LOOKBACK_DAYS * 86_400_000;
  return store.getEventsSince(since);
}

function buildStatusBarContext() {
  const config = getConfig();
  return {
    statusBarItem,
    locale: getLocale(),
    currency: getCurrency(),
    config,
    lastEvents,
    lastDailySpend,
    getDashboardEventFilter: DashboardPanel.getDashboardEventFilter,
  };
}

export function refreshStatusBarFromLastData(): void {
  if (lastData) {
    updateStatusBar(lastData, buildStatusBarContext());
  }
}

export async function updateUsage(opts?: UpdateUsageOptions): Promise<void> {
  const force = opts?.force ?? false;
  const fullEventSync = opts?.fullEventSync ?? false;
  if (fetchPromise) {
    if (!force && !fullEventSync) {
      queuedNonForce = true;
      return;
    }
    if (force && !fullEventSync) {
      queuedForce = true;
    } else if (fullEventSync) {
      pendingBackgroundEventSync = true;
    }
    await fetchPromise;
    while (fetchPromise) {
      await fetchPromise;
    }
    if (fullEventSync) {
      return;
    }
    return;
  }

  const run = fullEventSync ? runEventHistorySync() : runUpdateUsage(force);
  fetchPromise = run;
  try {
    await run;
  } finally {
    if (fetchPromise === run) {
      fetchPromise = null;
    }
  }

  if (queuedForce) {
    queuedForce = false;
    queuedNonForce = false;
    await updateUsage({ force: true });
  } else if (queuedNonForce) {
    queuedNonForce = false;
    await updateUsage();
  } else if (force && !fullEventSync) {
    requestBackgroundEventHistorySync();
  }
}

function requestBackgroundEventHistorySync(): void {
  pendingBackgroundEventSync = true;
  if (backgroundEventSyncPromise) {
    return;
  }
  backgroundEventSyncPromise = drainBackgroundEventHistorySync().finally(() => {
    backgroundEventSyncPromise = null;
  });
}

async function drainBackgroundEventHistorySync(): Promise<void> {
  while (pendingBackgroundEventSync) {
    pendingBackgroundEventSync = false;
    await updateUsage({ fullEventSync: true });
    if (!pendingBackgroundEventSync) {
      break;
    }
  }
}

async function runEventHistorySync(): Promise<void> {
  const storeSince = Date.now() - STORE_LOOKBACK_DAYS * 86_400_000;
  const locale = getLocale();
  eventHistorySyncInProgress = true;
  DashboardPanel.currentPanel?.postState(getDashboardState());
  log("Background event history sync started");

  try {
    const eventsResult = await fetchUsageEvents({
      maxPages: MAX_STORE_SYNC_PAGES,
      lookbackDays: STORE_LOOKBACK_DAYS,
    });
    const warnings = [...lastWarnings];
    let eventsComplete = eventsResult.complete;
    if (!eventsComplete) {
      warnings.push(t(locale, "warningEventsIncomplete"));
    }

    try {
      const store = await ensureEventStore();
      if (eventsComplete) {
        store.syncEventsFromApi(eventsResult.events, storeSince, { allowEmpty: true });
        store.flushPersist();
      } else {
        store.upsertEvents(eventsResult.events);
      }
      lastEvents = await loadStoredEvents();
    } catch (err: unknown) {
      log(`Event store sync failed: ${err instanceof Error ? err.message : String(err)}`);
      warnings.push(t(locale, "warningEventStoreSyncFailed"));
      lastEvents = eventsResult.events;
      eventsComplete = false;
    }

    await refreshConversationTitles(lastEvents ?? []);
    lastWarnings = warnings;
    lastEventsComplete = eventsComplete;

    if (lastData) {
      const enriched = enrichUsageFromEvents(lastData, lastEvents ?? [], Date.now());
      lastData = enriched;
      updateStatusBar(enriched, buildStatusBarContext());
    }

    DashboardPanel.currentPanel?.postState(getDashboardState());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Background event history sync failed: ${msg}`);
  } finally {
    eventHistorySyncInProgress = false;
    DashboardPanel.currentPanel?.postState(getDashboardState());
    log("Background event history sync finished");
  }
}

async function runUpdateUsage(force: boolean): Promise<void> {
  statusBarItem.text = statusBarItem.text.replace("$(pulse)", "$(loading~spin)");
  await new Promise((r) => setTimeout(r, 0));

  if (force) {
    invalidateSetupCache();
  }

  const locale = getLocale();
  const warnings: string[] = [];
  let eventsComplete = true;

  try {
    const [dataResult, eventsResult] = await Promise.allSettled([
      fetchUsageData(),
      fetchUsageEvents({ maxPages: MAX_USAGE_EVENT_PAGES, lookbackDays: STORE_LOOKBACK_DAYS }),
    ]);

    const data = dataResult.status === "fulfilled" ? dataResult.value : null;
    if (dataResult.status === "rejected") {
      log(`Usage data fetch failed: ${dataResult.reason}`);
    }

    const resetsAtForSpend = data?.resetsAt ?? lastData?.resetsAt ?? null;
    try {
      lastDailySpend = await fetchDailySpendByCategory({ resetAtIso: resetsAtForSpend });
    } catch (err: unknown) {
      log(`Daily spend fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      warnings.push(t(locale, "warningSpendFetchFailed"));
    }

    if (eventsResult.status === "fulfilled") {
      const { events: apiEvents, complete } = eventsResult.value;
      eventsComplete = complete;
      if (!complete) {
        warnings.push(t(locale, "warningEventsIncomplete"));
      }
      try {
        const store = await ensureEventStore();
        store.upsertEvents(apiEvents);
        lastEvents = await loadStoredEvents();
      } catch (err: unknown) {
        log(`Event store sync failed: ${err instanceof Error ? err.message : String(err)}`);
        warnings.push(t(locale, "warningEventStoreSyncFailed"));
        lastEvents = apiEvents;
      }
      await refreshConversationTitles(lastEvents ?? []);
    } else if (eventsResult.status === "rejected") {
      log(`Usage events fetch failed: ${eventsResult.reason}`);
      eventsComplete = false;
      warnings.push(t(locale, "warningEventsFetchFailed"));
    }

    lastWarnings = warnings;
    lastEventsComplete = eventsComplete;

    if (data) {
      const eventsForEnrichment = lastEvents ?? [];
      const enriched = enrichUsageFromEvents(data, eventsForEnrichment, Date.now());
      lastData = enriched;
      lastError = null;
      updateStatusBar(enriched, buildStatusBarContext());
    } else {
      lastError = t(locale, "fetchUsageFailed");
      if (!lastData) {
        statusBarItem.text = `$(warning) ${t(locale, "usageUnavailable")}`;
        statusBarItem.tooltip = t(locale, "fetchError");
      } else {
        statusBarItem.text = statusBarItem.text.replace("$(loading~spin)", "$(pulse)");
        updateStatusBar(lastData, buildStatusBarContext());
      }
    }

    DashboardPanel.currentPanel?.postState(getDashboardState());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error in updateUsage: ${msg}`);
    lastError = msg;
    if (!lastData) {
      statusBarItem.text = `$(warning) ${t(locale, "usageUnavailable")}`;
      statusBarItem.tooltip = `${t(locale, "errorPrefix")}: ${msg}`;
    } else {
      statusBarItem.text = statusBarItem.text.replace("$(loading~spin)", "$(pulse)");
    }
    DashboardPanel.currentPanel?.postState(getDashboardState());
  } finally {
    lastFetchTime = Date.now();
  }
}

export async function showDetails(): Promise<void> {
  const locale = getLocale();
  const refreshLabel = t(locale, "refresh");
  const openLabel = t(locale, "openDashboard");
  const logsLabel = t(locale, "showLogs");

  if (!lastData) {
    const items: string[] = [refreshLabel, openLabel, logsLabel];
    const action = await vscode.window.showWarningMessage(
      lastError
        ? tf(locale, "usageUnavailableDetail", { error: lastError })
        : t(locale, "usageNotAvailableYet"),
      ...items,
    );
    if (action === refreshLabel) await updateUsage({ force: true });
    else if (action === openLabel) await vscode.commands.executeCommand(OPEN_DASHBOARD_COMMAND);
    else if (action === logsLabel) outputChannel.show();
    return;
  }

  const { onDemand, resetsAt } = lastData;
  const onDemandVisible = isOnDemandVisible(onDemand);
  const showPremiumRequests = shouldShowPremiumRequestsQuota(lastData.planInfo, lastData.poolUsage);

  let message = `${formatStatusBarUsageText(lastData, {
    onDemandVisible,
    showPremiumRequests,
    currency: getCurrency(),
    locale,
  })}`;
  if (resetsAt) message += ` | ${formatResetCountdown(resetsAt, locale)}`;

  const action = await vscode.window.showInformationMessage(
    message,
    openLabel,
    refreshLabel,
  );

  if (action === openLabel) {
    await vscode.commands.executeCommand(OPEN_DASHBOARD_COMMAND);
  } else if (action === refreshLabel) {
    await updateUsage({ force: true });
  }
}

export function getDashboardState(): DashboardState {
  const now = Date.now();
  const rawEvents = lastEvents ?? [];
  const allEvents = rawEvents.map((event) => {
    const normalized = normalizeUsageEventRequests(event);
    return { ...normalized, eventKey: usageEventFingerprint(normalized) };
  });
  // Send the full event archive to the webview. Range / usage filters are applied
  // client-side for charts and tables; pool pacing also needs the unfiltered history.
  return buildDashboardState(
    lastData,
    allEvents,
    lastDailySpend ?? [],
    isTeamMemberCached(),
    lastError,
    now,
    getConfig().quotaAwareEventDisplay,
    conversationPreviewEnabled ? conversationTitles : {},
    storedEventCount,
    allEvents,
    lastWarnings,
    lastEventsComplete,
    eventHistorySyncInProgress,
  );
}

export function cleanupExtensionRefresh(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  fetchPromise = null;
  queuedNonForce = false;
  queuedForce = false;
  pendingBackgroundEventSync = false;
  eventHistorySyncInProgress = false;
  eventStore?.close();
  eventStore = null;
}

export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}
