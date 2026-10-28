import { refs, setPoolChart, setPoolPaceChart, ui } from "./core.js";
import { t } from "./i18n.js";
import { escapeHtml, formatPercent } from "./format.js";

const AUTO_COLOR = "#9ec5fe";
const API_COLOR = "#b6e3c1";
const UNDER_COLOR = "rgba(182, 227, 193, 0.85)";
const OVER_COLOR = "rgba(248, 113, 113, 0.85)";

function getOrCreatePoolTooltipEl(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = "chart-tooltip";
    document.body.appendChild(el);
  }
  return el;
}

function positionTooltip(el, chart, tooltip) {
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

function formatPaceResidual(pace) {
  if (pace?.exhausted) return t("alreadyExhausted");
  const residual = pace?.residual || 0;
  if (Math.abs(residual) < 0.05) return t("onPaceShort");
  if (residual > 0) return formatPercent(residual) + "% " + t("left");
  return formatPercent(Math.abs(residual)) + "% " + t("over");
}

function renderPoolTooltip(context) {
  const { chart, tooltip } = context;
  const el = getOrCreatePoolTooltipEl("pool-chart-tooltip");
  if (tooltip.opacity === 0) {
    el.style.opacity = "0";
    return;
  }

  const idx = tooltip.dataPoints?.[0]?.dataIndex;
  const series = refs.state?.poolUsageSeries;
  if (idx === undefined || !series) {
    el.style.opacity = "0";
    return;
  }

  const title = (tooltip.title && tooltip.title[0]) || "";
  const autoPace = series.dailyAutoPace[idx];
  const apiPace = series.dailyApiPace[idx];

  el.innerHTML =
    '<div class="t-title">' + escapeHtml(title) + "</div>" +
    '<table class="t-table"><thead><tr>' +
      "<th>" + escapeHtml(t("poolTooltipPool")) + "</th><th class=\"num\">" + escapeHtml(t("poolTooltipUsed")) + "</th><th class=\"num\">" + escapeHtml(t("poolTooltipBudget")) + "</th><th class=\"num\">" + escapeHtml(t("poolTooltipBalance")) + "</th>" +
    "</tr></thead><tbody>" +
      '<tr><td><span class="t-dot" style="background:' + AUTO_COLOR + '"></span>' + escapeHtml(t("poolFirstParty")) + "</td>" +
        '<td class="num">' + formatPercent(series.dailyAutoPercent[idx] || 0) + "%</td>" +
        '<td class="num">' + formatPercent(autoPace?.allowance || 0) + "%</td>" +
        '<td class="num">' + escapeHtml(formatPaceResidual(autoPace?.residual || 0)) + "</td></tr>" +
      '<tr><td><span class="t-dot" style="background:' + API_COLOR + '"></span>' + escapeHtml(t("poolApi")) + "</td>" +
        '<td class="num">' + formatPercent(series.dailyApiPercent[idx] || 0) + "%</td>" +
        '<td class="num">' + formatPercent(apiPace?.allowance || 0) + "%</td>" +
        '<td class="num">' + escapeHtml(formatPaceResidual(apiPace?.residual || 0)) + "</td></tr>" +
    "</tbody></table>";

  positionTooltip(el, chart, tooltip);
}

function renderPoolPaceTooltip(context) {
  const { chart, tooltip } = context;
  const el = getOrCreatePoolTooltipEl("pool-pace-chart-tooltip");
  if (tooltip.opacity === 0) {
    el.style.opacity = "0";
    return;
  }

  const idx = tooltip.dataPoints?.[0]?.dataIndex;
  const series = refs.state?.poolUsageSeries;
  if (idx === undefined || !series) {
    el.style.opacity = "0";
    return;
  }

  const title = (tooltip.title && tooltip.title[0]) || "";
  const autoPace = series.dailyAutoPace[idx];
  const apiPace = series.dailyApiPace[idx];

  el.innerHTML =
    '<div class="t-title">' + escapeHtml(title) + "</div>" +
    '<table class="t-table"><thead><tr>' +
      "<th>" + escapeHtml(t("poolTooltipPool")) + "</th><th class=\"num\">" + escapeHtml(t("poolDailyPace")) + "</th>" +
    "</tr></thead><tbody>" +
      '<tr><td><span class="t-dot" style="background:' + AUTO_COLOR + '"></span>' + escapeHtml(t("poolFirstParty")) + "</td>" +
        '<td class="num">' + escapeHtml(formatPaceResidual(autoPace)) + "</td></tr>" +
      '<tr><td><span class="t-dot" style="background:' + API_COLOR + '"></span>' + escapeHtml(t("poolApi")) + "</td>" +
        '<td class="num">' + escapeHtml(formatPaceResidual(apiPace)) + "</td></tr>" +
    "</tbody></table>";

  positionTooltip(el, chart, tooltip);
}

function renderPoolPaceChart(series, muted, grid) {
  if (!ui.poolPaceCanvas) return;

  const autoResiduals = series.dailyAutoPace.map((pace) => pace.residual);
  const apiResiduals = series.dailyApiPace.map((pace) => pace.residual);
  const maxAbs = Math.max(
    1,
    ...autoResiduals.map(Math.abs),
    ...apiResiduals.map(Math.abs),
  );

  setPoolPaceChart(new Chart(ui.poolPaceCanvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: series.labels,
      datasets: [
        {
          label: t("poolFirstParty") + t("poolLegendBalance"),
          data: autoResiduals,
          backgroundColor: (ctx) => ((ctx.parsed?.y ?? 0) >= 0 ? UNDER_COLOR : OVER_COLOR),
          borderColor: (ctx) => ((ctx.parsed?.y ?? 0) >= 0 ? UNDER_COLOR : OVER_COLOR),
          borderWidth: 0,
          borderRadius: 3,
          categoryPercentage: 0.72,
          barPercentage: 0.82,
        },
        {
          label: t("poolApi") + t("poolLegendBalance"),
          data: apiResiduals,
          backgroundColor: (ctx) => ((ctx.parsed?.y ?? 0) >= 0 ? "rgba(182, 227, 193, 0.55)" : "rgba(248, 113, 113, 0.55)"),
          borderColor: (ctx) => ((ctx.parsed?.y ?? 0) >= 0 ? "rgba(182, 227, 193, 0.55)" : "rgba(248, 113, 113, 0.55)"),
          borderWidth: 0,
          borderRadius: 3,
          categoryPercentage: 0.72,
          barPercentage: 0.82,
        },
      ],
    },
    options: {
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
          external: renderPoolPaceTooltip,
        },
      },
      scales: {
        x: {
          ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false, drawBorder: false },
          border: { display: false },
        },
        y: {
          min: -maxAbs * 1.15,
          max: maxAbs * 1.15,
          ticks: {
            color: muted,
            font: { size: 10 },
            callback: (v) => (v > 0 ? "+" : "") + formatPercent(v) + "%",
          },
          grid: { color: grid, drawBorder: false, drawTicks: false },
          border: { display: false },
        },
      },
    },
  }));
}

export function renderPoolChart() {
  const series = refs.state?.poolUsageSeries;
  if (!ui.poolCanvas) return;

  if (!series || !refs.state?.data?.poolUsage) {
    setPoolChart(null);
    setPoolPaceChart(null);
    return;
  }

  const styles = getComputedStyle(document.body);
  const muted = styles.getPropertyValue("--muted").trim() || "rgba(255,255,255,0.55)";
  const grid = styles.getPropertyValue("--border").trim() || "rgba(255,255,255,0.06)";

  setPoolChart(new Chart(ui.poolCanvas.getContext("2d"), {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        {
          label: t("poolFirstParty"),
          data: series.autoPercent,
          borderColor: AUTO_COLOR,
          backgroundColor: AUTO_COLOR,
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.25,
          fill: false,
        },
        {
          label: t("poolApi"),
          data: series.apiPercent,
          borderColor: API_COLOR,
          backgroundColor: API_COLOR,
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.25,
          fill: false,
        },
      ],
    },
    options: {
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
          external: renderPoolTooltip,
        },
      },
      scales: {
        x: {
          ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false, drawBorder: false },
          border: { display: false },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: muted,
            font: { size: 10 },
            callback: (v) => formatPercent(v) + "%",
            stepSize: 25,
          },
          grid: { color: grid, drawBorder: false, drawTicks: false },
          border: { display: false },
          title: { display: false },
        },
      },
    },
  }));

  renderPoolPaceChart(series, muted, grid);

  if (ui.poolChartNote) {
    ui.poolChartNote.textContent = t("poolChartNote");
  }
}
