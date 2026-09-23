import { refs, ui } from "./core.js";
import { t } from "./i18n.js";
import { escapeHtml, formatResetCountdown } from "./format.js";
import { cardLabel, renderBillingCycleCard, renderPlanBanner } from "./summary-cards.js";
import {
  formatOnDemandFooter,
  formatOnDemandValue,
  renderOnDemandProgress,
} from "./summary-ondemand.js";
import { renderPoolUsageCard } from "./summary-pool.js";
import { renderGrokBotUsageCard } from "./summary-grok-bot.js";

export function renderSummaryCards() {
  renderPlanBanner();
  if (!refs.state || !refs.state.data) {
    ui.summaryCards.innerHTML = '<div class="card"><div class="card-label">' + escapeHtml(t("noData")) + "</div></div>";
    return;
  }
  const { includedRequests, onDemand } = refs.state.data;

  const parts = [];

  if (refs.state.showPremiumRequests) {
    const reqRatio = includedRequests.limit > 0 ? Math.min(1, includedRequests.used / includedRequests.limit) : 0;
    const reqPct = Math.round(reqRatio * 100);
    parts.push(
      '<div class="card">' +
        cardLabel(t("includedRequests"), "includedRequests") +
        '<div class="card-value">' + includedRequests.used + " / " + includedRequests.limit + "</div>" +
        '<div class="progress"><div style="width:' + (reqPct) + '%"></div></div>' +
        '<div class="card-footer">' + formatResetCountdown(refs.state.resetsAt) + "</div>" +
      "</div>"
    );
  }

  if (onDemand.state !== "disabled" && onDemand.onDemandEnabled !== false) {
    let valText, footerText, progressHtml;
    if (onDemand.state === "unlimited") {
      valText = formatOnDemandValue(onDemand);
      progressHtml = onDemand.breakdown
        ? renderOnDemandProgress(onDemand)
        : '<div class="progress"><div style="width:0%"></div></div>';
      footerText = formatOnDemandFooter(onDemand);
    } else {
      valText = formatOnDemandValue(onDemand);
      progressHtml = renderOnDemandProgress(onDemand);
      footerText = formatOnDemandFooter(onDemand);
    }
    parts.push(
      '<div class="card">' +
        cardLabel(t("onDemandUsage"), "onDemand") +
        '<div class="card-value">' + valText + "</div>" +
        progressHtml +
        '<div class="card-footer">' + escapeHtml(footerText) + "</div>" +
      "</div>"
    );
  }

  if (refs.state.data.poolUsage && !refs.state.showPremiumRequests) {
    parts.push(renderBillingCycleCard(refs.state.resetsAt));
  }

  if (refs.state.data.poolUsage) {
    parts.push(renderPoolUsageCard(
      refs.state.data.poolUsage,
      refs.state.poolDepletion,
      refs.state.resetsAt,
      refs.state.poolUsageSeries,
      refs.state.poolRecommended,
    ));
  }

  if (refs.state.data.grokBotUsage) {
    parts.push(renderGrokBotUsageCard(refs.state.data.grokBotUsage));
  }

  ui.summaryCards.innerHTML = parts.join("");
  ui.summaryCards.classList.toggle("has-pool-card", Boolean(refs.state.data.poolUsage));
  ui.summaryCards.classList.toggle("has-grok-bot-card", Boolean(refs.state.data.grokBotUsage));
}
