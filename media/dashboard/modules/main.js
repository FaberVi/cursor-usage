import {
  applyMainTab,
  applySectionState,
  EVENTS_PAGE_SIZES,
  local,
  paginateList,
  persistGlobalUi,
  persistLocal,
  refs,
  resetConversationsPage,
  resetEventsPage,
  setState,
  switchMainTab,
  ui,
  vscode,
} from "./core.js";
import {
  applyActivityTab,
  applyConversationMessages,
  bindConversationHandlers,
  closeConversationDetail,
  getSortedConversations,
  renderConversationsTable,
  showConversationDetail,
  updateArchiveNote,
  updatePreviewLoading,
  updatePreviewStatus,
  syncDashboardPrefs,
} from "./conversations.js";
import { renderChart } from "./chart.js";
import { renderPoolChart } from "./pool-chart.js";
import { setActiveRangeButton, formatUpdatedAt } from "./format.js";
import { renderSummaryCards } from "./summary.js";
import { updateDailyBudgetResetCountdown } from "./summary-pool.js";
import {
  applyTeamMemberConstraints,
  closeEventDetail,
  exportCsv,
  findEventByKey,
  getSortedEvents,
  renderBreakdown,
  renderTable,
  showError,
  showWarnings,
  showEventDetail,
} from "./tables.js";
import { applyStaticTranslations, t } from "./i18n.js";
import { bindPricingHandlers, navigateToModelPricing, renderPricing } from "./pricing.js";

const NO_CONVERSATION_KEY = "__none__";

function syncActivityDetail() {
  if (!ui.eventDetailOverlay || ui.eventDetailOverlay.classList.contains("hidden")) return;
  if (refs.selectedEventKey) {
    const event = findEventByKey(getSortedEvents(), refs.selectedEventKey);
    if (event) {
      showEventDetail(event);
      return;
    }
  }
  if (refs.selectedConversationId != null) {
    const row = getSortedConversations().find(
      (r) => (r.conversationId ?? NO_CONVERSATION_KEY) === refs.selectedConversationId,
    );
    if (row) {
      showConversationDetail(row);
      return;
    }
  }
  closeActivityDetail();
}

function closeActivityDetail() {
  closeEventDetail();
  closeConversationDetail();
}

function applyUiPreferences(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  let changed = false;
  if (prefs.range && prefs.range !== local.range) {
    local.range = prefs.range;
    changed = true;
  }
  if (prefs.breakdownRange && prefs.breakdownRange !== local.breakdownRange) {
    local.breakdownRange = prefs.breakdownRange;
    changed = true;
  }
  if (prefs.usageFilter && prefs.usageFilter !== local.usageFilter) {
    local.usageFilter = prefs.usageFilter;
    changed = true;
  }
  if (prefs.metric === "spend" || prefs.metric === "tokens" || prefs.metric === "requests") {
    if (prefs.metric !== local.metric) {
      local.metric = prefs.metric;
      changed = true;
    }
  }
  if (Array.isArray(prefs.pricingPinnedIds)) {
    const next = prefs.pricingPinnedIds.filter((id) => typeof id === "string" && id.length > 0);
    const prev = local.pricingPinnedIds.join("\0");
    const serialized = next.join("\0");
    if (prev !== serialized) {
      local.pricingPinnedIds = next;
      changed = true;
    }
  }
  if (!changed) return;
  persistLocal();
  if (refs.state) renderAll();
}

function rerenderCharts() {
  renderChart();
  renderPoolChart();
  if (local.mainTab === "usage") {
    requestAnimationFrame(() => refs.chart?.resize());
  }
}

function renderAll() {
  if (!refs.state) return;
  if (ui.currencySelect) {
    local.currency = ui.currencySelect.value === "eur" ? "eur" : "usd";
    persistLocal();
  }
  applyStaticTranslations();
  syncActivityDetail();
  applySectionState();
  applyMainTab();
  setActiveRangeButton();
  if (ui.usageFilter) ui.usageFilter.value = local.usageFilter;
  if (ui.chartMetricFilter) ui.chartMetricFilter.value = local.metric;
  applyTeamMemberConstraints();
  renderSummaryCards();
  renderPricing();
  renderTable();
  renderConversationsTable();
  updateArchiveNote();
  applyActivityTab();
  showError(refs.state.error);
  showWarnings(refs.state.warnings);
  const updatedLabel = formatUpdatedAt(refs.state.generatedAt);
  ui.lastUpdated.textContent = refs.state.eventHistorySyncInProgress
    ? `${updatedLabel} \u00b7 ${t("eventHistorySyncing")}`
    : updatedLabel;
  rerenderCharts();
  renderBreakdown();
}

function isUsageDurationRange(nextRange) {
  return nextRange === "1d" || nextRange === "7d" || nextRange === "30d" || nextRange === "billingCycle";
}

function applyChartRangeChange(nextRange) {
  if (!isUsageDurationRange(nextRange)) return;
  if (nextRange === local.range) return;
  local.range = nextRange;
  resetEventsPage();
  persistLocal();
  persistGlobalUi({ range: local.range });
  syncDashboardPrefs();
  vscode.postMessage({ type: "syncRangeToSettings", range: local.range });
  setActiveRangeButton();
  renderSummaryCards();
  renderPricing();
  renderTable();
  renderConversationsTable();
  rerenderCharts();
}

function applyBreakdownRangeChange(nextRange) {
  if (!isUsageDurationRange(nextRange)) return;
  if (nextRange === local.breakdownRange) return;
  local.breakdownRange = nextRange;
  persistLocal();
  persistGlobalUi({ breakdownRange: local.breakdownRange });
  setActiveRangeButton();
  renderBreakdown();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-range-selector] button[data-range]");
  if (!btn) return;
  const selector = btn.closest("[data-range-selector]");
  const scope = selector?.dataset.rangeScope || "chart";
  const nextRange = btn.dataset.range;
  if (scope === "breakdown") {
    applyBreakdownRangeChange(nextRange);
  } else {
    applyChartRangeChange(nextRange);
  }
});

if (ui.chartMetricFilter) {
  ui.chartMetricFilter.addEventListener("change", () => {
    const next = ui.chartMetricFilter.value;
    if (next !== "spend" && next !== "tokens" && next !== "requests") return;
    if (next === local.metric) return;
    local.metric = next;
    persistLocal();
    persistGlobalUi({ metric: local.metric });
    renderChart();
  });
}

ui.usageFilter?.addEventListener("change", () => {
  const next = ui.usageFilter.value;
  if (next !== "all" && next !== "included" && next !== "ondemand") return;
  local.usageFilter = next;
  resetEventsPage();
  resetConversationsPage();
  persistLocal();
  persistGlobalUi({ usageFilter: local.usageFilter });
  syncDashboardPrefs();
  renderPricing();
  renderTable();
  renderConversationsTable();
  renderChart();
  renderBreakdown();
});

ui.tableHead.addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;
  if (local.sortKey === key) {
    local.sortOrder = local.sortOrder === "asc" ? "desc" : "asc";
  } else {
    local.sortKey = key;
    local.sortOrder = key === "model" || key === "kind" ? "asc" : "desc";
  }
  resetEventsPage();
  closeActivityDetail();
  persistLocal();
  renderTable();
});

ui.tableBody.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-event-key]");
  if (!row) return;
  const eventKey = row.dataset.eventKey;
  const event = findEventByKey(getSortedEvents(), eventKey);
  if (!event) return;
  showEventDetail(event);
});

if (ui.breakdownHead) {
  ui.breakdownHead.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.sort;
    if (local.breakdownSortKey === key) {
      local.breakdownSortOrder = local.breakdownSortOrder === "asc" ? "desc" : "asc";
    } else {
      local.breakdownSortKey = key;
      local.breakdownSortOrder = key === "model" ? "asc" : "desc";
    }
    persistLocal();
    renderBreakdown();
  });
}

if (ui.breakdownBody) {
  ui.breakdownBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pricing-model]");
    if (!btn) return;
    e.preventDefault();
    navigateToModelPricing(btn.dataset.pricingModel);
  });
}

ui.refreshBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

if (ui.langSelect) {
  ui.langSelect.addEventListener("change", () => {
    const next = ui.langSelect.value;
    if (next !== "en" && next !== "it") return;
    local.locale = next;
    persistLocal();
    vscode.postMessage({ type: "setLocale", locale: next });
    renderAll();
  });
}

if (ui.currencySelect) {
  ui.currencySelect.addEventListener("change", () => {
    const next = ui.currencySelect.value;
    if (next !== "usd" && next !== "eur") return;
    local.currency = next;
    persistLocal();
    vscode.postMessage({ type: "setCurrency", currency: next });
    applyStaticTranslations();
    renderAll();
  });
}

ui.exportBtn.addEventListener("click", exportCsv);

ui.pagination.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;
  const events = getSortedEvents();
  const current = paginateList(events, local.eventsPage, local.eventsPageSize);
  const action = btn.dataset.action;
  if (action === "first") local.eventsPage = 1;
  else if (action === "prev") local.eventsPage = Math.max(1, current.page - 1);
  else if (action === "next") local.eventsPage = Math.min(current.totalPages, current.page + 1);
  else if (action === "last") local.eventsPage = current.totalPages;
  else return;
  persistLocal();
  renderTable();
});

ui.pagination.addEventListener("change", (e) => {
  if (e.target.id !== "events-page-size") return;
  const nextSize = Number(e.target.value);
  if (!EVENTS_PAGE_SIZES.includes(nextSize) || nextSize === local.eventsPageSize) return;
  local.eventsPageSize = nextSize;
  resetEventsPage();
  persistLocal();
  renderTable();
});

document.querySelectorAll(".dashboard-tab[data-main-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.mainTab;
    if (!tab || tab === local.mainTab) return;
    switchMainTab(tab);
    rerenderCharts();
  });
});

if (ui.eventDetailClose) {
  ui.eventDetailClose.addEventListener("click", closeActivityDetail);
}
if (ui.eventDetailOverlay) {
  ui.eventDetailOverlay.addEventListener("click", (e) => {
    if (e.target === ui.eventDetailOverlay) closeActivityDetail();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.eventDetailOverlay && !ui.eventDetailOverlay.classList.contains("hidden")) {
    closeActivityDetail();
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "uiPreferences") {
    applyUiPreferences(msg.preferences);
  } else if (msg.type === "rangePreference" && typeof msg.range === "string") {
    if (msg.range !== "1d" && msg.range !== "7d" && msg.range !== "30d" && msg.range !== "billingCycle") return;
    local.range = msg.range;
    persistLocal();
    persistGlobalUi({ range: local.range });
    syncDashboardPrefs();
    if (refs.state) renderAll();
  } else if (msg.type === "init" && (msg.locale === "en" || msg.locale === "it")) {
    local.locale = msg.locale;
    persistLocal();
    applyStaticTranslations();
    if (refs.state) renderAll();
  } else if (msg.type === "initCurrency" && (msg.currency === "usd" || msg.currency === "eur")) {
    local.currency = msg.currency;
    persistLocal();
    applyStaticTranslations();
    if (refs.state) renderAll();
  } else if (msg.type === "initPreview" && typeof msg.enabled === "boolean") {
    local.conversationPreview = msg.enabled;
    applyActivityTab();
    if (refs.state && local.activityTab === "conversations") renderConversationsTable();
  } else if (msg.type === "previewLoading") {
    updatePreviewLoading(!!msg.on);
  } else if (msg.type === "previewStatus") {
    updatePreviewLoading(false);
    updatePreviewStatus(msg);
    if (refs.state && local.activityTab === "conversations") renderConversationsTable();
  } else if (msg.type === "conversationMessages" && typeof msg.conversationId === "string") {
    applyConversationMessages(msg.conversationId, msg.messages, msg.error);
  } else if (msg.type === "state") {
    if (msg.locale === "en" || msg.locale === "it") {
      local.locale = msg.locale;
      if (ui.langSelect) ui.langSelect.value = msg.locale;
    }
    if (msg.currency === "usd" || msg.currency === "eur") {
      local.currency = msg.currency;
      if (ui.currencySelect) ui.currencySelect.value = msg.currency;
    }
    persistLocal();
    setState(msg.state);
    renderAll();
  } else if (msg.type === "loading") {
    ui.refreshBtn.disabled = !!msg.on;
    ui.refreshBtn.textContent = msg.on ? t("refreshing") : t("refresh");
  } else if (msg.type === "pricingSyncLoading") {
    if (ui.pricingRefreshBtn) {
      ui.pricingRefreshBtn.disabled = !!msg.on;
      ui.pricingRefreshBtn.textContent = msg.on ? t("pricingRefreshing") : t("pricingRefreshFromCursor");
    }
  } else if (msg.type === "pricingSyncStatus") {
    if (!ui.pricingSyncStatus) return;
    if (msg.ok) {
      ui.pricingSyncStatus.textContent = t("pricingSyncSuccess")
        .replace("{updated}", String(msg.updated ?? 0))
        .replace("{added}", String(msg.added ?? 0));
      ui.pricingSyncStatus.classList.remove("pricing-sync-error");
    } else {
      ui.pricingSyncStatus.textContent = t("pricingSyncFailed").replace("{error}", msg.error || "unknown");
      ui.pricingSyncStatus.classList.add("pricing-sync-error");
    }
  }
});

applyStaticTranslations();
applySectionState();
applyMainTab();
bindPricingHandlers();
applyActivityTab();
bindConversationHandlers(vscode);
vscode.postMessage({ type: "ready" });
syncDashboardPrefs();

const dailyBudgetResetTimer = setInterval(() => {
  if (refs.state?.data?.poolUsage) {
    updateDailyBudgetResetCountdown();
  }
}, 60_000);

window.addEventListener("beforeunload", () => {
  clearInterval(dailyBudgetResetTimer);
});
