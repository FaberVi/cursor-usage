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
import {
  configureDbWorker,
  shutdownDbWorker,
  usageEventStoreApi,
  type UsageEventStoreApi,
} from "./db-worker-client";
import { usageEventFingerprint } from "./usage-event-fingerprint";
import { updateStatusBar, type StatusBarConfig, type StatusBarContext } from "./status-bar-content";
import {
  clearBackgroundEventSyncPending,
  markBackgroundEventSyncPending,
  requestBackgroundEventHistorySync,
  runEventHistorySync,
  runUpdateUsage,
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
let eventStore: UsageEventStoreApi | null = null;
let conversationTitles: Record<string, string> = {};
// Titles rarely change; keep them so each refresh does not rescan Cursor's state.vscdb.
const conversationTitleCache = new Map<string, { title: string | null; at: number }>();
const CONVERSATION_TITLE_CACHE_LIMIT = 5000;
const CONVERSATION_TITLE_CACHE_TTL_MS = 10 * 60_000;
// Gli id senza titolo vengono cachati in negativo: senza, ogni refresh
// riscansionerebbe state.vscdb per gli stessi id. TTL più corto perché un
// titolo può apparire in ritardo (prime battute della conversazione).
const CONVERSATION_TITLE_NEGATIVE_TTL_MS = 60_000;
let conversationPreviewEnabled = false;
let storedEventCount = 0;
let grokBotStoredEventCount = 0;
let pricingCatalogStore: PricingCatalogStore | null = null;
let refreshBusyDepth = 0;

const DEBOUNCE_MS = 30_000;

export type UpdateUsageOptions = {
  force?: boolean;
  /** Full retained-window / 100-page event store sync (background; skips usage API refetch). */
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
  configureDbWorker({
    storageDir: context.globalStorageUri.fsPath,
    extensionPath: context.extensionPath,
  });
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
  if (!state.focused) return;
  syncStatusBarRefreshIcon();
  DashboardPanel.currentPanel?.replayRefreshLoading();
  if (Date.now() - usageState.lastFetchTime >= getCooldownMs()) {
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

async function ensureEventStore(): Promise<UsageEventStoreApi> {
  if (!eventStore) {
    eventStore = usageEventStoreApi();
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
  const ids = [...new Set(events.map((event) => event.conversationId).filter((id): id is string => Boolean(id)))];
  const now = Date.now();
  const titleEntryFresh = (entry: { title: string | null; at: number } | undefined) =>
    entry !== undefined &&
    now - entry.at < (entry.title === null ? CONVERSATION_TITLE_NEGATIVE_TTL_MS : CONVERSATION_TITLE_CACHE_TTL_MS);
  const missing: string[] = [];
  const expiredEntries = new Map<string, { title: string | null; at: number }>();
  for (const id of ids) {
    const entry = conversationTitleCache.get(id);
    if (titleEntryFresh(entry)) continue;
    if (entry) expiredEntries.set(id, entry);
    missing.push(id);
  }
  if (missing.length > 0) {
    // La lookup avviene via RPC sul db worker e puo' rifiutare: un fallimento
    // non deve far fallire l'intero refresh ne azzerare i titoli gia' noti —
    // in quel caso si conserva la entry scaduta e si riprova al prossimo TTL.
    let fetched: Record<string, string> | null = null;
    try {
      fetched = await buildConversationTitleMap(missing, extensionContext.extensionPath);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`Conversation title lookup failed: ${detail}`);
    }
    for (const id of missing) {
      if (conversationTitleCache.size >= CONVERSATION_TITLE_CACHE_LIMIT) {
        const oldest = conversationTitleCache.keys().next().value;
        if (oldest !== undefined) conversationTitleCache.delete(oldest);
      }
      // delete + set sposta la entry in coda: l'eviction FIFO non butta via
      // una entry appena rinfrescata per colpa della sua posizione originale.
      conversationTitleCache.delete(id);
      conversationTitleCache.set(
        id,
        fetched !== null
          ? { title: fetched[id] ?? null, at: now }
          : { title: expiredEntries.get(id)?.title ?? null, at: now },
      );
    }
  }
  const titles: Record<string, string> = {};
  for (const id of ids) {
    const entry = conversationTitleCache.get(id);
    if (entry?.title && titleEntryFresh(entry)) titles[id] = entry.title;
  }
  conversationTitles = titles;
  return Object.keys(titles).length;
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

async function loadStoredEvents(sinceMs: number): Promise<UsageEvent[]> {
  const store = await ensureEventStore();
  const [eventCount, grokBotCount] = await Promise.all([
    store.getEventCount(),
    store.getGrokBotEventCount(),
  ]);
  storedEventCount = eventCount;
  grokBotStoredEventCount = grokBotCount;
  return store.getEventsSince(sinceMs);
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
    eventsComplete: usageState.lastEventsComplete,
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
      try {
        DashboardPanel.currentPanel?.postState(getDashboardState());
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`Dashboard state update failed: ${detail}`);
      }
    },
    globalState: () => extensionContext.globalState,
  };
}

function setRefreshButtonBusy(on: boolean): void {
  const panel = DashboardPanel.currentPanel;
  if (!panel || typeof panel.postLoading !== "function") return;
  try {
    panel.postLoading(on);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`Dashboard loading update failed: ${detail}`);
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

function syncStatusBarRefreshIcon(): void {
  if (refreshBusyDepth > 0) {
    applyStatusBarRefreshingVisual();
    return;
  }
  if (usageState.lastData) {
    setStatusBarLeadingIcon("$(pulse)");
  }
}

function endRefreshBusy(): void {
  refreshBusyDepth = Math.max(0, refreshBusyDepth - 1);
  if (refreshBusyDepth === 0) {
    syncStatusBarRefreshIcon();
    setRefreshButtonBusy(false);
  }
}

export function isUsageRefreshBusy(): boolean {
  return refreshBusyDepth > 0;
}

export async function updateUsage(opts?: UpdateUsageOptions): Promise<void> {
  // The archive sync keeps its own "syncing history" line. It must not hold the refresh spinner.
  const quiet = opts?.fullEventSync === true;
  if (!quiet) beginRefreshBusy();
  let startHistorySync = false;
  try {
    startHistorySync = await runUpdateUsageCycle(opts);
  } finally {
    if (!quiet) endRefreshBusy();
  }
  if (startHistorySync) {
    requestBackgroundEventHistorySync(() => updateUsage({ fullEventSync: true }));
  }
}

async function runUpdateUsageCycle(opts?: UpdateUsageOptions): Promise<boolean> {
  const force = opts?.force ?? false;
  const fullEventSync = opts?.fullEventSync ?? false;
  if (fetchPromise) {
    if (!force && !fullEventSync) {
      queuedNonForce = true;
      return false;
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
    return false;
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
    return false;
  }
  if (queuedNonForce) {
    queuedNonForce = false;
    await updateUsage();
    return false;
  }
  if ((force || usageState.quickFetchTruncated) && !fullEventSync) {
    usageState.quickFetchTruncated = false;
    return true;
  }
  return false;
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

// The mapped event array is rebuilt only when the stored events change, so
// fingerprints and the dashboard aggregates in buildDashboardState are
// computed once per refresh instead of once per state publish.
let cachedEventsSource: UsageEvent[] | null = null;
let cachedAllEvents: UsageEvent[] = [];

function getAllEventsWithKeys(): UsageEvent[] {
  const source = usageState.lastEvents;
  if (source === cachedEventsSource) return cachedAllEvents;
  cachedEventsSource = source;
  cachedAllEvents = (source ?? []).map((event) => {
    const normalized = normalizeUsageEventRequests(event);
    return { ...normalized, eventKey: usageEventFingerprint(normalized) };
  });
  return cachedAllEvents;
}

export function getDashboardState(): DashboardState {
  const now = Date.now();
  const allEvents = getAllEventsWithKeys();
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

export function cleanupExtensionRefresh(): Promise<void> {
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
  conversationTitleCache.clear();
  usageState.lastWarnings = [];
  usageState.lastEventsComplete = true;
  usageState.lastData = null;
  usageState.lastEvents = null;
  cachedEventsSource = null;
  cachedAllEvents = [];
  usageState.lastError = null;
  usageState.lastErrorDetail = null;
  const store = eventStore;
  eventStore = null;
  // close() flusha le scritture pendenti nel worker prima della terminazione:
  // la promise torna al chiamante così deactivate può attenderla.
  return (store ? store.close() : Promise.resolve()).finally(() => {
    shutdownDbWorker();
  });
}

export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}
