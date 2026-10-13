import {
  applyMainTab,
  applySectionState,
  local,
  persistGlobalUi,
  persistLocal,
  refs,
  resetEventsPage,
  resetGrokEventsPage,
  setState,
  ui,
  vscode,
} from "./core.js";
import {
  applyActivityTab,
  bindConversationHandlers,
  closeConversationDetail,
  getSortedConversations,
  renderConversationsTable,
  showConversationDetail,
  updateArchiveNote,
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
  findVisibleEvent,
  renderBreakdown,
  renderGrokBotTable,
  renderTable,
  showError,
  showWarnings,
  showEventDetail,
} from "./tables.js";
import { applyStaticTranslations, t } from "./i18n.js";
import { bindPricingHandlers, renderPricing } from "./pricing.js";
import { bindDashboardInteractions } from "./dashboard-interactions.js";

const NO_CONVERSATION_KEY = "__none__";

function syncActivityDetail() {
  if (!ui.eventDetailOverlay || ui.eventDetailOverlay.classList.contains("hidden")) return;
  if (refs.selectedEventKey) {
    const event = findVisibleEvent(refs.selectedEventKey);
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
  renderGrokBotTable();
  renderConversationsTable();
  updateArchiveNote();
  applyActivityTab();
  showError(refs.state.error, refs.state.errorDetail);
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
  resetGrokEventsPage();
  persistLocal();
  persistGlobalUi({ range: local.range });
  syncDashboardPrefs();
  vscode.postMessage({ type: "syncRangeToSettings", range: local.range });
  setActiveRangeButton();
  renderSummaryCards();
  renderPricing();
  renderTable();
  renderGrokBotTable();
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

bindDashboardInteractions({
  applyChartRangeChange,
  applyBreakdownRangeChange,
  renderAll,
  closeActivityDetail,
  applyUiPreferences,
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

