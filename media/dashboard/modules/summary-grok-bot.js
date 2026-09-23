import { cardHelpButton, cardLabel } from "./summary-cards.js";
import { t } from "./i18n.js";
import { escapeHtml, formatPercent, formatResetCountdown } from "./format.js";

export function renderGrokBotUsageCard(grokBotUsage) {
  const pct = Math.min(Math.max(grokBotUsage.percentUsed, 0), 100);
  const resetFooter = grokBotUsage.resetsAtIso
    ? formatResetCountdown(grokBotUsage.resetsAtIso)
    : t("grokBotWeeklyResetUnknown");

  return (
    '<div class="card card-grok-bot">' +
      cardLabel(t("grokBotWeekly"), "grokBotWeekly") +
      '<div class="card-value">' + formatPercent(pct) + "% " + escapeHtml(t("grokBotWeeklyUsed")) + "</div>" +
      '<div class="progress grok-bot-progress"><div style="width:' + pct + '%"></div></div>' +
      '<p class="muted small card-grok-bot-desc">' + escapeHtml(t("grokBotWeeklyDesc")) + "</p>" +
      '<div class="card-footer">' + escapeHtml(resetFooter) + "</div>" +
    "</div>"
  );
}
