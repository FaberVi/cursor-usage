import { DAY_MS, local, refs, ui } from "./core.js";
import { getDateLocale, t } from "./i18n.js";
import { getBillingCycleCutoff } from "../../../src/cursor-api-utils.ts";
import { DEFAULT_EUR_USD_RATE } from "../../../src/dashboard-locale.ts";
import { eventRequestCount, eventTokenCount } from "../../../src/cursor-usage-parsing.ts";
import { startOfUtcDay } from "../../../src/utc-day.ts";

function eurPerUsd() {
  const fromState = refs.state?.eurPerUsd;
  if (typeof fromState === "number" && Number.isFinite(fromState) && fromState > 0) return fromState;
  return DEFAULT_EUR_USD_RATE;
}

export { startOfUtcDay };

export function getDurationCutoff(range, resetAtIso, now) {
  if (range === "billingCycle") {
    return getBillingCycleCutoff(resetAtIso, now);
  }
  if (range === "1d") {
    return startOfUtcDay(now);
  }
  const map = { "7d": 7, "30d": 30 };
  return now - (map[range] || 30) * DAY_MS;
}

export function matchesUsageFilter(event, filter) {
  if (filter === "all") return true;
  if (filter === "included") return event.kind === "Included";
  return event.kind === "On-Demand";
}

export function formatTokens(n) {
  if (!Number.isFinite(n) || n === 0) return "0";
  const trim = (v) => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (n >= 1e9) return trim(n / 1e9) + "B";
  if (n >= 1e6) return trim(n / 1e6) + "M";
  if (n >= 1e3) return trim(n / 1e3) + "K";
  return String(Math.round(n));
}

export function getActiveCurrency() {
  const selected = ui.currencySelect?.value;
  if (selected === "eur" || selected === "usd") return selected;
  return local.currency === "eur" ? "eur" : "usd";
}

export function formatMoney(amountUsd, options = {}) {
  const locale = getDateLocale();
  const minFrac = options.minimumFractionDigits ?? 2;
  const maxFrac = options.maximumFractionDigits ?? 2;
  if (getActiveCurrency() === "eur") {
    const eur = (amountUsd || 0) * eurPerUsd();
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    }).format(eur);
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  }).format(amountUsd || 0);
}

export function formatDollars(n) {
  return formatMoney(n);
}

export function formatCents(cents) {
  if (!Number.isFinite(cents) || cents === 0) return formatMoney(0);
  const dollars = cents / 100;
  if (dollars > 0 && dollars < 1) {
    return formatMoney(dollars, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }
  return formatMoney(dollars);
}

export function formatPlanPriceText(text) {
  if (!text || typeof text !== "string" || getActiveCurrency() !== "eur") return text;
  return text.replace(/\$(\d+(?:\.\d{1,2})?)/g, (_, raw) => formatMoney(Number(raw)));
}

export function toCsvMoney(amountUsd) {
  if (!Number.isFinite(amountUsd)) return "";
  if (getActiveCurrency() === "eur") return (amountUsd * eurPerUsd()).toFixed(4);
  return amountUsd.toFixed(4);
}

export function toMillis(ts) {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string" && ts !== "") {
    const n = Number(ts);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

export function formatDateTime(ts) {
  const d = new Date(toMillis(ts));
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleString(getDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatFullDateTime(ts) {
  const d = new Date(toMillis(ts));
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleString(getDateLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatTokenCount(n) {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString();
}

export function formatPerPage(size) {
  return t("perPage").replace("{size}", String(size));
}

export function formatUpdatedAt(isoOrMs) {
  const time = new Date(isoOrMs).toLocaleTimeString(getDateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: local.locale !== "it",
  });
  if (local.locale === "it") {
    return t("updated") + " alle " + time;
  }
  return t("updated") + " " + time;
}

export function tokenField(event, key) {
  return event[key] || 0;
}

export function pctOf(part, total) {
  if (!total) return "0%";
  return formatPercent((part / total) * 100) + "%";
}

export function ratioText(numerator, denominator) {
  if (!denominator) return "\u2014";
  return formatPercent((numerator / denominator) * 100) + "%";
}

export function formatRequests(n) {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(1);
}

export { eventRequestCount, eventTokenCount };

export function isOnDemandEvent(event) {
  return event.kind === "On-Demand";
}

export function isIncludedEvent(event) {
  return event.kind === "Included";
}

export function eventSpendDollars(event) {
  if (refs.state && refs.state.quotaAwareEventDisplay && !isOnDemandEvent(event)) return 0;
  return (event.spendCents || 0) / 100;
}

/** Spend axis for the usage chart: billable charges, or token cost when included usage has no charge. */
export function chartSpendDollars(event) {
  const billable = eventSpendDollars(event);
  if (billable > 0) return billable;
  if (refs.state?.quotaAwareEventDisplay && isIncludedEvent(event)) {
    const tokenCost = (event.tokenCostCents || 0) / 100;
    if (tokenCost > 0) return tokenCost;
  }
  return 0;
}

export function stateGeneratedAt() {
  const generatedAt = refs.state?.generatedAt;
  return Number.isFinite(generatedAt) && generatedAt > 0 ? generatedAt : Date.now();
}

/** Live "now" for range filters: never before last data refresh. */
export function rangeNow() {
  return Math.max(Date.now(), stateGeneratedAt());
}

export function formatRangePeriod(range, resetAtIso, now = rangeNow()) {
  if (range === "1d") return t("range1d");
  const cutoff = getDurationCutoff(range, resetAtIso, now);
  const start = new Date(startOfUtcDay(cutoff));
  const end = new Date(startOfUtcDay(now));
  const locale = getDateLocale();
  const fmt = (d) =>
    d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  if (range === "billingCycle" && resetAtIso) {
    const reset = new Date(resetAtIso);
    if (!Number.isNaN(reset.getTime())) {
      const cycleEnd = new Date(startOfUtcDay(reset.getTime() - DAY_MS));
      if (cycleEnd > end) return fmt(start) + " – " + fmt(cycleEnd);
    }
  }
  return fmt(start) + " – " + fmt(end);
}

export function metricLabel(metric) {
  if (metric === "spend") return t("metricSpend");
  if (metric === "requests") return t("metricRequests");
  return t("metricTokens");
}

export function formatChartMetricValue(value, metric) {
  if (metric === "spend") return formatDollars(value);
  if (metric === "requests") return formatRequests(value);
  return formatTokens(value);
}

export function eventRequestsText(event) {
  if (refs.state && refs.state.quotaAwareEventDisplay && !isIncludedEvent(event)) return "\u2014";
  return formatRequests(eventRequestCount(event));
}

export function eventSpendText(event) {
  if (refs.state && refs.state.quotaAwareEventDisplay && !isOnDemandEvent(event)) return "\u2014";
  return formatDollars(eventSpendDollars(event));
}

/** Aggregated billable spend for tables: em dash when nothing was charged (included pool usage). */
export function formatBillableSpendCents(cents) {
  if (!Number.isFinite(cents) || cents <= 0) {
    return refs.state?.quotaAwareEventDisplay ? "\u2014" : formatCents(0);
  }
  return formatCents(cents);
}

export function formatDayLabel(dayMs) {
  return new Date(dayMs).toLocaleDateString(getDateLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatResetCountdown(iso) {
  if (!iso) return "";
  const reset = new Date(iso);
  const days = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / DAY_MS));
  const formatted = reset.toLocaleDateString(getDateLocale(), { month: "short", day: "numeric", year: "numeric" });
  const dayLabel = days === 1 ? t("billingDayOne") : t("billingDayMany");
  return t("resetIn") + " " + days + " " + dayLabel + " " + t("resetOn") + " " + formatted;
}

export function setActiveRangeButton() {
  document.querySelectorAll("[data-range-selector]").forEach((selector) => {
    const scope = selector.dataset.rangeScope || "chart";
    const activeRange = scope === "breakdown" ? local.breakdownRange : local.range;
    selector.querySelectorAll("button[data-range]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.range === activeRange);
    });
  });
}

export function formatModelLabel(model) {
  if (model === "default") return t("modelAuto");
  return model;
}

export function formatPercent(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function rangeLabelFor(range) {
  if (range === "1d") return t("range1d");
  if (range === "7d") return t("range7d");
  if (range === "30d") return t("range30d");
  return t("rangeBilling");
}

export function rangeLabel() {
  return rangeLabelFor(local.range);
}

export function breakdownRangeLabel() {
  return rangeLabelFor(local.breakdownRange);
}
