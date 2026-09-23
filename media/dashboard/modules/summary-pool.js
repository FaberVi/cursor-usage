import { cardHelpButton, cardLabel } from "./summary-cards.js";
import { local } from "./core.js";
import { getDateLocale, t } from "./i18n.js";
import { escapeHtml, formatPercent } from "./format.js";
import { formatDailyBudgetResetCountdown } from "../../../src/daily-budget-reset.ts";

function formatProjectionDate(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString(getDateLocale(), { month: "short", day: "numeric", year: "numeric" });
}

function renderDepletionLine(label, projection, resetAtIso) {
  if (!projection) return "";
  const avg = formatPercent(projection.avgDailyPercent) + t("perDay");

  if (projection.status === "exhausted") {
    return (
      '<div class="pool-projection-row">' +
        '<span class="pool-projection-label">' + escapeHtml(label) + "</span>" +
        '<span class="pool-projection-value exhausted">' + escapeHtml(t("alreadyExhausted")) + "</span>" +
        '<span class="pool-projection-avg muted">' + escapeHtml(avg) + "</span>" +
      "</div>"
    );
  }

  if (projection.status === "no_usage") {
    return (
      '<div class="pool-projection-row">' +
        '<span class="pool-projection-label">' + escapeHtml(label) + "</span>" +
        '<span class="pool-projection-value muted">' + escapeHtml(t("noUsageYet")) + "</span>" +
      "</div>"
    );
  }

  let valueText = "~" + formatProjectionDate(projection.projectedAtIso);
  if (projection.status === "after_reset") {
    const resetText = resetAtIso ? formatProjectionDate(resetAtIso) : t("rangeBilling");
    valueText = resetText + " (" + formatProjectionDate(projection.projectedAtIso) + ")";
  }

  return (
    '<div class="pool-projection-row">' +
      '<span class="pool-projection-label">' + escapeHtml(label) + "</span>" +
      '<span class="pool-projection-value">' + escapeHtml(valueText) + "</span>" +
      '<span class="pool-projection-avg muted">' + escapeHtml(avg) + "</span>" +
    "</div>"
  );
}

function renderTodayPaceRow(label, pace) {
  if (!pace) return "";
  const { allowance, used, residual } = pace;
  const usedRatio = allowance > 0 ? used / allowance : 0;
  const usedWidth = Math.min(Math.max(usedRatio, 0), 1) * 100;
  const allowanceWidth = 100;
  const budgetZoneWidth = usedRatio < 1 ? (1 - Math.min(usedRatio, 1)) * 100 : 0;
  const overWidth = usedRatio > 1 ? Math.min((usedRatio - 1) * 100, 100) : 0;

  let statusText;
  let statusClass;
  if (residual > 0.05) {
    statusText = formatPercent(residual) + "% " + t("leftToday");
    statusClass = "under";
  } else if (residual < -0.05) {
    statusText = formatPercent(Math.abs(residual)) + "% " + t("overPace");
    statusClass = "over";
  } else {
    statusText = t("onPace");
    statusClass = "on-budget";
  }

  const overSegment =
    overWidth > 0
      ? '<div class="pool-pace-over" style="width:' + overWidth + '%"></div>'
      : "";
  const budgetZoneSegment =
    budgetZoneWidth > 0
      ? '<div class="pool-pace-budget-zone" style="width:' + budgetZoneWidth + '%"></div>'
      : "";

  return (
    '<div class="pool-pace-row">' +
      '<span class="pool-pace-label">' + escapeHtml(label) + "</span>" +
      '<div class="pool-pace-bar" title="' + escapeHtml(t("poolPaceBarTitle")) + " " + formatPercent(allowance) + "%, " + formatPercent(used) + '%">' +
        '<div class="pool-pace-track">' +
          '<div class="pool-pace-used" style="width:' + usedWidth + '%"></div>' +
          budgetZoneSegment +
          overSegment +
          '<div class="pool-pace-marker" style="left:' + allowanceWidth + '%"></div>' +
        "</div>" +
      "</div>" +
      '<span class="pool-pace-status ' + statusClass + '">' + escapeHtml(statusText) + "</span>" +
    "</div>"
  );
}

function poolSectionHead(helpKey, titleKey) {
  return (
    '<div class="pool-section-head">' +
      "<span>" + escapeHtml(t(titleKey)) + "</span>" +
      cardHelpButton(helpKey) +
    "</div>"
  );
}

function renderTodayPace(poolSeries) {
  if (!poolSeries?.todayAutoPace && !poolSeries?.todayApiPace) return "";
  const resetCountdown = formatDailyBudgetResetCountdown(local.locale);
  return (
    '<div class="pool-pace">' +
      poolSectionHead("poolPace", "todayPace") +
      '<p class="muted small pool-pace-reset" id="daily-budget-reset-countdown">' + escapeHtml(resetCountdown) + "</p>" +
      renderTodayPaceRow(t("poolFirstParty"), poolSeries.todayAutoPace) +
      renderTodayPaceRow(t("poolApi"), poolSeries.todayApiPace) +
    "</div>"
  );
}

function renderIncludedPoolUsage(poolUsage, poolRecommended) {
  const autoUsed = Math.min(Math.max(poolUsage.autoPercentUsed, 0), 100);
  const apiUsed = Math.min(Math.max(poolUsage.apiPercentUsed, 0), 100);
  const autoRec = poolRecommended
    ? Math.min(Math.max(poolRecommended.autoRecommended, 0), 100)
    : null;
  const apiRec = poolRecommended
    ? Math.min(Math.max(poolRecommended.apiRecommended, 0), 100)
    : null;

  function usageRow(label, usedPct, recPct) {
    const marker =
      recPct != null
        ? '<div class="pool-pace-marker pool-recommended-marker" style="left:' + recPct + '%"></div>'
        : "";
    const pctLabel =
      recPct != null
        ? formatPercent(usedPct) + '% <span class="pool-target-pct muted">/ ' +
          formatPercent(recPct) + "% " + escapeHtml(t("recTarget")) + "</span>"
        : formatPercent(usedPct) + "%";
    const barTitle =
      recPct != null
        ? escapeHtml(t("usedLabel")) + " " + formatPercent(usedPct) + "%, " +
          escapeHtml(t("recTarget")) + " " + formatPercent(recPct) + "%"
        : escapeHtml(t("usedLabel")) + " " + formatPercent(usedPct) + "%";

    return (
      '<div class="pool-pace-row pool-included-row">' +
        '<span class="pool-pace-label">' + escapeHtml(label) + "</span>" +
        '<div class="pool-pace-bar" title="' + barTitle + '">' +
          '<div class="pool-pace-track">' +
            '<div class="pool-pace-used" style="width:' + usedPct + '%"></div>' +
            marker +
          "</div>" +
        "</div>" +
        '<span class="pool-pct">' + pctLabel + "</span>" +
      "</div>"
    );
  }

  const intro = poolRecommended ? t("recommendedPaceDesc") : t("poolIncludedIntro");

  return (
    '<div class="pool-included-body">' +
      '<p class="muted small pool-included-intro">' +
        escapeHtml(intro) +
        cardHelpButton("poolRecommended") +
      "</p>" +
      usageRow(t("poolFirstParty"), autoUsed, autoRec) +
      usageRow(t("poolApi"), apiUsed, apiRec) +
    "</div>"
  );
}

export function updateDailyBudgetResetCountdown() {
  const el = document.getElementById("daily-budget-reset-countdown");
  if (!el) return;
  el.textContent = formatDailyBudgetResetCountdown(local.locale);
}

export function renderPoolUsageCard(poolUsage, poolDepletion, resetAtIso, poolSeries, poolRecommended) {
  const totalPct = Math.min(Math.max(poolUsage.totalPercentUsed, 0), 100);
  const projections = poolDepletion
    ? renderDepletionLine(t("poolFirstParty"), poolDepletion.auto, resetAtIso) +
      renderDepletionLine(t("poolApi"), poolDepletion.api, resetAtIso)
    : "";

  return (
    '<div class="card card-pool">' +
      '<div class="card-pool-head">' +
        cardLabel(t("includedPool"), "includedPool") +
        '<div class="card-value card-pool-total">' +
          formatPercent(totalPct) + '% <span class="card-value-qual muted">' + escapeHtml(t("totalUsed")) + "</span>" +
        "</div>" +
      "</div>" +
      renderIncludedPoolUsage(poolUsage, poolRecommended) +
      (projections
        ? '<div class="pool-projection">' +
            poolSectionHead("poolDepletion", "projectedPace") +
            projections +
          "</div>"
        : "") +
      renderTodayPace(poolSeries) +
    "</div>"
  );
}
