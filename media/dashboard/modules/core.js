export const vscode = acquireVsCodeApi();
export const DAY_MS = 86_400_000;
export const EVENTS_PAGE_SIZES = [25, 50, 100, 200];
export const DEFAULT_EVENTS_PAGE_SIZE = 50;

export const MAIN_TABS = ["usage", "pools", "pricing", "activity"];

export const ui = {
  summaryCards: document.getElementById("summary-cards"),
  rangeSelector: document.getElementById("range-selector"),
  usageFilter: document.getElementById("usage-filter"),
  chartMetricFilter: document.getElementById("chart-metric-filter"),
  chartRangeLabel: document.getElementById("chart-range-label"),
  canvas: document.getElementById("usage-chart"),
  chartNote: document.getElementById("chart-note"),
  poolCanvas: document.getElementById("pool-chart"),
  poolPaceCanvas: document.getElementById("pool-pace-chart"),
  poolChartNote: document.getElementById("pool-chart-note"),
  tableBody: document.querySelector("#events-table tbody"),
  tableHead: document.querySelector("#events-table thead"),
  breakdownBody: document.querySelector("#breakdown-table tbody"),
  breakdownFoot: document.querySelector("#breakdown-table tfoot"),
  breakdownHead: document.querySelector("#breakdown-table thead"),
  breakdownRangeLabel: document.getElementById("breakdown-range-label"),
  breakdownGrokBotToggle: document.getElementById("breakdown-grok-bot-toggle"),
  breakdownPoolNote: document.getElementById("breakdown-pool-note"),
  pricingBody: document.querySelector("#pricing-table tbody"),
  pricingHead: document.querySelector("#pricing-table thead"),
  pricingRangeLabel: document.getElementById("pricing-range-label"),
  pricingUpdated: document.getElementById("pricing-updated"),
  pricingSyncBadge: document.getElementById("pricing-sync-badge"),
  pricingRefreshBtn: document.getElementById("pricing-refresh-btn"),
  pricingSyncStatus: document.getElementById("pricing-sync-status"),
  pricingRuntimeAlert: document.getElementById("pricing-runtime-alert"),
  pricingSource: document.getElementById("pricing-source"),
  pricingSearch: document.getElementById("pricing-search"),
  pricingProviderFilter: document.getElementById("pricing-provider-filter"),
  pricingPoolFilter: document.getElementById("pricing-pool-filter"),
  pricingUsedOnly: document.getElementById("pricing-used-only"),
  pagination: document.getElementById("pagination"),
  grokTableBody: document.querySelector("#grok-events-table tbody"),
  grokTableHead: document.querySelector("#grok-events-table thead"),
  grokPagination: document.getElementById("grok-pagination"),
  grokEventsPanel: document.getElementById("grok-events-panel"),
  conversationsBody: document.querySelector("#conversations-table tbody"),
  conversationsHead: document.querySelector("#conversations-table thead"),
  conversationsPagination: document.getElementById("conversations-pagination"),
  eventsPanel: document.getElementById("events-panel"),
  conversationsPanel: document.getElementById("conversations-panel"),
  activityTabs: document.querySelectorAll(".activity-tab"),
  activitySectionTitle: document.getElementById("activity-section-title"),
  activitySectionToggle: document.getElementById("activity-section-toggle"),
  conversationPreviewBtn: document.getElementById("conversation-preview-btn"),
  previewStatus: document.getElementById("preview-status"),
  archiveNote: document.getElementById("archive-note"),
  planBanner: document.getElementById("plan-banner"),
  refreshBtn: document.getElementById("refresh-btn"),
  langSelect: document.getElementById("lang-select"),
  currencySelect: document.getElementById("currency-select"),
  exportBtn: document.getElementById("export-csv"),
  lastUpdated: document.getElementById("last-updated"),
  errorBanner: document.getElementById("error-banner"),
  warningBanner: document.getElementById("warning-banner"),
  eventDetailOverlay: document.getElementById("event-detail-overlay"),
  eventDetailTitle: document.getElementById("event-detail-title"),
  eventDetailSubtitle: document.getElementById("event-detail-subtitle"),
  eventDetailBody: document.getElementById("event-detail-body"),
  eventDetailClose: document.getElementById("event-detail-close"),
  mainTabs: document.querySelectorAll(".dashboard-tab[data-main-tab]"),
  mainTabPanels: document.querySelectorAll(".dashboard-tab-panel"),
  mainTabPools: document.getElementById("main-tab-pools"),
};

const persisted = vscode.getState() || {};
const browserLocale = typeof navigator !== "undefined" && navigator.language?.startsWith("it") ? "it" : "en";
export const local = {
  locale: persisted.locale === "it" || persisted.locale === "en" ? persisted.locale : browserLocale,
  currency: persisted.currency === "eur" || persisted.currency === "usd" ? persisted.currency : "usd",
  range: persisted.range || "billingCycle",
  breakdownRange: persisted.breakdownRange || persisted.range || "billingCycle",
  usageFilter: persisted.usageFilter || "all",
  metric: persisted.metric === "spend" || persisted.metric === "requests" || persisted.metric === "tokens"
    ? persisted.metric
    : "tokens",
  sortKey: persisted.sortKey || "timestamp",
  sortOrder: persisted.sortOrder || "desc",
  breakdownSortKey: persisted.breakdownSortKey || "totalTokens",
  breakdownSortOrder: persisted.breakdownSortOrder || "desc",
  breakdownShowGrokBot: persisted.breakdownShowGrokBot !== false,
  mainTab: MAIN_TABS.includes(persisted.mainTab) ? persisted.mainTab : "usage",
  sectionOpen: {
    usage: persisted.sectionOpen?.usage !== false,
    pool: persisted.sectionOpen?.pool !== false,
    breakdown: persisted.sectionOpen?.breakdown !== false,
    pricing: persisted.sectionOpen?.pricing !== false,
    events: persisted.sectionOpen?.events !== false,
  },
  eventsPage: Math.max(1, persisted.eventsPage || 1),
  eventsPageSize: EVENTS_PAGE_SIZES.includes(persisted.eventsPageSize)
    ? persisted.eventsPageSize
    : DEFAULT_EVENTS_PAGE_SIZE,
  grokEventsPage: Math.max(1, persisted.grokEventsPage || 1),
  grokEventsPageSize: EVENTS_PAGE_SIZES.includes(persisted.grokEventsPageSize)
    ? persisted.grokEventsPageSize
    : DEFAULT_EVENTS_PAGE_SIZE,
  grokSortKey: persisted.grokSortKey || "timestamp",
  grokSortOrder: persisted.grokSortOrder || "desc",
  activityTab: persisted.activityTab === "conversations" || persisted.activityTab === "grokBot"
    ? persisted.activityTab
    : "events",
  conversationPreview: false,
  conversationsPage: Math.max(1, persisted.conversationsPage || 1),
  conversationsPageSize: EVENTS_PAGE_SIZES.includes(persisted.conversationsPageSize)
    ? persisted.conversationsPageSize
    : DEFAULT_EVENTS_PAGE_SIZE,
  conversationSortKey: persisted.conversationSortKey || "lastTimestamp",
  conversationSortOrder: persisted.conversationSortOrder || "desc",
  pricingSortKey: persisted.pricingSortKey || "displayName",
  pricingSortOrder: persisted.pricingSortOrder || "asc",
  pricingSearch: persisted.pricingSearch || "",
  pricingProvider: persisted.pricingProvider || "all",
  pricingPool: persisted.pricingPool || "all",
  pricingUsedOnly: persisted.pricingUsedOnly === true,
  pricingExpandedId: persisted.pricingExpandedId || null,
  pricingPinnedIds: Array.isArray(persisted.pricingPinnedIds)
    ? persisted.pricingPinnedIds.filter((id) => typeof id === "string")
    : [],
  highlightModelId: null,
};

export const refs = {
  state: null,
  chart: null,
  poolChart: null,
  poolPaceChart: null,
  selectedEventKey: null,
  selectedConversationId: null,
};

export function setState(next) {
  refs.state = next;
}

export function setChart(next) {
  if (refs.chart) {
    refs.chart.destroy();
  }
  refs.chart = next;
}

export function updateChart(next) {
  if (!next && refs.chart) {
    refs.chart.destroy();
    refs.chart = null;
    return;
  }
  refs.chart = next;
}

export function setPoolChart(next) {
  if (refs.poolChart) {
    refs.poolChart.destroy();
  }
  refs.poolChart = next;
}

export function setPoolPaceChart(next) {
  if (refs.poolPaceChart) {
    refs.poolPaceChart.destroy();
  }
  refs.poolPaceChart = next;
}

export function setSelectedEventKey(next) {
  refs.selectedEventKey = next;
}

export const TOKEN_COLORS = {
  input: "#9ec5fe",
  output: "#b6e3c1",
  cacheWrite: "#f7c5a0",
  cacheRead: "#d3b9f2",
};

export const PALETTE = [
  "#9ec5fe",
  "#b6e3c1",
  "#f7c5a0",
  "#d3b9f2",
  "#f5b8c5",
  "#a7e0e0",
  "#f0d99b",
  "#c9d4f0",
];

export function persistGlobalUi(patch) {
  vscode.postMessage({ type: "saveUiPreferences", preferences: patch });
}

export function persistLocal() {
  vscode.setState({
    locale: local.locale,
    currency: local.currency,
    range: local.range,
    breakdownRange: local.breakdownRange,
    usageFilter: local.usageFilter,
    metric: local.metric,
    sortKey: local.sortKey,
    sortOrder: local.sortOrder,
    breakdownSortKey: local.breakdownSortKey,
    breakdownSortOrder: local.breakdownSortOrder,
    breakdownShowGrokBot: local.breakdownShowGrokBot,
    mainTab: local.mainTab,
    sectionOpen: local.sectionOpen,
    eventsPage: local.eventsPage,
    eventsPageSize: local.eventsPageSize,
    grokEventsPage: local.grokEventsPage,
    grokEventsPageSize: local.grokEventsPageSize,
    grokSortKey: local.grokSortKey,
    grokSortOrder: local.grokSortOrder,
    activityTab: local.activityTab,
    conversationsPage: local.conversationsPage,
    conversationsPageSize: local.conversationsPageSize,
    conversationSortKey: local.conversationSortKey,
    conversationSortOrder: local.conversationSortOrder,
    pricingSortKey: local.pricingSortKey,
    pricingSortOrder: local.pricingSortOrder,
    pricingSearch: local.pricingSearch,
    pricingProvider: local.pricingProvider,
    pricingPool: local.pricingPool,
    pricingUsedOnly: local.pricingUsedOnly,
    pricingExpandedId: local.pricingExpandedId,
    pricingPinnedIds: local.pricingPinnedIds,
  });
}

export function resetEventsPage() {
  local.eventsPage = 1;
  persistLocal();
}

export function resetGrokEventsPage() {
  local.grokEventsPage = 1;
  persistLocal();
}

export function resetConversationsPage() {
  local.conversationsPage = 1;
  persistLocal();
}

export function paginateList(items, page, pageSize) {
  const safePageSize = Math.max(1, pageSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);
  return {
    items: items.slice(startIndex, endIndex),
    totalItems,
    totalPages,
    page: safePage,
    pageSize: safePageSize,
    startIndex,
    endIndex,
  };
}

function setSectionCollapsed(section, isOpen) {
  const bodyEl = document.getElementById("section-body-" + section);
  if (!bodyEl) return;
  bodyEl.classList.toggle("hidden", !isOpen);
}

export function applySectionState() {
  setSectionCollapsed("usage", true);
  setSectionCollapsed("pool", true);
  setSectionCollapsed("breakdown", true);
  setSectionCollapsed("pricing", true);
  setSectionCollapsed("events", true);
}

export function poolsTabAvailable() {
  return !!(refs.state?.poolUsageSeries && refs.state?.data?.poolUsage);
}

export function applyMainTab() {
  let tab = local.mainTab;
  if (!MAIN_TABS.includes(tab)) tab = "usage";

  const poolsAvailable = poolsTabAvailable();
  if (ui.mainTabPools) {
    ui.mainTabPools.classList.toggle("hidden", !poolsAvailable);
  }
  if (tab === "pools" && !poolsAvailable) {
    tab = "usage";
    local.mainTab = tab;
    persistLocal();
  }

  ui.mainTabs.forEach((btn) => {
    const isActive = btn.dataset.mainTab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  ui.mainTabPanels.forEach((panel) => {
    const isActive = panel.dataset.mainTabPanel === tab;
    panel.classList.toggle("hidden", !isActive);
  });

  return tab;
}

export function switchMainTab(tab) {
  if (!MAIN_TABS.includes(tab)) return local.mainTab;
  if (tab === "pools" && !poolsTabAvailable()) return local.mainTab;
  local.mainTab = tab;
  persistLocal();
  return applyMainTab();
}
