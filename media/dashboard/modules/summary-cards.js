import { refs, ui } from "./core.js";
import { cardHelpText, getDateLocale, t } from "./i18n.js";
import {
  escapeHtml,
  formatPercent,
  formatPlanPriceText,
  rangeNow,
} from "./format.js";

const DAY_MS = 86_400_000;

function getBillingCycleMeta(resetAtIso) {
  if (!resetAtIso) return null;
  const reset = new Date(resetAtIso);
  if (Number.isNaN(reset.getTime())) return null;
  const cycleStart = new Date(resetAtIso);
  cycleStart.setMonth(cycleStart.getMonth() - 1);
  const startMs = cycleStart.getTime();
  const resetMs = reset.getTime();
  const now = rangeNow();
  const totalMs = resetMs - startMs;
  if (totalMs <= 0) return null;
  const elapsedMs = Math.max(0, now - startMs);
  const pct = Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100));
  const daysLeft = Math.max(0, Math.ceil((resetMs - now) / DAY_MS));
  return { pct, daysLeft, resetMs };
}

function formatBillingCycleValue(daysLeft) {
  const unit = daysLeft === 1 ? t("billingDayOne") : t("billingDayMany");
  return daysLeft + " " + unit;
}

export function renderBillingCycleCard(resetAtIso) {
  const meta = getBillingCycleMeta(resetAtIso);
  if (!meta) {
    return (
      '<div class="card card-billing">' +
        cardLabel(t("billingCycle"), "billingCycle") +
        '<div class="card-value muted">' + escapeHtml(t("billingCycleUnknown")) + "</div>" +
      "</div>"
    );
  }

  const resetFormatted = new Date(meta.resetMs).toLocaleDateString(getDateLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const footerText = t("billingResets") + " " + resetFormatted + " · " + formatPercent(meta.pct) + "% " + t("cycleElapsed");

  return (
    '<div class="card card-billing">' +
      cardLabel(t("billingCycle"), "billingCycle") +
      '<div class="card-value">' + escapeHtml(formatBillingCycleValue(meta.daysLeft)) +
        '<span class="card-value-sub muted"> ' + escapeHtml(t("billingCycleUntilReset")) + "</span></div>" +
      '<div class="progress"><div style="width:' + Math.round(meta.pct) + '%"></div></div>' +
      '<div class="card-footer">' + escapeHtml(footerText) + "</div>" +
    "</div>"
  );
}

export function renderPlanBanner() {
  if (!ui.planBanner) return;
  const planInfo = refs.state?.data?.planInfo;
  if (!planInfo) {
    ui.planBanner.innerHTML = "";
    ui.planBanner.classList.add("hidden");
    return;
  }

  const badgeLabel = planInfo.planKind === "enterprise"
    ? t("enterprise")
    : planInfo.accountType === "team"
      ? t("teams")
      : t("personal");
  const badgeClass = planInfo.accountType === "team" ? "plan-badge-team" : "plan-badge-personal";
  ui.planBanner.classList.remove("hidden");
  ui.planBanner.innerHTML =
    '<div class="plan-banner-inner">' +
      '<span class="plan-kicker muted">' + escapeHtml(t("currentPlan")) + "</span>" +
      '<div class="plan-banner-title">' +
        '<span class="plan-badge ' + badgeClass + '">' + escapeHtml(badgeLabel) + "</span>" +
        '<span class="plan-tier">' + escapeHtml(planInfo.tier) + "</span>" +
        (planInfo.priceLabel
          ? '<span class="plan-price muted">' + escapeHtml(formatPlanPriceText(planInfo.priceLabel)) + "</span>"
          : "") +
      "</div>" +
      '<span class="plan-caption muted">' + escapeHtml(formatPlanPriceText(planInfo.displayName)) + "</span>" +
      (planInfo.billingProgram === "x_subscription"
        ? '<p class="plan-x-sub muted small"><a href="https://cursor.com/help/the-x-subscription/overview" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(t("planXSubscriptionLink")) +
          "</a> · " +
          escapeHtml(t("planXSubscriptionHint")) +
          "</p>"
        : "") +
    "</div>";
}

function cardHelpButton(helpKey) {
  const text = cardHelpText(helpKey);
  if (!text) return "";
  return (
    '<span class="card-help-wrap">' +
      '<button type="button" class="card-help" aria-label="' + escapeHtml(t("cardHelpAria")) + '">?</button>' +
      '<span class="card-help-tooltip" role="tooltip">' + escapeHtml(text) + "</span>" +
    "</span>"
  );
}

export { cardHelpButton };

export function cardLabel(title, helpKey) {
  return '<div class="card-label">' + escapeHtml(title) + cardHelpButton(helpKey) + "</div>";
}
