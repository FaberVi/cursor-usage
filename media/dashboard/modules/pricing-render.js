import { local, refs, ui } from "./core.js";
import {
  formatRateUsd,
  formatVariantPriceImpact,
  resolveModelPricing,
} from "../../../src/model-pricing.ts";
import { escapeHtml, formatBillableSpendCents, formatCents, formatTokens, rangeLabel } from "./format.js";
import { t } from "./i18n.js";
import { translateVariantLabel, translateVariantNote } from "./pricing-catalog-i18n.js";
import { renderCalculatorPanel, updateCalculator } from "./pricing-calculator.js";
import {
  aggregateForRange,
  deltaClass,
  formatDeltaPercent,
  formatRateCell,
  getPricingState,
  poolLabel,
  usedModelIdSet,
  isPricingModelPinned,
} from "./pricing-shared.js";

export function getFilteredModels() {
  const pricing = getPricingState();
  if (!pricing) return [];
  const used = usedModelIdSet();
  const usage = aggregateForRange().theoreticalByModel;
  const query = (local.pricingSearch || "").trim().toLowerCase();
  const provider = local.pricingProvider || "all";
  const pool = local.pricingPool || "all";

  let rows = pricing.catalog.models.filter((entry) => {
    if (local.pricingUsedOnly) {
      const hasUsage = Object.prototype.hasOwnProperty.call(usage, entry.id);
      const aliasUsed = (entry.aliases ?? []).some((a) => used.has(a));
      if (!hasUsage && !aliasUsed && !used.has(entry.id)) return false;
    }
    if (provider !== "all" && entry.provider !== provider) return false;
    if (pool !== "all" && entry.pool !== pool) return false;
    if (!query) return true;
    const haystack = [entry.displayName, entry.id, entry.provider, entry.notes ?? "", ...(entry.aliases ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  const dir = local.pricingSortOrder === "asc" ? 1 : -1;
  const key = local.pricingSortKey;

  function compareModels(a, b) {
    const usageA = usage[a.id];
    const usageB = usage[b.id];
    if (key === "displayName") return a.displayName.localeCompare(b.displayName) * dir;
    if (key === "provider") return a.provider.localeCompare(b.provider) * dir;
    if (key === "pool") return a.pool.localeCompare(b.pool) * dir;
    if (key === "usageTokens") {
      const av = usageA?.totalTokens ?? 0;
      const bv = usageB?.totalTokens ?? 0;
      return (av - bv) * dir;
    }
    if (key === "usageSpend") {
      const av = usageA?.actualSpendCents ?? 0;
      const bv = usageB?.actualSpendCents ?? 0;
      return (av - bv) * dir;
    }
    const rateKey = key.startsWith("rate.") ? key.slice(5) : null;
    if (rateKey) {
      const av = a.rates[rateKey] ?? -1;
      const bv = b.rates[rateKey] ?? -1;
      return (av - bv) * dir;
    }
    return a.displayName.localeCompare(b.displayName);
  }

  const pinnedOrder = new Map(local.pricingPinnedIds.map((id, index) => [id, index]));
  const pinned = [];
  const unpinned = [];
  for (const row of rows) {
    if (pinnedOrder.has(row.id)) pinned.push(row);
    else unpinned.push(row);
  }
  pinned.sort((a, b) => pinnedOrder.get(a.id) - pinnedOrder.get(b.id));
  unpinned.sort(compareModels);
  rows = [...pinned, ...unpinned];

  return rows;
}

function formatVariantImpactLabel(variant) {
  if (variant.priceImpact === "sameRateMoreTokens") return t("pricingImpactSameRate");
  if (variant.priceImpact === "rateMultiplier" && variant.rateMultiplier) {
    return t("pricingImpactRateMultiplier").replace("{n}", String(variant.rateMultiplier));
  }
  if (variant.priceImpact === "inputMultiplier" && variant.inputRateMultiplier) {
    return t("pricingImpactInputMultiplier").replace("{n}", String(variant.inputRateMultiplier));
  }
  if (variant.priceImpact === "customRates") return t("pricingImpactCustomRates");
  if (variant.priceImpact === "separateModel" && variant.separateModelId) {
    const linked = resolveModelPricing(variant.separateModelId);
    return t("pricingImpactSeparateModel").replace("{model}", linked?.displayName ?? variant.separateModelId);
  }
  return formatVariantPriceImpact(variant);
}

function renderVariantRates(variant, baseRates) {
  if (variant.priceImpact === "customRates" && variant.rates) {
    return formatRateUsd(variant.rates.output);
  }
  if (variant.priceImpact === "rateMultiplier" && variant.rateMultiplier && baseRates.output) {
    return formatRateUsd(baseRates.output * variant.rateMultiplier) + " " + t("pricingRateOut");
  }
  if (variant.priceImpact === "inputMultiplier" && variant.inputRateMultiplier && baseRates.input) {
    return formatRateUsd(baseRates.input * variant.inputRateMultiplier) + " " + t("pricingRateIn");
  }
  if (variant.priceImpact === "sameRateMoreTokens") {
    return t("pricingImpactSameRateShort");
  }
  if (variant.priceImpact === "separateModel" && variant.separateModelId) {
    const linked = resolveModelPricing(variant.separateModelId);
    return linked ? formatRateUsd(linked.rates.output) + " " + t("pricingRateOut") : "—";
  }
  return "—";
}

function renderVariantsPanel(entry) {
  if (!entry.variants?.length) return "";
  const rows = entry.variants.map((variant) =>
    "<tr>" +
      "<td>" + escapeHtml(translateVariantLabel(variant.label)) + "</td>" +
      "<td>" + escapeHtml(formatVariantImpactLabel(variant)) + "</td>" +
      '<td class="num">' + escapeHtml(renderVariantRates(variant, entry.rates)) + "</td>" +
      "<td class=\"muted small\">" + escapeHtml(translateVariantNote(entry.id, variant)) + "</td>" +
    "</tr>"
  ).join("");
  return (
    '<div class="pricing-variants-panel">' +
      '<div class="pricing-variants-title">' + escapeHtml(t("pricingModesTitle")) + "</div>" +
      '<table class="pricing-variants-table"><thead><tr>' +
        "<th>" + escapeHtml(t("pricingColMode")) + "</th>" +
        "<th>" + escapeHtml(t("pricingColImpact")) + "</th>" +
        "<th>" + escapeHtml(t("pricingColExampleRate")) + "</th>" +
        "<th>" + escapeHtml(t("pricingColNotes")) + "</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>" +
    "</div>"
  );
}

function renderModelDetailRow(entry) {
  return (
    '<tr class="pricing-detail-row" hidden data-detail-for="' + escapeHtml(entry.id) + '">' +
      '<td colspan="11">' +
        '<div class="pricing-detail-panel">' +
          renderVariantsPanel(entry) +
          renderCalculatorPanel(entry) +
        "</div>" +
      "</td>" +
    "</tr>"
  );
}

function renderModelRow(entry, usageMap, used) {
  const rates = entry.rates;
  const usage = usageMap[entry.id];
  const isUsed = usage || (entry.aliases ?? []).some((a) => used.has(a)) || used.has(entry.id);
  const highlight = local.highlightModelId &&
    (local.highlightModelId === entry.id ||
      (entry.aliases ?? []).includes(local.highlightModelId) ||
      resolveModelPricing(local.highlightModelId)?.id === entry.id);

  const inputCell = rates.inputPlusCacheWrite !== undefined
    ? formatRateCell(rates.inputPlusCacheWrite) + ' <span class="muted small">' + escapeHtml(t("pricingCacheWriteAbbr")) + "</span>"
    : formatRateCell(rates.input);

  const usageCells = usage
    ? '<td class="num">' + formatTokens(usage.totalTokens) + "</td>" +
      '<td class="num">' + formatBillableSpendCents(usage.actualSpendCents) + "</td>" +
      '<td class="num">' + formatCents(usage.reportedCostCents) + "</td>" +
      '<td class="num ' + deltaClass(usage.deltaPercent) + '">' + formatDeltaPercent(usage.deltaPercent) + "</td>"
    : '<td class="num muted">—</td><td class="num muted">—</td><td class="num muted">—</td><td class="num muted">—</td>';

  const note = entry.notes
    ? '<span class="pricing-note" title="' + escapeHtml(entry.notes) + '">ℹ</span>'
    : "";

  const pinned = isPricingModelPinned(entry.id);
  const dragHandle = pinned
    ? '<span class="pricing-drag-handle" draggable="true" data-drag-model="' + escapeHtml(entry.id) + '" role="button" tabindex="0" aria-label="' + escapeHtml(t("pricingDragReorder")) + '" title="' + escapeHtml(t("pricingDragReorder")) + '">⋮⋮</span> '
    : "";

  return (
    '<tr class="pricing-row' + (isUsed ? " pricing-row-used" : "") + (highlight ? " pricing-row-highlight" : "") + (pinned ? " pricing-row-pinned" : "") + '" data-model-id="' + escapeHtml(entry.id) + '">' +
      '<td>' +
        dragHandle +
        '<button type="button" class="pricing-pin-btn' + (pinned ? " pinned" : "") + '" data-pin-model="' + escapeHtml(entry.id) + '" aria-pressed="' + (pinned ? "true" : "false") + '" title="' + escapeHtml(pinned ? t("pricingUnpin") : t("pricingPin")) + '">' + (pinned ? "★" : "☆") + "</button> " +
        '<button type="button" class="pricing-expand-btn" data-expand-model="' + escapeHtml(entry.id) + '" aria-expanded="false" title="' + escapeHtml(t("pricingToggleCalc")) + '">▸</button> ' +
        '<span class="pricing-model-label">' +
          '<span class="pricing-model-name">' + escapeHtml(entry.displayName) + note + "</span>" +
          (entry.hidden ? '<span class="pricing-hidden-badge">' + escapeHtml(t("pricingHidden")) + "</span>" : "") +
        "</span>" +
      "</td>" +
      '<td>' + escapeHtml(entry.provider) + "</td>" +
      '<td><span class="pricing-pool-badge pricing-pool-' + (entry.pool === "firstParty" || entry.pool === "api" || entry.pool === "grokBot" ? entry.pool : "unknown") + '">' + escapeHtml(poolLabel(entry.pool)) + "</span></td>" +
      '<td class="num">' + inputCell + "</td>" +
      '<td class="num">' + formatRateCell(rates.cacheWrite) + "</td>" +
      '<td class="num">' + formatRateCell(rates.cacheRead) + "</td>" +
      '<td class="num">' + formatRateCell(rates.output) + "</td>" +
      usageCells +
    "</tr>" +
    renderModelDetailRow(entry)
  );
}

export function renderPricingMeta() {
  const pricing = getPricingState();
  if (!pricing || !ui.pricingUpdated || !ui.pricingSource) return;
  let updatedText = t("pricingUpdated") + " " + pricing.catalog.lastUpdated;
  if (refs.state?.pricingCatalogSyncedAt) {
    const syncedDate = new Date(refs.state.pricingCatalogSyncedAt).toISOString().slice(0, 10);
    updatedText += " · " + t("pricingSyncedBadge");
    if (ui.pricingSyncBadge) {
      ui.pricingSyncBadge.textContent = t("pricingSyncedBadge") + " " + syncedDate;
      ui.pricingSyncBadge.classList.remove("hidden");
    }
  } else if (ui.pricingSyncBadge) {
    ui.pricingSyncBadge.classList.add("hidden");
    ui.pricingSyncBadge.textContent = "";
  }
  ui.pricingUpdated.textContent = updatedText;
  ui.pricingSource.href = pricing.catalog.sourceUrl;
}

function renderPricingRuntimeAlert() {
  if (!ui.pricingRuntimeAlert) return;
  const models = refs.state?.pricingRuntimeOnlyModels ?? [];
  if (!models.length) {
    ui.pricingRuntimeAlert.classList.add("hidden");
    ui.pricingRuntimeAlert.innerHTML = "";
    return;
  }

  const names = models.map((model) => escapeHtml(model.displayName)).join(", ");
  ui.pricingRuntimeAlert.classList.remove("hidden");
  ui.pricingRuntimeAlert.innerHTML =
    "<strong>" + escapeHtml(t("pricingRuntimeOnlyTitle")) + "</strong>" +
    "<p>" + escapeHtml(t("pricingRuntimeOnlyBody")) + "</p>" +
    '<p class="pricing-runtime-only-models">' + names + "</p>";
}

export function renderPricing() {
  if (!ui.pricingBody || !ui.pricingHead) return;
  const pricing = getPricingState();
  renderPricingMeta();
  renderPricingRuntimeAlert();

  if (ui.pricingSearch && ui.pricingSearch.value !== local.pricingSearch) {
    ui.pricingSearch.value = local.pricingSearch;
  }
  if (ui.pricingPoolFilter) {
    ui.pricingPoolFilter.value = local.pricingPool || "all";
  }
  if (ui.pricingUsedOnly) {
    ui.pricingUsedOnly.checked = local.pricingUsedOnly === true;
  }

  if (ui.pricingRangeLabel) {
    ui.pricingRangeLabel.textContent = "(" + rangeLabel() + ")";
  }

  if (!pricing) {
    ui.pricingBody.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:24px;">' + escapeHtml(t("noData")) + "</td></tr>";
    return;
  }

  const usageMap = aggregateForRange().theoreticalByModel;
  const used = usedModelIdSet();
  const rows = getFilteredModels();

  if (ui.pricingProviderFilter) {
    const providers = [...new Set(pricing.catalog.models.map((m) => m.provider))].sort();
    const current = local.pricingProvider || "all";
    ui.pricingProviderFilter.innerHTML =
      '<option value="all">' + escapeHtml(t("pricingFilterAllProviders")) + "</option>" +
      providers.map((p) => '<option value="' + escapeHtml(p) + '"' + (p === current ? " selected" : "") + ">" + escapeHtml(p) + "</option>").join("");
  }

  ui.pricingHead.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === local.pricingSortKey) {
      th.classList.add(local.pricingSortOrder === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  if (rows.length === 0) {
    ui.pricingBody.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:24px;">' + escapeHtml(t("pricingNoModels")) + "</td></tr>";
    return;
  }

  ui.pricingBody.innerHTML = rows.map((entry) => renderModelRow(entry, usageMap, used)).join("");

  if (local.pricingExpandedId) {
    const detailRow = ui.pricingBody.querySelector('[data-detail-for="' + local.pricingExpandedId + '"]');
    const expandBtn = ui.pricingBody.querySelector('[data-expand-model="' + local.pricingExpandedId + '"]');
    if (detailRow && expandBtn) {
      detailRow.hidden = false;
      expandBtn.setAttribute("aria-expanded", "true");
      expandBtn.textContent = "▾";
      updateCalculator(detailRow);
    }
  }

  if (local.highlightModelId) {
    const highlightRow = ui.pricingBody.querySelector(".pricing-row-highlight");
    if (highlightRow) {
      highlightRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}
