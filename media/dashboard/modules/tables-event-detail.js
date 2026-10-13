import { refs, setSelectedEventKey, TOKEN_COLORS, ui } from "./core.js";
import {
  escapeHtml,
  eventRequestCount,
  eventRequestsText,
  eventTokenCount,
  eventSpendDollars,
  eventSpendText,
  formatCents,
  formatFullDateTime,
  formatModelLabel,
  formatTokenCount,
  isOnDemandEvent,
  pctOf,
  ratioText,
  tokenField,
} from "./format.js";
import { t } from "./i18n.js";
import { translateVariantLabel } from "./pricing-catalog-i18n.js";
import { getEventPricingEstimate } from "./pricing.js";
import { formatRateUsd } from "../../../src/model-pricing.ts";
import { renderGrokBotTable, renderTable } from "./tables-events.js";

function renderTokenBreakdown(event) {
  const input = tokenField(event, "inputTokens");
  const output = tokenField(event, "outputTokens");
  const cacheWrite = tokenField(event, "cacheWriteTokens");
  const cacheRead = tokenField(event, "cacheReadTokens");
  const total = eventTokenCount(event);
  const segments = [
    { key: "input", label: t("pricingInput"), value: input, color: TOKEN_COLORS.input },
    { key: "output", label: t("pricingOutput"), value: output, color: TOKEN_COLORS.output },
    { key: "cacheWrite", label: t("pricingCacheWrite"), value: cacheWrite, color: TOKEN_COLORS.cacheWrite },
    { key: "cacheRead", label: t("pricingCacheRead"), value: cacheRead, color: TOKEN_COLORS.cacheRead },
  ].filter((s) => s.value > 0);

  if (total === 0) {
    return '<p class="muted small">' + escapeHtml(t("eventNoTokenBreakdown")) + "</p>";
  }

  const bar = segments.map((s) =>
    '<span class="token-bar-seg" style="width:' + ((s.value / total) * 100).toFixed(2) + '%;background:' + s.color + ';" title="' + s.label + ': ' + formatTokenCount(s.value) + '"></span>'
  ).join("");

  const rows = segments.map((s) =>
    '<div class="token-row">' +
      '<span class="token-dot" style="background:' + s.color + ';"></span>' +
      "<span>" + s.label + "</span>" +
      '<span class="count">' + formatTokenCount(s.value) + "</span>" +
      '<span class="pct">' + pctOf(s.value, total) + "</span>" +
    "</div>"
  ).join("");

  return '<div class="token-bar">' + bar + '</div><div class="token-rows">' + rows + "</div>";
}

function renderEventDetailMetrics(event) {
  const input = tokenField(event, "inputTokens");
  const output = tokenField(event, "outputTokens");
  const cacheWrite = tokenField(event, "cacheWriteTokens");
  const cacheRead = tokenField(event, "cacheReadTokens");
  const total = eventTokenCount(event);
  const requests = eventRequestCount(event);
  const spend = eventSpendDollars(event);
  const spendCents = Math.round(spend * 100);
  const promptSide = input + cacheWrite + cacheRead;

  const items = [
    [t("eventOutputInput"), ratioText(output, input)],
    [t("eventCacheReadShare"), pctOf(cacheRead, promptSide)],
    [t("eventTokensPerRequest"), requests ? formatTokenCount(total / requests) : "\u2014"],
  ];
  if (spendCents > 0 && total > 0) {
    items.push([t("eventCostPerMillion"), formatCents((spendCents / total) * 1_000_000)]);
  }
  if (spendCents > 0 && requests > 0) {
    items.push([t("eventCostPerRequest"), formatCents(spendCents / requests)]);
  }

  return items.map(([label, value]) => "<dt>" + escapeHtml(label) + "</dt><dd>" + value + "</dd>").join("");
}

function renderEventDetailOfficialPricing(event) {
  const estimate = getEventPricingEstimate(event);
  if (!estimate) {
    return (
      '<div class="event-detail-section"><h3>' + escapeHtml(t("pricingOfficialTitle")) + "</h3>" +
      '<p class="muted small">' + escapeHtml(t("pricingNotInCatalog")) + "</p></div>"
    );
  }

  const { entry, variant, breakdown } = estimate;
  const rows = [];
  if (entry.rates.inputPlusCacheWrite !== undefined) {
    const promptTokens = (event.inputTokens || 0) + (event.cacheWriteTokens || 0);
    rows.push([
      t("pricingInputCacheWrite"),
      formatTokenCount(promptTokens) + " × " + formatRateUsd(entry.rates.inputPlusCacheWrite) + "/M",
      formatCents(breakdown.inputCents),
    ]);
  } else {
    if (event.inputTokens) {
      rows.push([
        t("pricingInput"),
        formatTokenCount(event.inputTokens) + " × " + formatRateUsd(entry.rates.input) + "/M",
        formatCents(breakdown.inputCents),
      ]);
    }
    if (event.cacheWriteTokens) {
      rows.push([
        t("pricingCacheWrite"),
        formatTokenCount(event.cacheWriteTokens) + " × " + formatRateUsd(entry.rates.cacheWrite) + "/M",
        formatCents(breakdown.cacheWriteCents),
      ]);
    }
  }
  if (event.cacheReadTokens) {
    rows.push([
      t("pricingCacheRead"),
      formatTokenCount(event.cacheReadTokens) + " × " + formatRateUsd(entry.rates.cacheRead) + "/M",
      formatCents(breakdown.cacheReadCents),
    ]);
  }
  if (event.outputTokens) {
    rows.push([
      t("pricingOutput"),
      formatTokenCount(event.outputTokens) + " × " + formatRateUsd(entry.rates.output) + "/M",
      formatCents(breakdown.outputCents),
    ]);
  }
  if (breakdown.cursorTokenFeeCents > 0) {
    rows.push([t("pricingCursorTokenFee"), "—", formatCents(breakdown.cursorTokenFeeCents)]);
  }

  const actualCents = event.spendCents || 0;
  const deltaCents = actualCents - breakdown.totalCents;
  const deltaPercent = breakdown.totalCents > 0 ? (deltaCents / breakdown.totalCents) * 100 : null;

  const tableRows = rows.map(([label, detail, cost]) =>
    "<tr><td>" + escapeHtml(label) + '</td><td class="muted small">' + escapeHtml(detail) + '</td><td class="num">' + cost + "</td></tr>"
  ).join("");

  return (
    '<div class="event-detail-section"><h3>' + escapeHtml(t("pricingOfficialTitle")) + "</h3>" +
    (variant ? '<p class="muted small">' + escapeHtml(t("pricingDetectedMode")) + ": <strong>" + escapeHtml(translateVariantLabel(variant.label)) + "</strong></p>" : "") +
    '<table class="pricing-detail-table"><thead><tr><th>' + escapeHtml(t("pricingColComponent")) + "</th><th>" + escapeHtml(t("pricingColDetail")) + "</th><th>" + escapeHtml(t("pricingColCost")) + "</th></tr></thead><tbody>" +
      tableRows +
      '<tr class="pricing-detail-total"><td colspan="2"><strong>' + escapeHtml(t("pricingColTheoretical")) + "</strong></td><td class=\"num\"><strong>" + formatCents(breakdown.totalCents) + "</strong></td></tr>" +
      '<tr><td colspan="2">' + escapeHtml(t("pricingColActual")) + "</td><td class=\"num\">" + formatCents(actualCents) + "</td></tr>" +
      '<tr><td colspan="2">' + escapeHtml(t("pricingColDelta")) + "</td><td class=\"num\">" + formatCents(deltaCents) + (deltaPercent !== null ? " (" + (deltaPercent > 0 ? "+" : "") + deltaPercent.toFixed(1) + "%)" : "") + "</td></tr>" +
    "</tbody></table></div>"
  );
}

function renderEventDetailCost(event) {
  const showSpend = !refs.state || !refs.state.quotaAwareEventDisplay || isOnDemandEvent(event);
  const tokenCost = event.tokenCostCents || 0;
  const fee = event.cursorTokenFee || 0;
  const charged = event.spendCents || 0;
  const rows = [];

  if (showSpend) {
    if (tokenCost > 0) rows.push([t("eventModelTokenCost"), formatCents(tokenCost)]);
    if (fee > 0) rows.push([t("eventCursorTokenFee"), formatCents(fee)]);
    rows.push([t("eventTotalCharged"), formatCents(charged)]);
  } else {
    rows.push([t("eventBilling"), t("eventIncludedInPlan")]);
    if (tokenCost > 0) rows.push([t("eventTokenValueEst"), formatCents(tokenCost)]);
  }

  return rows.map(([label, value]) => "<dt>" + escapeHtml(label) + "</dt><dd>" + value + "</dd>").join("");
}

function renderEventDetailFlags(event) {
  const flags = [
    { label: t("eventFlagTokenBased"), on: !!event.isTokenBasedCall },
    { label: t("eventFlagHeadless"), on: !!event.isHeadless },
    { label: t("eventFlagChargeable"), on: !!event.isChargeable },
    { label: t("eventFlagMaxMode"), on: !!event.maxMode },
  ];
  return flags.map((f) =>
    '<span class="detail-flag' + (f.on ? " on" : "") + '">' + escapeHtml(f.label) + "</span>"
  ).join("");
}

export function showEventDetail(event) {
  if (!ui.eventDetailOverlay || !ui.eventDetailBody || !event) return;
  setSelectedEventKey(event.eventKey ?? null);
  refs.selectedConversationId = null;
  renderTable();
  renderGrokBotTable();

  const maxBadge = event.maxMode ? ' <span class="max-badge">MAX</span>' : "";
  ui.eventDetailTitle.innerHTML = escapeHtml(formatModelLabel(event.model)) + maxBadge;
  ui.eventDetailSubtitle.textContent = formatFullDateTime(event.timestamp);

  ui.eventDetailBody.innerHTML =
    '<div class="event-detail-grid">' +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("eventTotalTokens")) + '</span><span class="value">' + formatTokenCount(eventTokenCount(event)) + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("colRequests")) + '</span><span class="value">' + eventRequestsText(event) + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("colSpend")) + '</span><span class="value">' + eventSpendText(event) + "</span></div>" +
    "</div>" +
    '<div class="event-detail-section"><h3>' + escapeHtml(t("eventTokenBreakdown")) + "</h3>" + renderTokenBreakdown(event) + "</div>" +
    '<div class="event-detail-section"><h3>' + escapeHtml(t("eventEfficiency")) + "</h3><dl class=\"detail-kv\">" + renderEventDetailMetrics(event) + "</dl></div>" +
    renderEventDetailOfficialPricing(event) +
    '<div class="event-detail-section"><h3>' + escapeHtml(t("eventCost")) + "</h3><dl class=\"detail-kv\">" + renderEventDetailCost(event) + "</dl></div>" +
    '<div class="event-detail-section"><h3>' + escapeHtml(t("eventDetails")) + "</h3><div class=\"detail-flags\">" + renderEventDetailFlags(event) + "</div>" +
    '<dl class="detail-kv" style="margin-top:8px;"><dt>' + escapeHtml(t("colType")) + "</dt><dd>" + escapeHtml(event.kind) + "</dd>" +
    "<dt>" + escapeHtml(t("eventModelId")) + "</dt><dd>" + escapeHtml(event.model) + "</dd></dl></div>";

  ui.eventDetailOverlay.classList.remove("hidden");
  ui.eventDetailOverlay.setAttribute("aria-hidden", "false");
  ui.eventDetailClose?.removeAttribute("tabindex");
  ui.eventDetailClose?.focus();
}

export function closeEventDetail() {
  if (!ui.eventDetailOverlay) return;
  setSelectedEventKey(null);
  refs.selectedConversationId = null;
  ui.eventDetailOverlay.classList.add("hidden");
  ui.eventDetailOverlay.setAttribute("aria-hidden", "true");
  ui.eventDetailClose?.setAttribute("tabindex", "-1");
  renderTable();
  renderGrokBotTable();
}
