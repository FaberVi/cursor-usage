/** Conversation message panel opened from the activity list. */
import { refs, ui, vscode } from "./core.js";
import { colorForModel } from "./chart.js";
import { abbreviateConversationId } from "../../../src/conversation-aggregate.ts";
import {
  escapeHtml,
  eventSpendDollars,
  formatDateTime,
  formatModelLabel,
  formatRequests,
  formatCents,
  formatTokens,
  eventRequestCount,
  eventTokenCount,
} from "./format.js";
import { t } from "./i18n.js";
import { NO_CONVERSATION_KEY, renderConversationsTable } from "./conversations.js";

export function applyConversationMessages(conversationId, messages, error) {
  if (!ui.eventDetailBody || !conversationId) return;
  const idKey = conversationId;
  if (refs.selectedConversationId !== idKey) return;

  const container = ui.eventDetailBody.querySelector("#conversation-messages-list");
  const section = ui.eventDetailBody.querySelector("#conversation-messages-section");
  if (!container || !section) return;

  section.querySelector(".conv-messages-loading")?.remove();

  if (error) {
    container.innerHTML = '<p class="muted small">' + escapeHtml(t("convMessagesError")) + "</p>";
    return;
  }

  if (!messages?.length) {
    container.innerHTML = '<p class="muted small">' + escapeHtml(t("convMessagesEmpty")) + "</p>";
    return;
  }

  container.innerHTML = messages.map((msg) => {
    const roleLabel = msg.role === "user" ? t("msgRoleUser") : t("msgRoleAssistant");
    const time = msg.createdAt ? formatDateTime(msg.createdAt) : "";
    const modelLabel = msg.model ? formatModelLabel(msg.model) : "";
    const modelTitle = msg.modelEstimated ? t("msgModelEstimated") : t("colModel");
    const modelHtml = modelLabel
      ? '<span class="conv-message-model' + (msg.modelEstimated ? " estimated" : "") + '" title="' + escapeHtml(modelTitle) + '">' + escapeHtml(modelLabel) + "</span>"
      : "";
    return '<article class="conv-message conv-message-' + escapeHtml(msg.role) + '">' +
      '<header class="conv-message-header"><div class="conv-message-meta"><strong>' + escapeHtml(roleLabel) + "</strong>" + modelHtml + "</div>" +
      (time ? '<span class="muted small">' + escapeHtml(time) + "</span>" : "") +
      "</header>" +
      '<div class="conv-message-text">' + escapeHtml(msg.text) + "</div>" +
    "</article>";
  }).join("");
}

export function showConversationDetail(row) {
  if (!ui.eventDetailOverlay || !ui.eventDetailBody || !row) return;
  refs.selectedConversationId = row.conversationId ?? NO_CONVERSATION_KEY;
  refs.selectedEventKey = null;
  renderConversationsTable();

  ui.eventDetailTitle.textContent = row.label;
  const rangeText = formatDateTime(row.firstTimestamp) + " \u2013 " + formatDateTime(row.lastTimestamp);
  const idLine = row.conversationId
    ? abbreviateConversationId(row.conversationId)
    : t("noConversation");
  ui.eventDetailSubtitle.textContent = idLine + " \u00b7 " + rangeText;

  const eventRows = row.events.map((event) => {
    const color = colorForModel(event.model || "default");
    const eventKey = event.eventKey ?? "";
    return '<tr class="conversation-event-row" data-detail-event-key="' + escapeHtml(eventKey) + '" style="box-shadow:inset 3px 0 0 ' + color + ';">' +
      "<td>" + formatDateTime(event.timestamp) + "</td>" +
      "<td>" + escapeHtml(formatModelLabel(event.model)) + "</td>" +
      "<td>" + escapeHtml(event.kind) + "</td>" +
      '<td class="num">' + formatTokens(eventTokenCount(event)) + "</td>" +
      '<td class="num">' + formatRequests(eventRequestCount(event)) + "</td>" +
      '<td class="num">' + formatCents(Math.round(eventSpendDollars(event) * 100)) + "</td>" +
    "</tr>";
  }).join("");

  const messagesSection = row.conversationId
    ? '<div class="event-detail-section" id="conversation-messages-section"><h3>' + escapeHtml(t("convMessages")) +
      '</h3><p class="muted small conv-messages-loading">' + escapeHtml(t("convMessagesLoading")) +
      '</p><div id="conversation-messages-list" class="conversation-messages-list"></div></div>'
    : "";

  ui.eventDetailBody.innerHTML =
    '<div class="event-detail-grid">' +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("convFirstActive")) + '</span><span class="value">' + formatDateTime(row.firstTimestamp) + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("convLastActive")) + '</span><span class="value">' + formatDateTime(row.lastTimestamp) + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("colCalls")) + '</span><span class="value">' + row.eventCount.toLocaleString() + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("colTokens")) + '</span><span class="value">' + formatTokens(row.totalTokens) + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("colRequests")) + '</span><span class="value">' + formatRequests(row.requests) + "</span></div>" +
      '<div class="event-detail-stat"><span class="label">' + escapeHtml(t("colSpend")) + '</span><span class="value">' + formatCents(row.spendCents) + "</span></div>" +
    "</div>" +
    '<div class="event-detail-section"><h3>' + escapeHtml(t("colModels")) + "</h3><p>" + escapeHtml(row.modelsLabel) + "</p></div>" +
    messagesSection +
    '<div class="event-detail-section"><h3>' + escapeHtml(t("convEventList")) + '</h3><p class="muted small">' + escapeHtml(t("convClickEvent")) + "</p>" +
    '<table class="detail-events-table"><thead><tr>' +
      "<th>" + escapeHtml(t("colDate")) + "</th>" +
      "<th>" + escapeHtml(t("colModel")) + "</th>" +
      "<th>" + escapeHtml(t("colType")) + "</th>" +
      "<th class=\"num\">" + escapeHtml(t("colTokens")) + "</th>" +
      "<th class=\"num\">" + escapeHtml(t("colRequests")) + "</th>" +
      "<th class=\"num\">" + escapeHtml(t("colSpend")) + "</th>" +
    "</tr></thead><tbody>" + eventRows + "</tbody></table></div>";

  ui.eventDetailOverlay.classList.remove("hidden");
  ui.eventDetailOverlay.setAttribute("aria-hidden", "false");
  ui.eventDetailClose?.removeAttribute("tabindex");
  ui.eventDetailClose?.focus();

  if (row.conversationId) {
    vscode.postMessage({ type: "getConversationMessages", conversationId: row.conversationId });
  }
}

export function closeConversationDetail() {
  refs.selectedConversationId = null;
  renderConversationsTable();
}
