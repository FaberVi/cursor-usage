import * as vscode from "vscode";
import {
  isTeamMemberCached,
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
import { formatResetCountdown, t, tf } from "./i18n";
import { formatStatusBarUsageText } from "./pool-usage";
import { shouldShowPremiumRequestsQuota } from "./usage-display";
import { UsageEventStore } from "./usage-event-store";
import { usageEventFingerprint } from "./usage-event-fingerprint";
import { updateStatusBar, type StatusBarConfig, type StatusBarContext } from "./status-bar-content";
import {
  clearBackgroundEventSyncPending,
  markBackgroundEventSyncPending,
  requestBackgroundEventHistorySync,
  runEventHistorySync,
  runUpdateUsage,
  STORE_LOOKBACK_DAYS,
  type UsageRefreshHost,
  type UsageRefreshState,
} from "./usage-refresh-fetch";
import { initPricingCatalogRefresh, refreshPricingCatalog } from "./pricing-catalog-refresh";
import { PricingCatalogStore } from "./pricing-catalog-store";

export { refreshPricingCatalog };

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const usageState: UsageRefreshState = {
  lastData: null,
  lastError: null,
  lastErrorDetail: null,
  lastFetchTime: 0,
  lastEvents: null,
  lastDailySpend: null,
  lastWarnings: [],
  lastEventsComplete: true,
  quickFetchTruncated: false,
  fullHistoryAttempted: false,
  fullHistorySynced: false,
  eventHistorySyncInProgress: false,
};
let fetchPromise: Promise<void> | null = null;
let queuedNonForce = false;
let queuedForce = false;
let extensionContext: vscode.ExtensionContext;
let eventStore: UsageEventStore | null = null;
let conversationTitles: Record<string, string> = {};
let conversationPreviewEnabled = false;
let storedEventCount = 0;
let grokBotStoredEventCount = 0;
let pricingCatalogStore: PricingCatalogStore | null = null;
let refreshBusyDepth = 0;

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
    if (Date.now() - usageState.lastFetchTime >= getCooldownMs()) {
      updateUsage();
    }
  }, DEBOUNCE_MS);
}

export function refreshOnFocus(state: vscode.WindowState): void {
  if (state.focused && Date.now() - usageState.lastFetchTime >= getCooldownMs()) {
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
    ? new Set((usageState.lastEvents ?? []).map((e) => e.conversationId).filter(Boolean)).size
    : 0;
  const titleCount = previewEnabled && usageState.lastEvents ? await refreshConversationTitles(usageState.lastEvents) : 0;
  if (!previewEnabled) {
    conversationTitles = {};
  }
  DashboardPanel.currentPanel?.postPreviewStatus(previewEnabled, titleCount, conversationCount);
  DashboardPanel.currentPanel?.postState(getDashboardState());
}

async function loadStoredEvents(): Promise<UsageEvent[]> {
  const store = await ensureEventStore();
  storedEventCount = store.getEventCount();
  grokBotStoredEventCount = store.getGrokBotEventCount();
  const since = Date.now() - STORE_LOOKBACK_DAYS * 86_400_000;
  return store.getEventsSince(since);
}

function buildStatusBarContext(): StatusBarContext {
  const config = getConfig();
  return {
    statusBarItem,
    locale: getLocale(),
    currency: getCurrency(),
    config,
    lastEvents: usageState.lastEvents,
    lastDailySpend: usageState.lastDailySpend,
    getDashboardEventFilter: DashboardPanel.getDashboardEventFilter,
    refreshing: refreshBusyDepth > 0,
  };
}

export function refreshStatusBarFromLastData(): void {
  if (usageState.lastData) {
    updateStatusBar(usageState.lastData, buildStatusBarContext());
  }
}

function usageRefreshHost(): UsageRefreshHost {
  return {
    log,
    ensureEventStore,
    loadStoredEvents,
    refreshConversationTitles,
    locale: getLocale,
    statusBarItem: () => statusBarItem,
    statusBarContext: buildStatusBarContext,
    publishState: () => {
      DashboardPanel.currentPanel?.postState(getDashboardState());
    },
    globalState: () => extensionContext.globalState,
  };
}

function setRefreshButtonBusy(on: boolean): void {
  const panel = DashboardPanel.currentPanel;
  if (panel && typeof panel.postLoading === "function") {
    panel.postLoading(on);
  }
}

function setStatusBarLeadingIcon(icon: "$(loading~spin)" | "$(pulse)"): void {
  const current = statusBarItem.text;
  if (/^\$\([^)]+\)\s/.test(current)) {
    statusBarItem.text = current.replace(/^\$\([^)]+\)/, icon);
    return;
  }
  statusBarItem.text = `${icon} ${current}`;
}

function applyStatusBarRefreshingVisual(): void {
  if (usageState.lastData) {
    setStatusBarLeadingIcon("$(loading~spin)");
    return;
  }
  const locale = getLocale();
  statusBarItem.text = `$(loading~spin) ${t(locale, "statusBarUsage")}`;
}

function beginRefreshBusy(): void {
  refreshBusyDepth += 1;
  if (refreshBusyDepth === 1) {
    setRefreshButtonBusy(true);
    applyStatusBarRefreshingVisual();
  }
}

function endRefreshBusy(): void {
  refreshBusyDepth = Math.max(0, refreshBusyDepth - 1);
  if (refreshBusyDepth === 0) {
    setRefreshButtonBusy(false);
    if (usageState.lastData) {
      setStatusBarLeadingIcon("$(pulse)");
    }
  }
}

export function isUsageRefreshBusy(): boolean {
  return refreshBusyDepth > 0;
}

export async function updateUsage(opts?: UpdateUsageOptions): Promise<void> {
  beginRefreshBusy();
  try {
    await runUpdateUsageCycle(opts);
  } finally {
    endRefreshBusy();
  }
}

async function runUpdateUsageCycle(opts?: UpdateUsageOptions): Promise<void> {
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
      markBackgroundEventSyncPending();
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

  const host = usageRefreshHost();
  const run = fullEventSync ? runEventHistorySync(usageState, host) : runUpdateUsage(force, usageState, host);
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
  } else if ((force || usageState.quickFetchTruncated) && !fullEventSync) {
    usageState.quickFetchTruncated = false;
    requestBackgroundEventHistorySync(() => updateUsage({ fullEventSync: true }));
  }
}

export async function showDetails(): Promise<void> {
  const locale = getLocale();
  const refreshLabel = t(locale, "refresh");
  const openLabel = t(locale, "openDashboard");
  const logsLabel = t(locale, "showLogs");

  if (!usageState.lastData) {
    const items: string[] = [refreshLabel, openLabel, logsLabel];
    const action = await vscode.window.showWarningMessage(
      usageState.lastError
        ? tf(locale, "usageUnavailableDetail", { error: usageState.lastError })
        : t(locale, "usageNotAvailableYet"),
      ...items,
    );
    if (action === refreshLabel) await updateUsage({ force: true });
    else if (action === openLabel) await vscode.commands.executeCommand(OPEN_DASHBOARD_COMMAND);
    else if (action === logsLabel) outputChannel.show();
    return;
  }

  const { onDemand, resetsAt } = usageState.lastData;
  const onDemandVisible = isOnDemandVisible(onDemand);
  const showPremiumRequests = shouldShowPremiumRequestsQuota(usageState.lastData.planInfo, usageState.lastData.poolUsage);

  let message = `${formatStatusBarUsageText(usageState.lastData, {
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
  const rawEvents = usageState.lastEvents ?? [];
  const allEvents = rawEvents.map((event) => {
    const normalized = normalizeUsageEventRequests(event);
    return { ...normalized, eventKey: usageEventFingerprint(normalized) };
  });
  // Send the full event archive to the webview. Range / usage filters are applied
  // client-side for charts and tables; pool pacing also needs the unfiltered history.
  return buildDashboardState(
    usageState.lastData,
    allEvents,
    usageState.lastDailySpend ?? [],
    isTeamMemberCached(),
    usageState.lastError,
    now,
    getConfig().quotaAwareEventDisplay,
    conversationPreviewEnabled ? conversationTitles : {},
    storedEventCount,
    allEvents,
    usageState.lastWarnings,
    usageState.lastEventsComplete,
    usageState.eventHistorySyncInProgress,
    grokBotStoredEventCount,
    usageState.lastErrorDetail,
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
  clearBackgroundEventSyncPending();
  usageState.eventHistorySyncInProgress = false;
  usageState.quickFetchTruncated = false;
  usageState.fullHistoryAttempted = false;
  usageState.fullHistorySynced = false;
  refreshBusyDepth = 0;
  usageState.lastWarnings = [];
  usageState.lastEventsComplete = true;
  usageState.lastData = null;
  usageState.lastEvents = null;
  usageState.lastError = null;
  usageState.lastErrorDetail = null;
  eventStore?.close();
  eventStore = null;
}

export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}
