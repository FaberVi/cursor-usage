import { apiLog } from "./cursor-api-logger";
import type { UsageEvent, UsagePayload } from "./cursor-api-types";
import { asRecord, getBillingCycleCutoff, parseTimestamp, toNumber } from "./cursor-api-utils";
import { getCachedMaxRequestUsage } from "./cursor-setup-cache";

function roundRequestCount(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseEventKind(kind: string): string {
  if (kind === "USAGE_EVENT_KIND_USAGE_BASED") return "On-Demand";
  if (kind === "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED") return "Errored";
  if (kind === "USAGE_EVENT_KIND_ABORTED_NOT_CHARGED") return "Aborted";
  return "Included";
}

export function enrichUsageFromEvents(
  data: UsagePayload,
  events: UsageEvent[],
  now = Date.now(),
): UsagePayload {
  if (data.includedRequests.limit > 0 && data.includedRequests.used > 0) {
    return data;
  }

  const cutoff = getBillingCycleCutoff(data.resetsAt, now);
  let includedUsed = 0;
  let onDemandSpendCents = 0;

  for (const event of events) {
    if (event.timestamp < cutoff) continue;
    if (event.kind === "Included") {
      includedUsed += eventRequestCount(event);
    } else if (event.kind === "On-Demand") {
      onDemandSpendCents += event.spendCents;
    }
  }

  const cachedLimit = getCachedMaxRequestUsage();
  const used = data.includedRequests.used > 0 ? data.includedRequests.used : roundRequestCount(includedUsed);
  const limit =
    data.includedRequests.limit > 0
      ? data.includedRequests.limit
      : cachedLimit > 0
        ? cachedLimit
        : used > 0
          ? used
          : 0;

  if (used === data.includedRequests.used && limit === data.includedRequests.limit) {
    return data;
  }

  apiLog(`Enriched usage from events: ${used}/${limit} (events included reqs=${includedUsed.toFixed(1)})`);

  const onDemand =
    data.onDemand.state === "disabled" && onDemandSpendCents > 0
      ? { state: "unlimited" as const, onDemandEnabled: true, spendDollars: onDemandSpendCents / 100, limitDollars: null }
      : data.onDemand;

  return {
    ...data,
    includedRequests: { used, limit },
    onDemand,
  };
}

/** Whether this row is billed by tokens (vs legacy request-metered plans). */
export function isTokenMeteredUsageEvent(
  event: Pick<
    UsageEvent,
    | "isTokenBasedCall"
    | "inputTokens"
    | "outputTokens"
    | "cacheWriteTokens"
    | "cacheReadTokens"
    | "totalTokens"
    | "requests"
  >,
): boolean {
  if (event.isTokenBasedCall) return true;

  const breakdown =
    (event.inputTokens ?? 0) +
    (event.outputTokens ?? 0) +
    (event.cacheWriteTokens ?? 0) +
    (event.cacheReadTokens ?? 0);
  if (breakdown > 0) return true;

  const totalTokens = event.totalTokens ?? 0;
  const stored = event.requests ?? 0;
  // Archived rows sometimes stored token totals in `requests`.
  if (totalTokens > 1000 && stored >= totalTokens * 0.5) return true;

  return false;
}

/** Token count for charts/tables — prefers component breakdown over polluted `totalTokens`. */
export function eventTokenCount(
  event: Pick<
    UsageEvent,
    | "inputTokens"
    | "outputTokens"
    | "cacheWriteTokens"
    | "cacheReadTokens"
    | "totalTokens"
  >,
): number {
  const fromComponents =
    (event.inputTokens ?? 0) +
    (event.outputTokens ?? 0) +
    (event.cacheWriteTokens ?? 0) +
    (event.cacheReadTokens ?? 0);
  if (fromComponents > 0) {
    return fromComponents;
  }

  const stored = event.totalTokens ?? 0;
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

/** Request count for charts/tables — not the same as API `requestsCosts` on token-metered events. */
export function eventRequestCount(
  event: Pick<
    UsageEvent,
    | "requests"
    | "isTokenBasedCall"
    | "kind"
    | "inputTokens"
    | "outputTokens"
    | "cacheWriteTokens"
    | "cacheReadTokens"
    | "totalTokens"
  >,
): number {
  if (isTokenMeteredUsageEvent(event)) {
    return 1;
  }

  const stored = event.requests ?? 0;
  if (!Number.isFinite(stored) || stored <= 0) return 1;
  if (stored > 1000) return 1;
  return stored;
}

/** Normalize stored requests/tokens on events loaded from archive/API. */
export function normalizeUsageEventRequests(event: UsageEvent): UsageEvent {
  const requests = eventRequestCount(event);
  const totalTokens = eventTokenCount(event);
  if (requests === event.requests && totalTokens === event.totalTokens) return event;
  return { ...event, requests, totalTokens };
}

export function parseEventRequests(
  raw: Record<string, unknown>,
  kind: string,
  isTokenBasedCall: boolean,
): number {
  const numRequests = toNumber(raw.numRequests);
  if (numRequests !== null) return numRequests;
  const requestsCosts = toNumber(raw.requestsCosts);
  if (isTokenBasedCall && parseEventKind(kind) === "Included") {
    return 1;
  }
  return requestsCosts ?? 1;
}

export function parseUsageEvent(raw: unknown): UsageEvent | null {
  const e = asRecord(raw);
  if (!e) return null;

  const tok = asRecord(e.tokenUsage) ?? {};
  const inputTokens = toNumber(tok.inputTokens) ?? 0;
  const outputTokens = toNumber(tok.outputTokens) ?? 0;
  const cacheWriteTokens = toNumber(tok.cacheWriteTokens) ?? 0;
  const cacheReadTokens = toNumber(tok.cacheReadTokens) ?? 0;
  const totalTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
  const kind = parseEventKind(typeof e.kind === "string" ? e.kind : "");
  const isTokenBasedCall = Boolean(e.isTokenBasedCall);

  const event: UsageEvent = {
    timestamp: parseTimestamp(e.timestamp),
    model: typeof e.model === "string" ? e.model : "unknown",
    kind,
    totalTokens,
    requests: parseEventRequests(e, typeof e.kind === "string" ? e.kind : "", isTokenBasedCall),
    spendCents: toNumber(e.chargedCents) ?? 0,
    maxMode: Boolean(e.maxMode),
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    tokenCostCents: toNumber(tok.totalCents) ?? 0,
    cursorTokenFee: toNumber(e.cursorTokenFee) ?? 0,
    isTokenBasedCall,
    isHeadless: Boolean(e.isHeadless),
    isChargeable: e.isChargeable !== false,
    conversationId:
      typeof e.conversationId === "string"
      && e.conversationId.trim() !== ""
      && e.conversationId !== "null"
        ? e.conversationId.trim()
        : null,
  };

  return normalizeUsageEventRequests(event);
}

export { parseTimestamp } from "./cursor-api-utils";
