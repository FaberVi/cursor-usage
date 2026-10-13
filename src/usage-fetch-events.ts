import { cursorHeaders, getCursorToken } from "./cursor-auth";
import { apiLog } from "./cursor-api-logger";
import type { AuthInfo, CursorHeaders, DailySpendRow, SetupCache, UsageEvent } from "./cursor-api-types";
import { asRecord, matchesTeamMember, MAX_USAGE_EVENT_PAGES, safeJson, toNumber, withTimeout } from "./cursor-api-utils";
import { ensureSetup } from "./cursor-setup";
import { normalizeUsageEventRequests, parseUsageEvent } from "./cursor-usage-parsing";

import { getBillingCycleCutoff } from "./cursor-api-utils";

export type FetchDailySpendOptions = {
  resetAtIso?: string | null;
  periodStartMs?: number;
  periodEndMs?: number;
};

function resolveDailySpendPeriod(opts?: FetchDailySpendOptions): { periodStartMs: number; periodEndMs: number } {
  const periodEndMs = opts?.periodEndMs ?? Date.now();
  if (opts?.periodStartMs !== undefined) {
    return { periodStartMs: opts.periodStartMs, periodEndMs };
  }
  if (opts?.resetAtIso) {
    return {
      periodStartMs: getBillingCycleCutoff(opts.resetAtIso, periodEndMs),
      periodEndMs,
    };
  }
  return {
    periodStartMs: periodEndMs - 31 * 86_400_000,
    periodEndMs,
  };
}

function parseDailySpendRow(row: unknown): DailySpendRow | null {
  const data = asRecord(row);
  if (!data) return null;

  const day = toNumber(data.day);
  const category = typeof data.category === "string" ? data.category : null;
  const spendCents = toNumber(data.spendCents);
  const totalTokens = toNumber(data.totalTokens);

  if (day === null || !category || spendCents === null || totalTokens === null) {
    return null;
  }

  return {
    day,
    category,
    spendCents,
    totalTokens,
  };
}

async function resolveDashboardUserId(
  auth: AuthInfo,
  headers: CursorHeaders,
  setup: SetupCache,
): Promise<number | null> {
  const directUserId = toNumber(auth.userId);
  if (directUserId !== null) {
    return directUserId;
  }

  if (!setup.isTeamMember || !setup.teamId) {
    return null;
  }

  const res = await fetch("https://cursor.com/api/dashboard/get-team-spend", withTimeout({
    method: "POST",
    headers,
    body: JSON.stringify({ teamId: setup.teamId }),
  }));
  if (!res.ok) {
    apiLog(`get-team-spend failed while resolving dashboard user id: ${res.status}`);
    return null;
  }

  const data = asRecord(await safeJson(res));
  if (!data) {
    apiLog("get-team-spend failed while resolving dashboard user id: invalid JSON");
    return null;
  }
  const members: unknown[] = Array.isArray(data.teamMemberSpend) ? data.teamMemberSpend : [];
  for (const member of members) {
    const record = asRecord(member);
    if (!record) continue;

    const memberUserId = toNumber(record.userId);
    if (memberUserId === null) continue;

    if (matchesTeamMember(record, auth)) {
      return memberUserId;
    }
  }

  apiLog(`Could not resolve dashboard user id from team spend (email=${auth.email}, userId=${auth.userId})`);
  return null;
}

export async function fetchDailySpendByCategory(
  opts?: FetchDailySpendOptions,
): Promise<DailySpendRow[]> {
  apiLog("--- Fetching daily spend by category ---");

  const auth = await getCursorToken();
  if (!auth) {
    apiLog("Failed to get auth token for daily spend");
    return [];
  }

  const headers = cursorHeaders(auth.sessionToken);
  const setup = await ensureSetup(auth.userId, auth.sessionToken, headers, auth.email);
  if (!setup?.isTeamMember || !setup.teamId) {
    apiLog("Skipping daily spend fetch: team setup unavailable");
    return [];
  }

  const dashboardUserId = await resolveDashboardUserId(auth, headers, setup);
  if (dashboardUserId === null) {
    apiLog("Skipping daily spend fetch: dashboard user id unavailable");
    return [];
  }

  const { periodStartMs, periodEndMs } = resolveDailySpendPeriod(opts);
  const res = await fetch("https://cursor.com/api/dashboard/get-daily-spend-by-category", withTimeout({
    method: "POST",
    headers,
    body: JSON.stringify({
      teamId: setup.teamId,
      userId: dashboardUserId,
      periodStartMs,
      periodEndMs,
      groupBy: 1,
      spendType: 1,
    }),
  }));

  if (!res.ok) {
    apiLog(`get-daily-spend-by-category failed: ${res.status}`);
    return [];
  }

  const data = asRecord(await safeJson(res));
  if (!data) {
    apiLog("get-daily-spend-by-category failed: invalid JSON");
    return [];
  }
  const rows: unknown[] = Array.isArray(data.dailySpend) ? data.dailySpend : [];
  const parsedRows: DailySpendRow[] = [];
  for (const row of rows) {
    const parsed = parseDailySpendRow(row);
    if (parsed) parsedRows.push(parsed);
  }
  apiLog(`Fetched ${parsedRows.length} daily spend rows`);
  return parsedRows;
}

export type FetchUsageEventsOptions = {
  maxPages?: number;
  lookbackDays?: number;
};

export type FetchUsageEventsResult = {
  events: UsageEvent[];
  /** True when the lookback window was retrieved without auth/HTTP failure or page-cap truncation. */
  complete: boolean;
  /** True when the fetch stopped early and more events may remain. */
  truncated: boolean;
  /** True when the raw page length covers `totalUsageEventsCount` from the first page. */
  totalCovered: boolean;
  /** Human-readable reason when `complete` is false or the fetch could not run. */
  failureReason: string | null;
};

export async function fetchUsageEvents(opts: FetchUsageEventsOptions = {}): Promise<FetchUsageEventsResult> {
  apiLog("--- Fetching usage events ---");

  const auth = await getCursorToken();
  if (!auth) {
    apiLog("Failed to get auth token for events");
    return {
      events: [],
      complete: false,
      truncated: false,
      totalCovered: false,
      failureReason: "Cursor authentication token not available",
    };
  }

  const headers = cursorHeaders(auth.sessionToken);
  const setup = await ensureSetup(auth.userId, auth.sessionToken, headers, auth.email);
  const teamId = setup?.teamId ?? 0;

  const endDate = Date.now();
  const lookbackDays = opts.lookbackDays ?? 31;
  const maxPages = opts.maxPages ?? MAX_USAGE_EVENT_PAGES;
  const startDate = endDate - lookbackDays * 86_400_000;
  const pageSize = 500;
  let page = 1;
  const allEvents: UsageEvent[] = [];
  let complete = true;
  let truncated = false;
  let failureReason: string | null = null;
  let fetchedRaw = 0;
  let reportedTotal: number | null = null;
  let stoppedOnShortPage = false;

  while (page <= maxPages) {
    const res = await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", withTimeout({
      method: "POST",
      headers,
      body: JSON.stringify({
        teamId,
        startDate: String(startDate),
        endDate: String(endDate),
        page,
        pageSize,
      }),
    }));

    if (!res.ok) {
      apiLog(`get-filtered-usage-events failed: ${res.status}`);
      complete = false;
      failureReason = `HTTP ${res.status} from get-filtered-usage-events (page ${page})`;
      break;
    }

    const dataRecord = asRecord(await safeJson(res));
    if (!dataRecord) {
      apiLog("get-filtered-usage-events failed: invalid JSON");
      complete = false;
      failureReason = "Invalid JSON from get-filtered-usage-events";
      break;
    }
    const events: unknown[] = Array.isArray(dataRecord.usageEventsDisplay) ? dataRecord.usageEventsDisplay : [];
    const totalCount = toNumber(dataRecord.totalUsageEventsCount);
    if (page === 1) {
      reportedTotal = totalCount;
      apiLog(`Total usage events available: ${reportedTotal ?? "unknown"}`);
    }

    fetchedRaw += events.length;
    for (const event of events) {
      const parsed = parseUsageEvent(event);
      if (parsed) allEvents.push(parsed);
    }

    if (events.length < pageSize) {
      stoppedOnShortPage = true;
      break;
    }
    if (reportedTotal !== null && fetchedRaw >= reportedTotal) break;
    page++;
  }

  const totalCovered = reportedTotal !== null && fetchedRaw >= reportedTotal;
  if (stoppedOnShortPage && reportedTotal !== null && !totalCovered) {
    complete = false;
    truncated = true;
    failureReason = `Page ended early (${fetchedRaw} of ${reportedTotal} events reported)`;
    apiLog(
      `Usage events page ended early (${fetchedRaw} of ${reportedTotal} reported)`,
    );
  }
  if (page > maxPages && !totalCovered) {
    complete = false;
    truncated = true;
    failureReason = `Stopped after ${maxPages} page(s) (${fetchedRaw} events fetched)`;
    apiLog(`Stopped usage events fetch after ${maxPages} page(s)`);
  }

  apiLog(`Fetched ${allEvents.length} usage events across ${Math.min(page, maxPages)} page(s)`);
  return {
    events: allEvents.map(normalizeUsageEventRequests),
    complete,
    truncated,
    totalCovered,
    failureReason,
  };
}
