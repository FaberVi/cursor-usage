import { local, refs, ui } from "./core.js";
import {
  escapeHtml,
  eventSpendDollars,
  eventRequestCount,
  eventTokenCount,
  formatModelLabel,
  getActiveCurrency,
  isIncludedEvent,
  isOnDemandEvent,
  toCsvMoney,
  toMillis,
  tokenField,
} from "./format.js";
import { t } from "./i18n.js";
import { getSortedEvents, getSortedGrokBotEvents } from "./tables-events.js";

function csvCell(v) {
  const s = String(v);
  const safe = /^\s*[=+\-@]/.test(s) ? "'" + s : s;
  if (/[",\n]/.test(safe)) return '"' + safe.replace(/"/g, '""') + '"';
  return safe;
}

export function exportCsv() {
  const events = local.activityTab === "grokBot" ? getSortedGrokBotEvents() : getSortedEvents();
  const spendCol = getActiveCurrency() === "eur" ? "SpendEUR" : "SpendUSD";
  const tokenCostCol = getActiveCurrency() === "eur" ? "TokenCostEUR" : "TokenCostUSD";
  const feeCol = getActiveCurrency() === "eur" ? "CursorFeeEUR" : "CursorFeeUSD";
  const header = ["Date", "Type", "Model", "MaxMode", "Tokens", "InputTokens", "OutputTokens", "CacheWrite", "CacheRead", "Requests", spendCol, tokenCostCol, feeCol];
  const lines = [header.join(",")];
  for (const e of events) {
    const ts = toMillis(e.timestamp);
    const dateStr = Number.isFinite(ts) ? new Date(ts).toISOString() : "";
    const row = [
      dateStr,
      e.kind,
      formatModelLabel(e.model),
      e.maxMode ? "true" : "false",
      eventTokenCount(e),
      tokenField(e, "inputTokens"),
      tokenField(e, "outputTokens"),
      tokenField(e, "cacheWriteTokens"),
      tokenField(e, "cacheReadTokens"),
      refs.state && refs.state.quotaAwareEventDisplay && !isIncludedEvent(e) ? "" : eventRequestCount(e),
      refs.state && refs.state.quotaAwareEventDisplay && !isOnDemandEvent(e) ? "" : toCsvMoney(eventSpendDollars(e)),
      toCsvMoney((e.tokenCostCents || 0) / 100),
      toCsvMoney((e.cursorTokenFee || 0) / 100),
    ].map(csvCell).join(",");
    lines.push(row);
  }
  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const archive = local.activityTab === "grokBot" ? "grok-bot-" : "";
  a.download = "cursor-usage-" + archive + local.range + "-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function applyTeamMemberConstraints() {
  // Reserved for plan-specific chart/table constraints.
}

function normalizeNotice(entry) {
  if (!entry) return null;
  if (typeof entry === "string") {
    const message = entry.trim();
    return message ? { message, detail: null } : null;
  }
  if (typeof entry === "object" && typeof entry.message === "string") {
    const message = entry.message.trim();
    if (!message) return null;
    const detail = typeof entry.detail === "string" && entry.detail.trim() ? entry.detail.trim() : null;
    return { message, detail };
  }
  return null;
}

function bannerDetailButton(detail) {
  if (!detail) return "";
  return (
    '<span class="card-help-wrap banner-help-wrap">' +
      '<button type="button" class="card-help banner-help" aria-label="' +
      escapeHtml(t("bannerDetailAria")) +
      '">i</button>' +
      '<span class="card-help-tooltip banner-help-tooltip" role="tooltip">' +
      escapeHtml(detail) +
      "</span>" +
    "</span>"
  );
}

function renderBanner(el, message, detail) {
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.innerHTML =
    '<span class="banner-message">' + escapeHtml(message) + "</span>" + bannerDetailButton(detail);
  el.classList.remove("hidden");
}

export function showError(message, detail) {
  if (message && typeof message === "object" && message.message) {
    renderBanner(ui.errorBanner, message.message, message.detail ?? null);
    return;
  }
  const detailText = typeof detail === "string" && detail.trim() ? detail.trim() : null;
  renderBanner(ui.errorBanner, message, detailText);
}

export function showWarnings(warnings) {
  if (!ui.warningBanner) return;
  const list = Array.isArray(warnings)
    ? warnings.map(normalizeNotice).filter((w) => w !== null)
    : [];
  if (list.length === 0) {
    ui.warningBanner.textContent = "";
    ui.warningBanner.classList.add("hidden");
    return;
  }
  const message = list.map((w) => w.message).join("\n");
  const detailParts = list
    .filter((w) => w.detail)
    .map((w) => (list.length > 1 ? `${w.message}\n${w.detail}` : w.detail));
  const detail = detailParts.length > 0 ? detailParts.join("\n\n") : null;
  renderBanner(ui.warningBanner, message, detail);
}
