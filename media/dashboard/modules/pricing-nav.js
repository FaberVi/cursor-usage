import { local, persistLocal, switchMainTab, ui, vscode } from "./core.js";
import {
  estimateEventTheoreticalCost,
  resolveModelPricing,
  resolveModelPricingDetailed,
} from "../../../src/model-pricing.ts";
import { updateCalculator } from "./pricing-calculator.js";
import { renderPricing } from "./pricing-render.js";
import { getEstimateOpts, togglePricingModelPin, reorderPricingModelPin, persistPricingPins } from "./pricing-shared.js";

export function navigateToModelPricing(modelId) {
  const entry = resolveModelPricing(modelId);
  local.highlightModelId = entry?.id ?? modelId;
  local.pricingUsedOnly = false;
  if (entry) {
    local.pricingSearch = entry.displayName;
  } else {
    local.pricingSearch = modelId;
  }
  persistLocal();
  if (ui.pricingSearch) ui.pricingSearch.value = local.pricingSearch;
  if (ui.pricingUsedOnly) ui.pricingUsedOnly.checked = false;
  switchMainTab("pricing");
  renderPricing();
  window.setTimeout(() => {
    const highlightRow = ui.pricingBody?.querySelector(".pricing-row-highlight");
    if (highlightRow) {
      highlightRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, 50);
  window.setTimeout(() => {
    local.highlightModelId = null;
    persistLocal();
    renderPricing();
  }, 3000);
}

export function bindPricingHandlers() {
  if (ui.pricingRefreshBtn) {
    ui.pricingRefreshBtn.addEventListener("click", () => {
      if (ui.pricingSyncStatus) ui.pricingSyncStatus.textContent = "";
      vscode.postMessage({ type: "refreshPricingCatalog" });
    });
  }
  if (ui.pricingSearch) {
    ui.pricingSearch.addEventListener("input", () => {
      local.pricingSearch = ui.pricingSearch.value;
      persistLocal();
      renderPricing();
    });
  }
  if (ui.pricingProviderFilter) {
    ui.pricingProviderFilter.addEventListener("change", () => {
      local.pricingProvider = ui.pricingProviderFilter.value;
      persistLocal();
      renderPricing();
    });
  }
  if (ui.pricingPoolFilter) {
    ui.pricingPoolFilter.addEventListener("change", () => {
      local.pricingPool = ui.pricingPoolFilter.value;
      persistLocal();
      renderPricing();
    });
  }
  if (ui.pricingUsedOnly) {
    ui.pricingUsedOnly.addEventListener("change", () => {
      local.pricingUsedOnly = ui.pricingUsedOnly.checked;
      persistLocal();
      renderPricing();
    });
  }
  if (ui.pricingHead) {
    ui.pricingHead.addEventListener("click", (e) => {
      const th = e.target.closest("th.sortable");
      if (!th) return;
      const key = th.dataset.sort;
      if (local.pricingSortKey === key) {
        local.pricingSortOrder = local.pricingSortOrder === "asc" ? "desc" : "asc";
      } else {
        local.pricingSortKey = key;
        local.pricingSortOrder = key === "displayName" || key === "provider" ? "asc" : "desc";
      }
      persistLocal();
      renderPricing();
    });
  }
  if (ui.pricingBody) {
    ui.pricingBody.addEventListener("click", (e) => {
      const pinBtn = e.target.closest("[data-pin-model]");
      if (pinBtn) {
        e.preventDefault();
        e.stopPropagation();
        togglePricingModelPin(pinBtn.dataset.pinModel);
        persistPricingPins();
        renderPricing();
        return;
      }
      const btn = e.target.closest("[data-expand-model]");
      if (!btn) return;
      const modelId = btn.dataset.expandModel;
      const detailRow = ui.pricingBody.querySelector('[data-detail-for="' + modelId + '"]');
      if (!detailRow) return;
      const open = detailRow.hidden;
      ui.pricingBody.querySelectorAll(".pricing-detail-row").forEach((row) => {
        row.hidden = true;
      });
      ui.pricingBody.querySelectorAll(".pricing-expand-btn").forEach((b) => {
        b.setAttribute("aria-expanded", "false");
        b.textContent = "▸";
      });
      if (open) {
        detailRow.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        btn.textContent = "▾";
        local.pricingExpandedId = modelId;
        updateCalculator(detailRow);
      } else {
        local.pricingExpandedId = null;
      }
      persistLocal();
    });
    ui.pricingBody.addEventListener("input", (e) => {
      const input = e.target.closest("[data-calc-field]");
      if (!input) return;
      const detailRow = input.closest(".pricing-detail-row");
      if (detailRow) updateCalculator(detailRow);
    });

    let draggedPinModelId = null;

    ui.pricingBody.addEventListener("dragstart", (e) => {
      const handle = e.target.closest("[data-drag-model]");
      if (!handle) return;
      draggedPinModelId = handle.dataset.dragModel;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", draggedPinModelId);
      const row = handle.closest(".pricing-row-pinned");
      if (row) row.classList.add("pricing-row-dragging");
    });

    ui.pricingBody.addEventListener("dragend", () => {
      draggedPinModelId = null;
      ui.pricingBody.querySelectorAll(".pricing-row-dragging, .pricing-row-drag-over").forEach((el) => {
        el.classList.remove("pricing-row-dragging", "pricing-row-drag-over");
      });
    });

    ui.pricingBody.addEventListener("dragover", (e) => {
      const row = e.target.closest(".pricing-row-pinned");
      if (!row || !draggedPinModelId) return;
      if (row.dataset.modelId === draggedPinModelId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      ui.pricingBody.querySelectorAll(".pricing-row-drag-over").forEach((el) => {
        el.classList.remove("pricing-row-drag-over");
      });
      row.classList.add("pricing-row-drag-over");
    });

    ui.pricingBody.addEventListener("dragleave", (e) => {
      const row = e.target.closest(".pricing-row-pinned");
      if (row && !row.contains(e.relatedTarget)) {
        row.classList.remove("pricing-row-drag-over");
      }
    });

    ui.pricingBody.addEventListener("drop", (e) => {
      const row = e.target.closest(".pricing-row-pinned");
      if (!row) return;
      e.preventDefault();
      const targetId = row.dataset.modelId;
      const draggedId = draggedPinModelId || e.dataTransfer.getData("text/plain");
      row.classList.remove("pricing-row-drag-over");
      if (!draggedId || draggedId === targetId) return;
      reorderPricingModelPin(draggedId, targetId);
      persistPricingPins();
      renderPricing();
    });
  }
}

export function getEventPricingEstimate(event) {
  const resolved = resolveModelPricingDetailed(event.model, !!event.maxMode);
  if (!resolved) return null;
  const breakdown = estimateEventTheoreticalCost(event, resolved.entry, getEstimateOpts());
  return { entry: resolved.entry, variant: resolved.variant, breakdown };
}
