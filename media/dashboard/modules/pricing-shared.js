import { refs, local, persistGlobalUi, persistLocal } from "./core.js";
import { aggregateTheoreticalByModel, formatRateUsd } from "../../../src/model-pricing.ts";
import { escapeHtml, matchesUsageFilter, rangeNow } from "./format.js";
import { t } from "./i18n.js";

export function getPricingState() {
  return refs.state?.modelPricing ?? null;
}

export function isTeamPlan() {
  const tier = refs.state?.data?.planInfo?.tier ?? "";
  return tier === "Teams" || tier === "Enterprise" || tier.startsWith("Teams ·");
}

export function getEstimateOpts() {
  const catalog = getPricingState()?.catalog;
  return {
    applyCursorTokenRate: isTeamPlan(),
    cursorTokenRatePerMillion: catalog?.cursorTokenRatePerMillion ?? 0.25,
    quotaAwareEventDisplay: refs.state?.quotaAwareEventDisplay !== false,
  };
}

export function aggregateForRange() {
  if (!refs.state) return { usedModelIds: [], theoreticalByModel: {} };
  const events = Array.isArray(refs.state.events) ? refs.state.events : [];
  const filtered = events.filter((e) => matchesUsageFilter(e, local.usageFilter));
  return aggregateTheoreticalByModel(
    filtered,
    local.range,
    refs.state.resetsAt,
    rangeNow(),
    getEstimateOpts(),
  );
}

export function usedModelIdSet() {
  return new Set(aggregateForRange().usedModelIds);
}

export function formatRateCell(rate) {
  if (rate === undefined) return '<span class="muted">—</span>';
  return escapeHtml(formatRateUsd(rate));
}

export function poolLabel(pool) {
  if (pool === "firstParty") return t("pricingPoolFirstParty");
  if (pool === "grokBot") return t("pricingPoolGrokBot");
  return t("pricingPoolApi");
}

export function deltaClass(deltaPercent) {
  if (deltaPercent === null || !Number.isFinite(deltaPercent)) return "";
  if (Math.abs(deltaPercent) <= 10) return "pricing-delta-ok";
  return "pricing-delta-warn";
}

export function formatDeltaPercent(deltaPercent) {
  if (deltaPercent === null || !Number.isFinite(deltaPercent)) return "—";
  const sign = deltaPercent > 0 ? "+" : "";
  return sign + deltaPercent.toFixed(1) + "%";
}

export function isPricingModelPinned(modelId) {
  return local.pricingPinnedIds.includes(modelId);
}

export function togglePricingModelPin(modelId) {
  const pinned = local.pricingPinnedIds.slice();
  const index = pinned.indexOf(modelId);
  if (index >= 0) {
    pinned.splice(index, 1);
  } else {
    pinned.push(modelId);
  }
  local.pricingPinnedIds = pinned;
}

export function reorderPricingModelPin(draggedId, beforeId) {
  if (!draggedId || !beforeId || draggedId === beforeId) return;
  const pinned = local.pricingPinnedIds.filter((id) => id !== draggedId);
  const insertAt = pinned.indexOf(beforeId);
  if (insertAt < 0) pinned.push(draggedId);
  else pinned.splice(insertAt, 0, draggedId);
  local.pricingPinnedIds = pinned;
}

export function persistPricingPins() {
  persistLocal();
  persistGlobalUi({ pricingPinnedIds: local.pricingPinnedIds.slice() });
}
