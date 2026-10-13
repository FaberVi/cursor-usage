import {
  EVENTS_PAGE_SIZES,
  local,
  paginateList,
  persistLocal,
  refs,
  ui,
  vscode,
} from "./core.js";
import { colorForModel, tintColor } from "./chart.js";
import {
  abbreviateConversationId,
  aggregateConversations,
} from "../../../src/conversation-aggregate.ts";
import {
  escapeHtml,
  formatDateTime,
  formatModelLabel,
  formatPerPage,
  formatRequests,
  formatCents,
  formatTokens,
  getDurationCutoff,
  rangeNow,
} from "./format.js";
import { t } from "./i18n.js";
import { renderTable, renderGrokBotTable, showEventDetail, findVisibleEvent } from "./tables.js";
import {
  applyConversationMessages,
  closeConversationDetail,
  showConversationDetail,
} from "./conversation-detail.js";

export const NO_CONVERSATION_KEY = "__none__";

export function getSortedConversations() {
  if (!refs.state) return [];
  const cutoff = getDurationCutoff(local.range, refs.state.resetsAt, rangeNow());
  const rows = aggregateConversations(refs.state.events, {
    cutoff,
    usageFilter: local.usageFilter,
    titles: refs.state.conversationTitles ?? {},
    previewTitles: local.conversationPreview,
    locale: local.locale === "it" ? "it" : "en",
    noConversationLabel: t("noConversation"),
    quotaAwareEventDisplay: refs.state.quotaAwareEventDisplay !== false,
  });
  const dir = local.conversationSortOrder === "asc" ? 1 : -1;
  const key = local.conversationSortKey;
  return rows.sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === "lastTimestamp" || key === "firstTimestamp") {
      av = Number(av);
      bv = Number(bv);
    } else if (key === "models") {
      av = a.modelsLabel;
      bv = b.modelsLabel;
    }
    const an = typeof av === "number" ? av : Number(av);
    const bn = typeof bv === "number" ? bv : Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function renderConversationRow(row) {
  const color = colorForModel(row.models[0] || "default");
  const rowStyle = "background:" + tintColor(color, 0.10) + ";box-shadow:inset 3px 0 0 " + color + ";";
  const idKey = row.conversationId ?? NO_CONVERSATION_KEY;
  const selected = refs.selectedConversationId === idKey ? " selected" : "";
  const subtitle = row.conversationId && local.conversationPreview && row.title
    ? '<div class="muted small">' + escapeHtml(abbreviateConversationId(row.conversationId)) + "</div>"
    : "";
  return '<tr class="conversation-row conversation-row-clickable' + selected + '" data-conversation-id="' + escapeHtml(idKey) + '" style="' + rowStyle + '" title="' + escapeHtml(t("convClickEvent")) + '">' +
    "<td><strong>" + escapeHtml(row.label) + "</strong>" + subtitle + "</td>" +
    "<td>" + formatDateTime(row.lastTimestamp) + "</td>" +
    "<td>" + escapeHtml(row.modelsLabel) + "</td>" +
    '<td class="num">' + row.eventCount.toLocaleString() + "</td>" +
    '<td class="num">' + formatTokens(row.totalTokens) + "</td>" +
    '<td class="num">' + formatRequests(row.requests) + "</td>" +
    '<td class="num">' + formatCents(row.spendCents) + "</td>" +
  "</tr>";
}

function renderConversationsPagination(paged) {
  if (!ui.conversationsPagination) return;
  if (paged.totalItems === 0) {
    ui.conversationsPagination.innerHTML = "";
    return;
  }

  const showingStart = paged.startIndex + 1;
  const showingEnd = paged.endIndex;
  const sizeOptions = EVENTS_PAGE_SIZES.map((size) =>
    '<option value="' + size + '"' + (size === local.conversationsPageSize ? " selected" : "") + ">" + formatPerPage(size) + "</option>"
  ).join("");
  const atFirst = paged.page <= 1;
  const atLast = paged.page >= paged.totalPages;

  ui.conversationsPagination.innerHTML =
    '<span class="pagination-info">' + t("showing") + " " +
      showingStart.toLocaleString() + "\u2013" + showingEnd.toLocaleString() +
      " " + t("of") + " " + paged.totalItems.toLocaleString() + " " + (paged.totalItems === 1 ? t("conversationOne") : t("conversationMany")) +
    "</span>" +
    '<div class="pagination-controls">' +
      '<select id="conversations-page-size" class="pagination-size" aria-label="' + escapeHtml(t("conversationsPerPage")) + '">' + sizeOptions + "</select>" +
      '<button type="button" data-action="first"' + (atFirst ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pageFirst")) + '">\u00ab</button>' +
      '<button type="button" data-action="prev"' + (atFirst ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pagePrev")) + '">\u2039</button>' +
      '<span class="pagination-page">' + paged.page + " / " + paged.totalPages + "</span>" +
      '<button type="button" data-action="next"' + (atLast ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pageNext")) + '">\u203a</button>' +
      '<button type="button" data-action="last"' + (atLast ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pageLast")) + '">\u00bb</button>' +
    "</div>";
}

export function renderConversationsTable() {
  if (!ui.conversationsBody) return;
  const rows = getSortedConversations();
  const paged = paginateList(rows, local.conversationsPage, local.conversationsPageSize);

  if (paged.page !== local.conversationsPage) {
    local.conversationsPage = paged.page;
    persistLocal();
  }

  if (ui.conversationsHead) {
    ui.conversationsHead.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === local.conversationSortKey) {
        th.classList.add(local.conversationSortOrder === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  if (rows.length === 0) {
    ui.conversationsBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px;" class="muted">' + escapeHtml(t("noConversationsInRange")) + "</td></tr>";
    if (ui.conversationsPagination) ui.conversationsPagination.innerHTML = "";
    return;
  }

  ui.conversationsBody.innerHTML = paged.items.map((row) => renderConversationRow(row)).join("");
  renderConversationsPagination(paged);
}

export function updatePreviewLoading(on) {
  if (!ui.conversationPreviewBtn) return;
  ui.conversationPreviewBtn.disabled = !!on;
  ui.conversationPreviewBtn.textContent = on ? t("previewLoading") : t("previewTitles");
}

export function updatePreviewStatus(msg) {
  if (!ui.previewStatus) return;
  const show = msg?.enabled && local.activityTab === "conversations";
  if (!show) {
    ui.previewStatus.classList.add("hidden");
    ui.previewStatus.textContent = "";
    return;
  }
  ui.previewStatus.classList.remove("hidden");
  if (msg.error) {
    ui.previewStatus.textContent = t("previewError");
    return;
  }
  const conv = Number(msg.conversationCount) || 0;
  const titles = Number(msg.titleCount) || 0;
  if (titles === 0) {
    ui.previewStatus.textContent = t("previewNoTitles").replace("{conv}", conv.toLocaleString());
  } else {
    ui.previewStatus.textContent = t("previewFound")
      .replace("{titles}", titles.toLocaleString())
      .replace("{conv}", conv.toLocaleString());
  }
}

export { applyConversationMessages, closeConversationDetail, showConversationDetail };


export function syncDashboardPrefs() {
  vscode.postMessage({
    type: "syncDashboardPrefs",
    range: local.range,
    usageFilter: local.usageFilter,
  });
}

export function updateArchiveNote() {
  if (!ui.archiveNote || !refs.state) return;
  const grokCount = refs.state.grokBotStoredEventCount || 0;
  const usageCount = Math.max(0, (refs.state.storedEventCount || 0) - grokCount);
  const grokArchive = local.activityTab === "grokBot";
  const count = grokArchive ? grokCount : usageCount;
  const parts = [];
  if (count > 0) {
    const template = grokArchive ? t("archiveGrokNote") : t("archiveNote");
    parts.push(template.replace("{count}", count.toLocaleString()));
  }
  if (refs.state.eventsComplete === false) {
    parts.push(t("archivePartialSync"));
  }
  if (parts.length > 0) {
    ui.archiveNote.textContent = parts.join(" · ");
    ui.archiveNote.classList.remove("hidden");
  } else {
    ui.archiveNote.classList.add("hidden");
  }
}

function activitySectionTitle() {
  if (local.activityTab === "grokBot") return t("sectionGrokBot");
  if (local.activityTab === "conversations") return t("sectionConversations");
  return t("sectionEvents");
}

function activityToggleLabel() {
  if (local.activityTab === "grokBot") return t("toggleGrokBot");
  if (local.activityTab === "conversations") return t("toggleConversations");
  return t("toggleEvents");
}

export function applyActivityTab() {
  const tab = local.activityTab;
  ui.activityTabs?.forEach((btn) => {
    const active = btn.dataset.activityTab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  ui.eventsPanel?.classList.toggle("hidden", tab !== "events");
  ui.grokEventsPanel?.classList.toggle("hidden", tab !== "grokBot");
  ui.conversationsPanel?.classList.toggle("hidden", tab !== "conversations");
  ui.exportBtn?.classList.toggle("hidden", tab === "conversations");
  ui.conversationPreviewBtn?.classList.toggle("hidden", tab !== "conversations");
  ui.previewStatus?.classList.toggle("hidden", tab !== "conversations" || !local.conversationPreview);
  if (ui.conversationPreviewBtn) {
    ui.conversationPreviewBtn.classList.toggle("active", local.conversationPreview);
    ui.conversationPreviewBtn.setAttribute("aria-pressed", local.conversationPreview ? "true" : "false");
  }
  if (ui.activitySectionTitle) {
    ui.activitySectionTitle.textContent = activitySectionTitle();
  }
  if (ui.activitySectionToggle) {
    ui.activitySectionToggle.setAttribute("aria-label", activityToggleLabel());
  }
  updateArchiveNote();
}

export function bindConversationHandlers(vscode) {
  ui.activityTabs?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.activityTab;
      if (!next || next === local.activityTab) return;
      local.activityTab = next;
      persistLocal();
      applyActivityTab();
      if (next === "conversations") renderConversationsTable();
      else if (next === "grokBot") renderGrokBotTable();
      else renderTable();
    });
  });

  ui.conversationPreviewBtn?.addEventListener("click", () => {
    local.conversationPreview = !local.conversationPreview;
    persistLocal();
    applyActivityTab();
    updatePreviewLoading(true);
    renderConversationsTable();
    vscode.postMessage({ type: "setConversationPreview", enabled: local.conversationPreview });
  });

  ui.conversationsBody?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-conversation-id]");
    if (!tr) return;
    const id = tr.dataset.conversationId;
    const row = getSortedConversations().find((r) => (r.conversationId ?? NO_CONVERSATION_KEY) === id);
    if (row) showConversationDetail(row);
  });

  ui.eventDetailBody?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-detail-event-key]");
    if (!tr) return;
    const eventKey = tr.dataset.detailEventKey;
    const event = findVisibleEvent(eventKey);
    if (!event) return;
    showEventDetail(event);
  });

  ui.conversationsHead?.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.sort;
    if (local.conversationSortKey === key) {
      local.conversationSortOrder = local.conversationSortOrder === "asc" ? "desc" : "asc";
    } else {
      local.conversationSortKey = key;
      local.conversationSortOrder = key === "label" || key === "models" ? "asc" : "desc";
    }
    local.conversationsPage = 1;
    persistLocal();
    renderConversationsTable();
  });

  ui.conversationsPagination?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    const rows = getSortedConversations();
    const current = paginateList(rows, local.conversationsPage, local.conversationsPageSize);
    const action = btn.dataset.action;
    if (action === "first") local.conversationsPage = 1;
    else if (action === "prev") local.conversationsPage = Math.max(1, current.page - 1);
    else if (action === "next") local.conversationsPage = Math.min(current.totalPages, current.page + 1);
    else if (action === "last") local.conversationsPage = current.totalPages;
    else return;
    persistLocal();
    renderConversationsTable();
  });

  ui.conversationsPagination?.addEventListener("change", (e) => {
    if (e.target.id !== "conversations-page-size") return;
    const nextSize = Number(e.target.value);
    if (!EVENTS_PAGE_SIZES.includes(nextSize) || nextSize === local.conversationsPageSize) return;
    local.conversationsPageSize = nextSize;
    local.conversationsPage = 1;
    persistLocal();
    renderConversationsTable();
  });
}

