import type { UsageEvent, UsagePayload } from "./cursor-api";
import type { DashboardCurrency, DashboardLocale } from "./dashboard-locale";
import { formatOnDemandSpend } from "./currency-format";
import { getDurationLabel, t, tf } from "./i18n";
import type { UsageDuration } from "./model-breakdown";
import {
  formatOnDemandBreakdownFooter,
  getOnDemandProgressSegments,
  getOnDemandRatio,
  isOnDemandVisible,
  type OnDemandUsage,
} from "./on-demand";
import { buildGrokBotUsageMarkdown, buildPoolTodayPaceMarkdown, buildPoolUsageMarkdown } from "./pool-usage";
import { buildPoolUsageSeries } from "./pool-usage-series";

type IncludedRequestsUsage = UsagePayload["includedRequests"];

type ProgressBarRenderer = {
  markdown: (ratio: number) => string;
  html: (ratio: number) => string;
  segmentedHtml?: (segments: Array<{ ratio: number; opacity: number }>) => string;
  divider: () => string;
};

export const OPEN_DURATION_SETTING_COMMAND = "cursor-usage.openDurationSetting";

type SummaryColumn = {
  label: string;
  value: string;
  footer: string;
};

function formatIncludedValue(includedRequests: IncludedRequestsUsage): string {
  return `${includedRequests.used} / ${includedRequests.limit}`;
}

function buildSummaryTable(columns: SummaryColumn[], renderProgressBar: ProgressBarRenderer): string {
  if (columns.length === 1) {
    return [
      `<table width="100%" cellspacing="0" cellpadding="0">`,
      `  <tr><td width="100%"><sub>${columns[0]!.label}</sub></td></tr>`,
      `  <tr><td><strong>${columns[0]!.value}</strong></td></tr>`,
      `  <tr><td>${columns[0]!.footer}</td></tr>`,
      `</table>`,
      ``,
    ].join("\n");
  }

  return [
    `<table width="100%" cellspacing="0" cellpadding="0">`,
    `  <tr><td><sub>${columns[0]!.label}</sub></td><td width="2%" rowspan="3" valign="top">${renderProgressBar.divider()}</td><td><sub>${columns[1]!.label}</sub></td></tr>`,
    `  <tr><td><strong>${columns[0]!.value}</strong></td><td><strong>${columns[1]!.value}</strong></td></tr>`,
    `  <tr><td>${columns[0]!.footer}</td><td>${columns[1]!.footer}</td></tr>`,
    `</table>`,
    ``,
  ].join("\n");
}

function renderOnDemandFooter(
  onDemand: OnDemandUsage,
  renderProgressBar: ProgressBarRenderer,
  locale: DashboardLocale,
): string {
  const breakdownFooter = formatOnDemandBreakdownFooter(onDemand);
  const segments = getOnDemandProgressSegments(onDemand);
  if (segments && renderProgressBar.segmentedHtml) {
    const bar = renderProgressBar.segmentedHtml(segments);
    return breakdownFooter
      ? `${bar}<br/><sub>${breakdownFooter}</sub>`
      : bar;
  }

  const spendRatio = getOnDemandRatio(onDemand);
  if (spendRatio === null) {
    return breakdownFooter ? `<sub>${breakdownFooter}</sub>` : `<sub>${t(locale, "spendUnavailable")}</sub>`;
  }
  return renderProgressBar.html(spendRatio);
}

function buildSummaryColumns(
  includedRequests: IncludedRequestsUsage,
  onDemand: OnDemandUsage,
  renderProgressBar: ProgressBarRenderer,
  locale: DashboardLocale,
  currency: DashboardCurrency,
  showPremiumRequests: boolean,
): SummaryColumn[] {
  const columns: SummaryColumn[] = [];

  if (showPremiumRequests) {
    const reqRatio = includedRequests.limit > 0 ? includedRequests.used / includedRequests.limit : 0;
    columns.push({
      label: t(locale, "included"),
      value: formatIncludedValue(includedRequests),
      footer: renderProgressBar.html(reqRatio),
    });
  }

  if (!isOnDemandVisible(onDemand)) {
    return columns;
  }

  if (onDemand.state === "unlimited") {
    const segments = getOnDemandProgressSegments(onDemand);
    columns.push({
      label: t(locale, "onDemand"),
      value: formatOnDemandSpend(onDemand, currency, locale),
      footer: segments
        ? renderOnDemandFooter(onDemand, renderProgressBar, locale)
        : `<sub>${t(locale, "unlimited")}</sub>`,
    });
    return columns;
  }

  columns.push({
    label: t(locale, "onDemand"),
    value: formatOnDemandSpend(onDemand, currency, locale),
    footer: renderOnDemandFooter(onDemand, renderProgressBar, locale),
  });
  return columns;
}

export type UsageOverviewData = Pick<UsagePayload, "includedRequests" | "onDemand" | "poolUsage" | "grokBotUsage"> & {
  resetsAt?: string | null;
};

export function buildUsageOverviewMarkdown(
  data: UsageOverviewData,
  renderProgressBar: ProgressBarRenderer,
  locale: DashboardLocale,
  now = Date.now(),
  events: UsageEvent[] = [],
  currency: DashboardCurrency = "usd",
  showPremiumRequests = true,
): string {
  const { includedRequests, onDemand, poolUsage, grokBotUsage, resetsAt = null } = data;
  const summaryColumns = buildSummaryColumns(
    includedRequests,
    onDemand,
    renderProgressBar,
    locale,
    currency,
    showPremiumRequests,
  );
  let md = summaryColumns.length > 0
    ? buildSummaryTable(summaryColumns, renderProgressBar)
    : "";
  if (poolUsage) {
    md += buildPoolUsageMarkdown(poolUsage, renderProgressBar, locale, resetsAt ?? null, now);
    if (events.length > 0) {
      const series = buildPoolUsageSeries(events, poolUsage, resetsAt ?? null, now);
      if (series) {
        md += buildPoolTodayPaceMarkdown(series.todayAutoPace, series.todayApiPace, renderProgressBar, locale);
      }
    }
  }
  if (grokBotUsage) {
    md += buildGrokBotUsageMarkdown(grokBotUsage, renderProgressBar, locale);
  }
  return md;
}

export function buildUsageByModelHeadingMarkdown(duration: UsageDuration, locale: DashboardLocale): string {
  return `**${t(locale, "usageByModel")}** *(${getDurationLabel(duration, locale)})* &nbsp;[${t(locale, "change")}](command:${OPEN_DURATION_SETTING_COMMAND})\n\n`;
}
