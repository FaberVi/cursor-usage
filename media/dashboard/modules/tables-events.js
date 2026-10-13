import {
  EVENTS_PAGE_SIZES,
  local,
  paginateList,
  persistLocal,
  refs,
  ui,
} from "./core.js";
import { colorForModel, tintColor } from "./chart.js";
import {
  escapeHtml,
  eventRequestsText,
  eventSpendText,
  eventTokenCount,
  formatDateTime,
  formatModelLabel,
  formatPerPage,
  formatTokens,
  getDurationCutoff,
  matchesUsageFilter,
  rangeNow,
  toMillis,
} from "./format.js";
import { t } from "./i18n.js";

export function isGrokBotModelId(model) {
  return String(model || "").trim().toLowerCase().startsWith("grok-bot");
}

function isGrokBotArchiveEvent(event) {
  return isGrokBotModelId(event.model);
}

export function findEventByKey(events, eventKey) {
  if (!eventKey) return null;
  return events.find((event) => event.eventKey === eventKey) ?? null;
}

function sortEvents(events, sortKey, sortOrder) {
  const dir = sortOrder === "asc" ? 1 : -1;
  return events.slice().sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === "timestamp") { av = toMillis(av); bv = toMillis(bv); }
    const an = typeof av === "number" ? av : Number(av);
    const bn = typeof bv === "number" ? bv : Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function eventsInRange(grokBot) {
  if (!refs.state) return [];
  const cutoff = getDurationCutoff(local.range, refs.state.resetsAt, rangeNow());
  return refs.state.events.filter((e) => {
    const ts = toMillis(e.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff || !matchesUsageFilter(e, local.usageFilter)) return false;
    const isGrok = isGrokBotArchiveEvent(e);
    return grokBot ? isGrok : !isGrok;
  });
}

export function getSortedEvents() {
  return sortEvents(eventsInRange(false), local.sortKey, local.sortOrder);
}

export function getSortedGrokBotEvents() {
  return sortEvents(eventsInRange(true), local.grokSortKey, local.grokSortOrder);
}

export function findVisibleEvent(eventKey) {
  return findEventByKey(getSortedEvents(), eventKey) ?? findEventByKey(getSortedGrokBotEvents(), eventKey);
}

function kindClassName(kind) {
  if (kind === "Included") return "kind-Included";
  if (kind === "On-Demand") return "kind-OnDemand";
  if (kind === "Errored") return "kind-Errored";
  if (kind === "Aborted") return "kind-Aborted";
  return "kind-Unknown";
}

function renderEventRow(e, eventIdx) {
  const maxBadge = e.maxMode ? ' <span class="max-badge">MAX</span>' : "";
  const color = colorForModel(e.model);
  const rowStyle = 'background:' + tintColor(color, 0.10) + ';box-shadow:inset 3px 0 0 ' + color + ';';
  const eventKey = e.eventKey ?? "";
  const selected = refs.selectedEventKey === eventKey ? " event-row-selected" : "";
  return '<tr class="event-row-clickable' + selected + '" data-event-key="' + escapeHtml(eventKey) + '" data-event-idx="' + eventIdx + '" style="' + rowStyle + '" title="' + escapeHtml(t("convClickEvent")) + '">' +
    "<td>" + formatDateTime(e.timestamp) + "</td>" +
    '<td><span class="kind-badge ' + kindClassName(e.kind) + '">' + escapeHtml(e.kind) + "</span></td>" +
    "<td>" + escapeHtml(formatModelLabel(e.model)) + maxBadge + "</td>" +
    '<td class="num">' + formatTokens(eventTokenCount(e)) + "</td>" +
    '<td class="num">' + eventRequestsText(e) + "</td>" +
    '<td class="num">' + eventSpendText(e) + "</td>" +
  "</tr>";
}

function renderPagination(pagination, paged, pageSize, pageSizeSelectId) {
  if (!pagination) return;
  if (paged.totalItems === 0) {
    pagination.innerHTML = "";
    return;
  }

  const showingStart = paged.startIndex + 1;
  const showingEnd = paged.endIndex;
  const sizeOptions = EVENTS_PAGE_SIZES.map((size) =>
    '<option value="' + size + '"' + (size === pageSize ? " selected" : "") + ">" + formatPerPage(size) + "</option>"
  ).join("");
  const atFirst = paged.page <= 1;
  const atLast = paged.page >= paged.totalPages;

  pagination.innerHTML =
    '<span class="pagination-info">' + t("showing") + " " +
      showingStart.toLocaleString() + "\u2013" + showingEnd.toLocaleString() +
      " " + t("of") + " " + paged.totalItems.toLocaleString() + " " +
      (paged.totalItems === 1 ? t("eventOne") : t("eventMany")) +
    "</span>" +
    '<div class="pagination-controls">' +
      '<select id="' + pageSizeSelectId + '" class="pagination-size" aria-label="' + escapeHtml(t("eventsPerPage")) + '">' + sizeOptions + "</select>" +
      '<button type="button" data-action="first"' + (atFirst ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pageFirst")) + '">\u00ab</button>' +
      '<button type="button" data-action="prev"' + (atFirst ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pagePrev")) + '">\u2039</button>' +
      '<span class="pagination-page">' + paged.page + " / " + paged.totalPages + "</span>" +
      '<button type="button" data-action="next"' + (atLast ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pageNext")) + '">\u203a</button>' +
      '<button type="button" data-action="last"' + (atLast ? " disabled" : "") + ' aria-label="' + escapeHtml(t("pageLast")) + '">\u00bb</button>' +
    "</div>";
}

function paintEventTable(body, head, pagination, events, page, pageSize, sortKey, sortOrder, pageSizeSelectId) {
  if (!body || !head || !pagination) return page;
  const paged = paginateList(events, page, pageSize);
  if (events.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:24px;" class="muted">' + escapeHtml(t("noEventsInRange")) + "</td></tr>";
    pagination.innerHTML = "";
  } else {
    body.innerHTML = paged.items.map((e, i) => renderEventRow(e, paged.startIndex + i)).join("");
    renderPagination(pagination, paged, pageSize, pageSizeSelectId);
  }
  head.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortOrder === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });
  return paged.page;
}

export function renderTable() {
  const page = paintEventTable(
    ui.tableBody,
    ui.tableHead,
    ui.pagination,
    getSortedEvents(),
    local.eventsPage,
    local.eventsPageSize,
    local.sortKey,
    local.sortOrder,
    "events-page-size",
  );
  if (page !== local.eventsPage) {
    local.eventsPage = page;
    persistLocal();
  }
}

export function renderGrokBotTable() {
  const page = paintEventTable(
    ui.grokTableBody,
    ui.grokTableHead,
    ui.grokPagination,
    getSortedGrokBotEvents(),
    local.grokEventsPage,
    local.grokEventsPageSize,
    local.grokSortKey,
    local.grokSortOrder,
    "grok-events-page-size",
  );
  if (page !== local.grokEventsPage) {
    local.grokEventsPage = page;
    persistLocal();
  }
}
