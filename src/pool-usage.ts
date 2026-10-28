import type { UsagePayload } from "./cursor-api";
import type { GrokBotUsage } from "./grok-bot-usage";
import type { DashboardCurrency, DashboardLocale } from "./dashboard-locale";
import { formatOnDemandStatus } from "./currency-format";
import { t, tf } from "./i18n";
import { computeRecommendedPoolUsage } from "./pool-usage-series";
import { formatDailyBudgetResetCountdown } from "./daily-budget-reset";

type ProgressBarRenderer = {
  html: (ratio: number) => string;
};

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

export function formatStatusBarUsageText(
  data: Pick<UsagePayload, "includedRequests" | "onDemand" | "poolUsage" | "grokBotUsage">,
  opts: {
    onDemandVisible: boolean;
    showPremiumRequests?: boolean;
    currency?: DashboardCurrency;
    locale?: DashboardLocale;
  },
): string {
  const currency = opts.currency ?? "usd";
  const locale = opts.locale ?? "en";
  const parts: string[] = [];

  if (opts.showPremiumRequests !== false) {
    parts.push(`${data.includedRequests.used}/${data.includedRequests.limit}`);
  }

  if (data.poolUsage) {
    parts.push(`${formatPercent(data.poolUsage.autoPercentUsed)}% ${t(locale, "poolFirstParty")}`);
    parts.push(`${formatPercent(data.poolUsage.apiPercentUsed)}% ${t(locale, "poolApi")}`);
  }

  if (data.grokBotUsage) {
    parts.push(`${formatPercent(data.grokBotUsage.percentUsed)}% ${t(locale, "grokBotWeeklyShort")}`);
  }

  if (opts.onDemandVisible) {
    parts.push(formatOnDemandStatus(data.onDemand, currency, locale));
  }

  return parts.join(", ");
}

export function buildPoolUsageMarkdown(
  poolUsage: NonNullable<UsagePayload["poolUsage"]>,
  renderProgressBar: ProgressBarRenderer,
  locale: DashboardLocale,
  resetsAt: string | null = null,
  now = Date.now(),
): string {
  const recommended = computeRecommendedPoolUsage(resetsAt, now);
  const rows = [
    [t(locale, "poolFirstParty"), poolUsage.autoPercentUsed, recommended?.autoRecommended ?? null],
    [t(locale, "poolApi"), poolUsage.apiPercentUsed, recommended?.apiRecommended ?? null],
  ] as const;

  const bodyRows = rows.map(([label, used, target]) => {
    const ratio = Math.min(Math.max(used / 100, 0), 1);
    const usedText = formatPercent(used);
    const sub =
      target != null
        ? `${usedText}% / ${formatPercent(target)}% ${t(locale, "poolTargetShort")}`
        : `${usedText}%`;
    return [
      `  <tr>`,
      `    <td width="18%"><sub>${label}</sub></td>`,
      `    <td><sub>${sub}</sub> ${renderProgressBar.html(ratio)}</td>`,
      `  </tr>`,
    ].join("\n");
  });

  const intro = recommended
    ? t(locale, "evenSpreadUntilReset")
    : t(locale, "includedPool");

  return [
    `<table width="100%" cellspacing="0" cellpadding="0">`,
    `  <tr><td colspan="2"><sub>${t(locale, "includedPool")}</sub></td></tr>`,
    `  <tr><td colspan="2"><strong>${tf(locale, "totalUsed", { pct: formatPercent(poolUsage.totalPercentUsed) })}</strong></td></tr>`,
    `  <tr><td colspan="2"><sub>${intro}</sub></td></tr>`,
    bodyRows.join("\n"),
    `</table>`,
    ``,
  ].join("\n");
}

export function buildGrokBotUsageMarkdown(
  grokBotUsage: GrokBotUsage,
  renderProgressBar: ProgressBarRenderer,
  locale: DashboardLocale,
): string {
  const ratio = Math.min(Math.max(grokBotUsage.percentUsed / 100, 0), 1);
  return [
    `<table width="100%" cellspacing="0" cellpadding="0">`,
    `  <tr><td colspan="2"><sub>${t(locale, "grokBotWeekly")}</sub></td></tr>`,
    `  <tr>`,
    `    <td width="18%"><sub>${t(locale, "grokBotWeekly")}</sub></td>`,
    `    <td><sub>${tf(locale, "grokBotWeeklyUsed", { pct: formatPercent(grokBotUsage.percentUsed) })}</sub> ${renderProgressBar.html(ratio)}</td>`,
    `  </tr>`,
    `</table>`,
    ``,
  ].join("\n");
}

export function buildPoolTodayPaceMarkdown(
  autoPace: PoolDayPace | null,
  apiPace: PoolDayPace | null,
  renderProgressBar: ProgressBarRenderer,
  locale: DashboardLocale,
): string {
  if (!autoPace && !apiPace) return "";

  const rows: string[] = [];
  for (const [label, pace] of [
    [t(locale, "poolFirstParty"), autoPace],
    [t(locale, "poolApi"), apiPace],
  ] as const) {
    if (!pace) continue;
    const usedRatio = pace.exhausted
      ? 1
      : pace.allowance > 0
        ? Math.min(pace.used / pace.allowance, 1)
        : 0;
    rows.push(
      `  <tr>`,
      `    <td width="18%"><sub>${label}</sub></td>`,
      `    <td><sub>${tf(locale, "budgetPct", { pct: formatPercent(pace.allowance) })}</sub> ${renderProgressBar.html(usedRatio)} <sub>${formatBudgetStatus(pace, locale)}</sub></td>`,
      `  </tr>`,
    );
  }

  return [
    `<table width="100%" cellspacing="0" cellpadding="0">`,
    `  <tr><td colspan="2"><sub>${t(locale, "dailyBudget")}</sub></td></tr>`,
    `  <tr><td colspan="2"><sub>${t(locale, "evenSpreadUntilReset")}</sub></td></tr>`,
    `  <tr><td colspan="2"><sub>${formatDailyBudgetResetCountdown(locale)}</sub></td></tr>`,
    ...rows,
    `</table>`,
    ``,
  ].join("\n");
}

function formatBudgetStatus(pace: PoolDayPace, locale: DashboardLocale): string {
  if (pace.exhausted) return t(locale, "alreadyExhausted");
  if (Math.abs(pace.residual) < 0.05) return t(locale, "onBudget");
  if (pace.residual > 0) return tf(locale, "leftToday", { pct: formatPercent(pace.residual) });
  return tf(locale, "overBudget", { pct: formatPercent(Math.abs(pace.residual)) });
}
