import { local, PALETTE, refs, updateChart, ui } from "./core.js";
import { t, getDateLocale } from "./i18n.js";
import {
  escapeHtml,
  formatBillableSpendCents,
  formatDollars,
  formatModelLabel,
  formatPercent,
  formatRangePeriod,
  formatRequests,
  formatTokens,
  metricLabel,
  formatChartMetricValue,
  rangeNow,
} from "./format.js";
import {
  buildPoolSpendIndex,
  computeModelPoolMetricsForDay,
} from "../../../src/model-pool-share.ts";
import { getBillingCycleCutoff } from "../../../src/cursor-api-utils.ts";
import { aggregateChartSeries } from "../../../src/dashboard-state.ts";

let modelColorMap = new Map();

function buildChartSeries() {
  const events = Array.isArray(refs.state?.events) ? refs.state.events : [];
  const locale = getDateLocale();
  return aggregateChartSeries(
    events,
    Array.isArray(refs.state?.dailySpend) ? refs.state.dailySpend : [],
    local.range,
    refs.state?.resetsAt ?? null,
    local.metric,
    local.usageFilter,
    rangeNow(),
    refs.state?.quotaAwareEventDisplay !== false,
    locale,
  );
}

function rebuildModelColorMap(series) {
  modelColorMap = new Map();
  series.datasets.forEach((d, i) => {
    modelColorMap.set(d.model, PALETTE[i % PALETTE.length]);
  });
}

export function colorForModel(model) {
  return modelColorMap.get(model) || "rgba(255,255,255,0.4)";
}

export function tintColor(color, alpha) {
  if (!color) return "rgba(255,255,255," + alpha + ")";
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full = hex.length === 3
      ? hex.split("").map((c) => c + c).join("")
      : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }
  if (color.startsWith("rgb(")) {
    return color.replace("rgb(", "rgba(").replace(")", "," + alpha + ")");
  }
  if (color.startsWith("rgba(")) {
    return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, "rgba($1,$2,$3," + alpha + ")");
  }
  return color;
}

function getOrCreateTooltipEl() {
  let el = document.getElementById("chart-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "chart-tooltip";
    el.className = "chart-tooltip";
    document.body.appendChild(el);
  }
  return el;
}

function getPoolDailyForDay(dayMs) {
  const pool = refs.state?.poolUsageSeries;
  if (!pool || !refs.state?.data?.poolUsage) return null;
  const idx = pool.dayMs.indexOf(dayMs);
  if (idx === -1) return null;
  return {
    auto: pool.dailyAutoPercent[idx] || 0,
    api: pool.dailyApiPercent[idx] || 0,
    dayIndex: idx,
  };
}

function formatPoolShareCell(metrics) {
  if (!metrics) return t("poolMetricsUnavailable");
  const abbr = metrics.pool === "firstParty" ? t("poolShareFp") : t("poolShareApi");
  return formatPercent(metrics.poolSharePercent) + "% · " + abbr;
}

function formatQuotaCell(metrics) {
  if (!metrics) return t("poolMetricsUnavailable");
  return formatPercent(metrics.quotaPointsPercent) + "%";
}

function formatTooltipMetricValue(value) {
  if (local.metric === "spend") return formatDollars(value);
  if (local.metric === "requests") return formatRequests(value);
  return formatTokens(value);
}

function renderExternalTooltip(context, opts) {
  const { chart, tooltip } = context;
  const el = getOrCreateTooltipEl();
  if (tooltip.opacity === 0) {
    el.style.opacity = "0";
    return;
  }

  const dataPoints = (tooltip.dataPoints || [])
    .filter((dp) => (dp.parsed.y || 0) > 0)
    .sort((a, b) => (b.parsed.y || 0) - (a.parsed.y || 0));

  const title = (tooltip.title && tooltip.title[0]) || "";
  const dataIndex = tooltip.dataPoints?.[0]?.dataIndex;
  const chartDayMs = Number.isInteger(dataIndex) ? opts.dayMs?.[dataIndex] : undefined;
  const poolDaily = chartDayMs !== undefined ? getPoolDailyForDay(chartDayMs) : null;
  const metricLabelText = metricLabel(local.metric);
  const showPoolCols = !!opts.poolSpendIndex && local.usageFilter !== "ondemand";

  let totalMetric = 0;
  let totalSpendCents = 0;

  const rows = dataPoints.map((dp) => {
    const ds = dp.dataset;
    const v = dp.parsed.y || 0;
    totalMetric += v;
    const spend = ds.spendByDay ? (ds.spendByDay[dp.dataIndex] || 0) : 0;
    totalSpendCents += Math.round(spend * 100);
    const color = ds.backgroundColor || colorForModel(ds.modelId || ds.label);
    let poolCells = "";
    if (showPoolCols) {
      const metrics =
        poolDaily && ds.modelId
          ? computeModelPoolMetricsForDay(
              ds.modelId,
              poolDaily.dayIndex,
              opts.poolSpendIndex,
              opts.dailyAutoPercent || [],
              opts.dailyApiPercent || [],
            )
          : null;
      poolCells =
        '<td class="num">' + escapeHtml(formatPoolShareCell(metrics)) + "</td>" +
        '<td class="num">' + escapeHtml(formatQuotaCell(metrics)) + "</td>";
    }
    return (
      '<tr>' +
        '<td><span class="t-dot" style="background:' + color + '"></span>' + escapeHtml(ds.label) + '</td>' +
        '<td class="num">' + formatTooltipMetricValue(v) + '</td>' +
        '<td class="num">' + formatBillableSpendCents(Math.round(spend * 100)) + '</td>' +
        poolCells +
      '</tr>'
    );
  }).join("");

  const totalRow =
    local.metric === "tokens" && dataPoints.length > 0
      ? '<tr class="t-total-row">' +
          "<td>" + escapeHtml(t("total")) + "</td>" +
          '<td class="num">' + formatTokens(totalMetric) + "</td>" +
          '<td class="num">' + formatBillableSpendCents(totalSpendCents) + "</td>" +
          (showPoolCols ? '<td class="num muted">—</td><td class="num muted">—</td>' : "") +
        "</tr>"
      : "";

  const headerCols =
    '<th>' + escapeHtml(t("colModel")) + '</th>' +
    '<th class="num">' + escapeHtml(metricLabelText) + '</th>' +
    '<th class="num">' + escapeHtml(t("colSpend")) + '</th>' +
    (showPoolCols
      ? '<th class="num">' + escapeHtml(t("colPoolShare")) + '</th>' +
        '<th class="num">' + escapeHtml(t("colPoolQuota")) + '</th>'
      : "");

  const poolSection = poolDaily
    ? '<div class="t-subtitle">' + escapeHtml(t("poolUsageDay")) + "</div>" +
      '<table class="t-table"><tbody>' +
        '<tr><td>' + escapeHtml(t("poolFirstParty")) + '</td><td class="num">' + formatPercent(poolDaily.auto) + "%</td></tr>" +
        '<tr><td>' + escapeHtml(t("poolApi")) + '</td><td class="num">' + formatPercent(poolDaily.api) + "%</td></tr>" +
      "</tbody></table>"
    : "";

  el.innerHTML =
    '<div class="t-title">' + escapeHtml(title) + "</div>" +
    '<table class="t-table"><thead><tr>' + headerCols + '</tr></thead><tbody>' + rows + totalRow + '</tbody></table>' +
    poolSection;

  const canvasRect = chart.canvas.getBoundingClientRect();
  const tooltipWidth = el.offsetWidth;
  const tooltipHeight = el.offsetHeight;
  const padding = 12;

  let left = canvasRect.left + window.scrollX + tooltip.caretX + padding;
  let top = canvasRect.top + window.scrollY + tooltip.caretY - tooltipHeight / 2;

  if (left + tooltipWidth > canvasRect.right + window.scrollX) {
    left = canvasRect.left + window.scrollX + tooltip.caretX - tooltipWidth - padding;
  }
  const minTop = canvasRect.top + window.scrollY + 4;
  const maxTop = canvasRect.bottom + window.scrollY - tooltipHeight - 4;
  if (top < minTop) top = minTop;
  if (top > maxTop) top = maxTop;

  el.style.left = left + "px";
  el.style.top = top + "px";
  el.style.opacity = "1";
}

function buildChartOptions(series, poolSpendIndex, dailyAutoPercent, dailyApiPercent) {
  const styles = getComputedStyle(document.body);
  const muted = styles.getPropertyValue("--muted").trim() || "rgba(255,255,255,0.55)";
  const grid = styles.getPropertyValue("--border").trim() || "rgba(255,255,255,0.06)";
  const yLabel = metricLabel(local.metric);

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 8, right: 4, bottom: 0, left: 0 } },
    plugins: {
      legend: {
        position: "bottom",
        align: "center",
        labels: {
          color: muted,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
          pointStyle: "circle",
          font: { size: 11 },
          padding: 12,
        },
      },
      tooltip: {
        enabled: false,
        external: (context) =>
          renderExternalTooltip(context, {
            dayMs: series.dayMs,
            poolSpendIndex,
            dailyAutoPercent,
            dailyApiPercent,
          }),
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
        grid: { display: false, drawBorder: false },
        border: { display: false },
      },
      y: {
        stacked: true,
        beginAtZero: true,
        ticks: {
          color: muted,
          font: { size: 10 },
          callback: (v) => (Number.isFinite(v) ? formatChartMetricValue(v, local.metric) : ""),
        },
        grid: { color: grid, drawBorder: false, drawTicks: false },
        border: { display: false },
        title: { display: false, text: yLabel },
      },
    },
  };
}

function buildChartData(series) {
  return {
    labels: series.labels,
    datasets: series.datasets.map((d, i) => ({
      label: formatModelLabel(d.model),
      modelId: d.model,
      data: d.data,
      spendByDay: d.spendByDay,
      backgroundColor: PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 0,
      categoryPercentage: 0.7,
      barPercentage: 0.85,
    })),
  };
}

export function renderChart() {
  if (!ui.canvas || !refs.state) return;

  let series;
  try {
    series = buildChartSeries();
  } catch (err) {
    updateChart(null);
    if (ui.chartNote) {
      ui.chartNote.textContent = String(err instanceof Error ? err.message : err);
    }
    return;
  }
  rebuildModelColorMap(series);

  if (ui.chartRangeLabel) {
    ui.chartRangeLabel.textContent = formatRangePeriod(
      local.range,
      refs.state.resetsAt,
      rangeNow(),
    );
  }

  const poolSeries = refs.state.poolUsageSeries;
  const poolUsage = refs.state.data?.poolUsage;
  let poolSpendIndex = null;
  let dailyAutoPercent = [];
  let dailyApiPercent = [];
  if (poolSeries?.dayMs?.length && poolUsage) {
    const now = rangeNow();
    const cycleStart = getBillingCycleCutoff(refs.state.resetsAt, now);
    poolSpendIndex = buildPoolSpendIndex(
      Array.isArray(refs.state.events) ? refs.state.events : [],
      poolSeries.dayMs,
      cycleStart,
    );
    dailyAutoPercent = poolSeries.dailyAutoPercent || [];
    dailyApiPercent = poolSeries.dailyApiPercent || [];
  }

  const chartData = buildChartData(series);
  const opts = buildChartOptions(series, poolSpendIndex, dailyAutoPercent, dailyApiPercent);

  if (refs.chart) {
    refs.chart.data = chartData;
    refs.chart.options = opts;
    refs.chart.update("none");
    requestAnimationFrame(() => refs.chart?.resize());
  } else {
    updateChart(new Chart(ui.canvas.getContext("2d"), { type: "bar", data: chartData, options: opts }));
    requestAnimationFrame(() => refs.chart?.resize());
  }

  if (ui.chartNote) ui.chartNote.textContent = "";
}
