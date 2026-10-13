import { local, refs, ui } from "./core.js";
import { colorForModel, tintColor } from "./chart.js";
import {
  escapeHtml,
  formatBillableSpendCents,
  formatCents,
  formatModelLabel,
  formatPercent,
  formatRangePeriod,
  formatRequests,
  formatTokens,
  getDurationCutoff,
  breakdownRangeLabel,
  rangeNow,
  startOfUtcDay,
} from "./format.js";
import { t } from "./i18n.js";
import { isGrokBotModelId } from "./tables-events.js";
import { estimateEventTheoreticalCost, eventReportedUsageCostCents, resolveModelPricing } from "../../../src/model-pricing.ts";
import { getEstimateOpts } from "./pricing-shared.js";
import {
  buildPoolSpendIndex,
  computeModelPoolMetricsForRange,
  dayIndicesInRange,
} from "../../../src/model-pool-share.ts";
import { getBillingCycleCutoff } from "../../../src/cursor-api-utils.ts";
import {
  aggregateModelBreakdownTotals,
  filterEventsForChartRange,
} from "../../../src/dashboard-state.ts";

function formatPoolShareCell(metrics) {
  if (!metrics) return t("poolMetricsUnavailable");
  const poolName = metrics.pool === "firstParty" ? t("pricingPoolFirstParty") : t("pricingPoolApi");
  return formatPercent(metrics.poolSharePercent) + "% · " + poolName;
}

function formatQuotaCell(metrics) {
  if (!metrics) return t("poolMetricsUnavailable");
  return formatPercent(metrics.quotaPointsPercent) + " " + t("breakdownQuotaPts");
}

function aggregateModelBreakdown() {
  if (!refs.state) return { rows: [], eventCount: 0 };

  const now = rangeNow();
  const allEvents = Array.isArray(refs.state.events) ? refs.state.events : [];
  const dailySpend = Array.isArray(refs.state.dailySpend) ? refs.state.dailySpend : [];
  const quotaAware = refs.state.quotaAwareEventDisplay !== false;
  const resetAt = refs.state.resetsAt ?? null;

  const filteredEvents = filterEventsForChartRange(
    allEvents,
    local.breakdownRange,
    resetAt,
    local.usageFilter,
    now,
  );

  const totals = aggregateModelBreakdownTotals(
    allEvents,
    dailySpend,
    local.breakdownRange,
    resetAt,
    local.usageFilter,
    now,
    quotaAware,
  );

  const estimateOpts = getEstimateOpts();
  const costByModel = new Map();

  for (const event of filteredEvents) {
    costByModel.set(event.model, costByModel.get(event.model) || {
      reportedCostCents: 0,
      theoreticalCents: 0,
    });
    const bucket = costByModel.get(event.model);
    bucket.reportedCostCents += eventReportedUsageCostCents(event);
    const pricing = resolveModelPricing(event.model);
    if (pricing) {
      bucket.theoreticalCents += estimateEventTheoreticalCost(event, pricing, estimateOpts).totalCents;
    }
  }

  const map = new Map();
  for (const row of totals) {
    const costs = costByModel.get(row.model) || { reportedCostCents: 0, theoreticalCents: 0 };
    map.set(row.model, {
      model: row.model,
      requests: row.requests,
      totalTokens: row.totalTokens,
      spendCents: Math.round(row.spendDollars * 100),
      reportedCostCents: costs.reportedCostCents,
      theoreticalCents: costs.theoreticalCents,
      poolSharePercent: null,
      quotaPointsPercent: null,
      pool: null,
    });
  }

  const poolSeries = refs.state.poolUsageSeries;
  const canShowPool =
    local.usageFilter !== "ondemand" &&
    poolSeries?.dayMs?.length &&
    refs.state.data?.poolUsage;

  if (canShowPool) {
    const cycleStart = getBillingCycleCutoff(resetAt, now);
    const cutoff = getDurationCutoff(local.breakdownRange, resetAt, now);
    const endDay = startOfUtcDay(now);
    const indices = dayIndicesInRange(poolSeries.dayMs, startOfUtcDay(cutoff), endDay);
    const poolEvents = filterEventsForChartRange(allEvents, local.breakdownRange, resetAt, "all", now);
    const spendIndex = buildPoolSpendIndex(poolEvents, poolSeries.dayMs, cycleStart);
    for (const entry of map.values()) {
      const metrics = computeModelPoolMetricsForRange(
        entry.model,
        indices,
        spendIndex,
        poolSeries.dailyAutoPercent || [],
        poolSeries.dailyApiPercent || [],
      );
      if (metrics) {
        entry.pool = metrics.pool;
        entry.poolSharePercent = metrics.poolSharePercent;
        entry.quotaPointsPercent = metrics.quotaPointsPercent;
      }
    }
  }

  const rows = Array.from(map.values());
  const dir = local.breakdownSortOrder === "asc" ? 1 : -1;
  const key = local.breakdownSortKey;
  rows.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return String(a.model).localeCompare(String(b.model));
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  return { rows, eventCount: filteredEvents.length };
}

function syncBreakdownGrokBotToggle() {
  if (!ui.breakdownGrokBotToggle) return;
  const show = local.breakdownShowGrokBot !== false;
  ui.breakdownGrokBotToggle.setAttribute("aria-pressed", show ? "true" : "false");
  ui.breakdownGrokBotToggle.title = t("breakdownGrokBotToggleHelp");
}

export function renderBreakdown() {
  if (!ui.breakdownBody) return;

  const period = formatRangePeriod(local.breakdownRange, refs.state?.resetsAt ?? null);
  const { rows: allRows, eventCount } = aggregateModelBreakdown();
  const rows =
    local.breakdownShowGrokBot === false
      ? allRows.filter((r) => !isGrokBotModelId(r.model))
      : allRows;
  syncBreakdownGrokBotToggle();

  if (ui.breakdownRangeLabel) {
    let label = "(" + breakdownRangeLabel() + " · " + period + " · " +
      t(eventCount === 1 ? "breakdownEventOne" : "breakdownEventMany").replace("{count}", String(eventCount)) + ")";
    if (local.usageFilter !== "all") {
      label += " · " + t("breakdownTokensFromEvents");
    }
    ui.breakdownRangeLabel.textContent = label;
  }

  const showPoolCols =
    local.usageFilter !== "ondemand" &&
    !!refs.state?.poolUsageSeries?.dayMs?.length &&
    !!refs.state?.data?.poolUsage;
  const colCount = showPoolCols ? 7 : 5;

  if (ui.breakdownHead) {
    ui.breakdownHead.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === local.breakdownSortKey) {
        th.classList.add(local.breakdownSortOrder === "asc" ? "sorted-asc" : "sorted-desc");
      }
      if (th.dataset.sort === "poolSharePercent") {
        th.classList.toggle("hidden", !showPoolCols);
        th.title = t("breakdownPoolShareHelp");
      }
      if (th.dataset.sort === "quotaPointsPercent") {
        th.classList.toggle("hidden", !showPoolCols);
        th.title = t("breakdownPoolQuotaHelp");
      }
    });
  }

  if (rows.length === 0) {
    ui.breakdownBody.innerHTML =
      '<tr><td colspan="' + colCount + '" style="text-align:center; padding:24px;" class="muted">' +
      escapeHtml(t("noUsageInRange")) +
      "</td></tr>";
    if (ui.breakdownFoot) ui.breakdownFoot.innerHTML = "";
    if (ui.breakdownPoolNote) {
      ui.breakdownPoolNote.textContent = "";
      ui.breakdownPoolNote.classList.add("hidden");
    }
    return;
  }

  ui.breakdownBody.innerHTML = rows.map((r) => {
    const color = colorForModel(r.model);
    const rowStyle = 'background:' + tintColor(color, 0.10) + ';box-shadow:inset 3px 0 0 ' + color + ';';
    const metrics =
      r.poolSharePercent != null
        ? {
            pool: r.pool,
            poolSharePercent: r.poolSharePercent,
            quotaPointsPercent: r.quotaPointsPercent,
          }
        : null;
    const poolCells = showPoolCols
      ? '<td class="num" title="' + escapeHtml(t("breakdownPoolShareHelp")) + '">' +
          escapeHtml(formatPoolShareCell(metrics)) + "</td>" +
        '<td class="num" title="' + escapeHtml(t("breakdownPoolQuotaHelp")) + '">' +
          escapeHtml(formatQuotaCell(metrics)) + "</td>"
      : "";
    return '<tr style="' + rowStyle + '">' +
      '<td><button type="button" class="pricing-link-btn" data-pricing-model="' + escapeHtml(r.model) + '" title="' + escapeHtml(t("pricingViewRates")) + '">↗</button> ' + escapeHtml(formatModelLabel(r.model)) + '</td>' +
      '<td class="num">' + formatRequests(r.requests) + '</td>' +
      '<td class="num">' + formatTokens(r.totalTokens) + '</td>' +
      '<td class="num">' + formatBillableSpendCents(r.spendCents) + '</td>' +
      '<td class="num">' + formatCents(r.reportedCostCents) + '</td>' +
      poolCells +
    '</tr>';
  }).join("");

  const totals = rows.reduce(
    (acc, r) => {
      acc.requests += r.requests || 0;
      acc.totalTokens += r.totalTokens || 0;
      acc.spendCents += r.spendCents || 0;
      acc.reportedCostCents += r.reportedCostCents || 0;
      acc.theoreticalCents += r.theoreticalCents || 0;
      if (r.quotaPointsPercent != null) acc.quotaPointsPercent += r.quotaPointsPercent;
      return acc;
    },
    { requests: 0, totalTokens: 0, spendCents: 0, reportedCostCents: 0, theoreticalCents: 0, quotaPointsPercent: 0 },
  );

  if (ui.breakdownFoot) {
    const poolFoot = showPoolCols
      ? '<td class="num muted">—</td>' +
        '<td class="num">' + formatPercent(totals.quotaPointsPercent) + " " + escapeHtml(t("breakdownQuotaPts")) + "</td>"
      : "";
    ui.breakdownFoot.innerHTML =
      '<tr class="breakdown-total">' +
      '<td>' + escapeHtml(t("total")) + '</td>' +
      '<td class="num">' + formatRequests(totals.requests) + '</td>' +
      '<td class="num">' + formatTokens(totals.totalTokens) + '</td>' +
      '<td class="num">' + formatBillableSpendCents(totals.spendCents) + '</td>' +
      '<td class="num">' + formatCents(totals.reportedCostCents) + '</td>' +
      poolFoot +
      "</tr>";
  }

  if (ui.breakdownPoolNote) {
    if (showPoolCols) {
      ui.breakdownPoolNote.textContent = t("breakdownPoolNote");
      ui.breakdownPoolNote.classList.remove("hidden");
    } else {
      ui.breakdownPoolNote.textContent = "";
      ui.breakdownPoolNote.classList.add("hidden");
    }
  }
}
