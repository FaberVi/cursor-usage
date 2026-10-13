import * as vscode from "vscode";
import type { DailySpendRow, UsageEvent, UsagePayload } from "./cursor-api-types";
import { OPEN_DASHBOARD_COMMAND } from "./dashboard-panel";
import type { DashboardCurrency, DashboardLocale } from "./dashboard-locale";
import { formatOnDemandStatus } from "./currency-format";
import { isOnDemandVisible } from "./on-demand";
import { filterDashboardEvents } from "./dashboard-state";
import { formatTokens } from "./format";
import { formatResetCountdown, t } from "./i18n";
import {
  aggregateByModel,
  filterZeroTokenModels,
  formatDollarsFromCents,
  type ModelBreakdownSortBy,
  type SortOrder,
  type UsageDuration,
} from "./model-breakdown";
import { formatModelLabel } from "./model-labels";
import { formatStatusBarUsageText } from "./pool-usage";
import {
  buildUsageByModelHeadingMarkdown,
  buildUsageOverviewMarkdown,
  OPEN_DURATION_SETTING_COMMAND,
} from "./tooltip";
import { isIncludedQuotaExhausted, shouldShowPremiumRequestsQuota } from "./usage-display";
import { resolveConfiguredUsageDuration } from "./duration-options";
import {
  escapeHtml,
  progressBarHtml,
  progressBarMarkdown,
  segmentedProgressBarHtml,
  summaryDividerHtml,
} from "./status-bar-progress";

export type StatusBarConfig = {
  minimalMode: boolean;
  usageDuration: string;
  modelBreakdownSortBy: ModelBreakdownSortBy;
  modelBreakdownSortOrder: SortOrder;
  excludeZeroTokenModels: boolean;
};

export type StatusBarContext = {
  statusBarItem: vscode.StatusBarItem;
  locale: DashboardLocale;
  currency: DashboardCurrency;
  config: StatusBarConfig;
  lastEvents: UsageEvent[] | null;
  lastDailySpend: DailySpendRow[] | null;
  getDashboardEventFilter: () => Parameters<typeof filterDashboardEvents>[1];
  /** True while updateUsage (including background event sync) is in flight. */
  refreshing: boolean;
};

function statusBarLeadingIcon(refreshing: boolean): string {
  return refreshing ? "$(loading~spin)" : "$(pulse)";
}

function buildModelBreakdownTableMarkdown(
  rows: Array<{ model: string; totalTokens: number; requests: number; spendCents: number }>,
  tableWidth: number,
  locale: DashboardLocale,
  currency: DashboardCurrency,
): string {
  if (rows.length === 0) {
    return `*${t(locale, "noUsageInPeriod")}*\n\n`;
  }

  const lines = [
    `<table width="${tableWidth}" cellspacing="0" cellpadding="0">`,
    `  <tr>`,
    `    <th align="left" width="45%">${t(locale, "colModel")}</th>`,
    `    <th align="right" width="15%">${t(locale, "colRequests")}</th>`,
    `    <th align="right" width="20%">${t(locale, "colTokens")}</th>`,
    `    <th align="right" width="20%">${t(locale, "colSpend")}</th>`,
    `  </tr>`,
  ];

  for (const row of rows) {
    lines.push(
      `  <tr>` +
      `<td align="left">${escapeHtml(formatModelLabel(row.model))}</td>` +
      `<td align="right">${Math.round(row.requests)}</td>` +
      `<td align="right">${formatTokens(row.totalTokens)}</td>` +
      `<td align="right">${formatDollarsFromCents(row.spendCents, currency, locale)}</td>` +
      `</tr>`,
    );
  }

  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalSpendCents = rows.reduce((sum, row) => sum + row.spendCents, 0);
  lines.push(
    `  <tr>` +
    `<td align="left"><strong>${t(locale, "total")}</strong></td>` +
    `<td align="right"><strong>${Math.round(totalRequests)}</strong></td>` +
    `<td align="right"><strong>${formatTokens(totalTokens)}</strong></td>` +
    `<td align="right"><strong>${formatDollarsFromCents(totalSpendCents, currency, locale)}</strong></td>` +
    `</tr>`,
  );

  lines.push(`</table>`, ``);
  return lines.join("\n");
}

function formatOnDemandStatusBar(
  onDemand: UsagePayload["onDemand"],
  currency: DashboardCurrency,
  locale: DashboardLocale,
): string {
  return formatOnDemandStatus(onDemand, currency, locale);
}

export function updateStatusBar(data: UsagePayload, ctx: StatusBarContext): void {
  const { includedRequests, onDemand } = data;
  const { minimalMode } = ctx.config;
  const { locale, currency } = ctx;
  const showPremiumRequests = shouldShowPremiumRequestsQuota(data.planInfo, data.poolUsage);

  const quotaExhausted = isIncludedQuotaExhausted(data, showPremiumRequests);
  const onDemandVisible = isOnDemandVisible(onDemand);
  const icon = statusBarLeadingIcon(ctx.refreshing);

  if (minimalMode && quotaExhausted && onDemandVisible) {
    ctx.statusBarItem.text = `${icon} ${formatOnDemandStatusBar(onDemand, currency, locale)}`;
  } else {
    ctx.statusBarItem.text = `${icon} ${formatStatusBarUsageText(data, {
      onDemandVisible,
      showPremiumRequests,
      currency,
      locale,
    })}`;
  }

  const tooltip = new vscode.MarkdownString();
  tooltip.isTrusted = {
    enabledCommands: [OPEN_DASHBOARD_COMMAND, "cursor-usage.refresh", OPEN_DURATION_SETTING_COMMAND],
  };
  tooltip.supportThemeIcons = true;
  tooltip.supportHtml = true;

  const barW = 150;
  let md = `### $(pulse) ${t(locale, "title")}\n\n`;
  md += buildUsageOverviewMarkdown(
    { includedRequests, onDemand, poolUsage: data.poolUsage, grokBotUsage: data.grokBotUsage, resetsAt: data.resetsAt },
    {
      markdown: (ratio) => progressBarMarkdown(ratio, barW),
      html: (ratio) => progressBarHtml(ratio, barW),
      segmentedHtml: (segments) => segmentedProgressBarHtml(segments, barW),
      divider: () => summaryDividerHtml(),
    },
    locale,
    Date.now(),
    ctx.lastEvents ?? [],
    currency,
    showPremiumRequests,
  );
  md += `\n`;

  if (ctx.lastEvents && ctx.lastEvents.length > 0) {
    const usageDuration: UsageDuration = resolveConfiguredUsageDuration(
      ctx.config.usageDuration,
      Boolean(data.resetsAt),
    );
    const models = aggregateByModel(
      ctx.lastEvents,
      ctx.lastDailySpend ?? [],
      usageDuration,
      data.resetsAt,
      Date.now(),
      ctx.config.modelBreakdownSortBy,
      ctx.config.modelBreakdownSortOrder,
    );
    const filteredModels = filterZeroTokenModels(models, ctx.config.excludeZeroTokenModels);
    md += `<hr>\n\n`;
    md += buildUsageByModelHeadingMarkdown(usageDuration, locale);
    const modelTableWidth = barW * 2 + 2;
    md += buildModelBreakdownTableMarkdown(filteredModels, modelTableWidth, locale, currency);
  }

  if (data.resetsAt) {
    md += `<hr>\n\n`;
    md += `*${formatResetCountdown(data.resetsAt, locale)}*\n\n`;
  }

  md += `<hr>\n\n`;
  md += `[${t(locale, "openDashboard")}](command:${OPEN_DASHBOARD_COMMAND}) | [${t(locale, "refresh")}](command:cursor-usage.refresh)`;

  tooltip.appendMarkdown(md);
  ctx.statusBarItem.tooltip = tooltip;
}
