import { cursorHeaders, getCursorToken } from "./cursor-auth";
import { apiLog } from "./cursor-api-logger";
import type {
  AuthInfo,
  CursorHeaders,
  RequestTotals,
  SetupCache,
  UsagePayload,
} from "./cursor-api-types";
import { asRecord, matchesTeamMember, nextMonth, safeJson, toNumber, withTimeout } from "./cursor-api-utils";
import { billingCycleEndIso, fetchCurrentPeriodUsage } from "./cursor-period-usage";
import { ensureSetup, withPlanInfo } from "./cursor-setup";
import {
  extractPoolUsageFromSummary,
  extractTeamRequestLimit,
  extractTeamUsedRequests,
  extractUsageFromSummary,
  extractUsageTotals,
  mergeTeamIncludedRequests,
} from "./cursor-usage-parsing";
import {
  buildOnDemandFromSpendLimit,
  buildTeamOnDemandFallback,
  finalizeOnDemandUsage,
  mergeOnDemandUsage,
  resolveOnDemandEnabled,
  resolveOnDemandFromUsageSummary,
  type OnDemandUsage,
} from "./on-demand";
import { fetchGrokBotWeeklyUsage } from "./grok-bot-usage";

async function fetchUsageSummary(headers: CursorHeaders): Promise<Record<string, unknown> | null> {
  const res = await fetch("https://cursor.com/api/usage-summary", withTimeout({ headers }));
  if (!res.ok) {
    apiLog(`usage-summary failed: ${res.status}`);
    return null;
  }
  const data = asRecord(await safeJson(res));
  if (!data) {
    apiLog("usage-summary returned invalid JSON");
    return null;
  }
  return data;
}

function buildSoloOnDemand(
  setup: SetupCache,
  periodUsage: Record<string, unknown> | null,
  usageSummary: Record<string, unknown> | null,
  mySpendCents = 0,
): OnDemandUsage {
  const usageSummaryEnabled = resolveOnDemandFromUsageSummary(usageSummary, false);
  const onDemandEnabled = resolveOnDemandEnabled(
    setup.stripeRecord,
    periodUsage,
    null,
    usageSummaryEnabled,
  );
  return finalizeOnDemandUsage(
    buildOnDemandFromSpendLimit(periodUsage?.spendLimitUsage, onDemandEnabled, mySpendCents),
    onDemandEnabled,
  );
}

function buildTeamOnDemand(
  setup: SetupCache,
  periodUsage: Record<string, unknown> | null,
  usageSummary: Record<string, unknown> | null,
  members: unknown[],
  meRecord: Record<string, unknown>,
  dataRecord: Record<string, unknown>,
): OnDemandUsage {
  const spendCents = toNumber(meRecord.spendCents) ?? 0;
  const usageSummaryEnabled = resolveOnDemandFromUsageSummary(usageSummary, true);
  const onDemandEnabled = resolveOnDemandEnabled(
    setup.stripeRecord,
    periodUsage,
    dataRecord,
    usageSummaryEnabled,
  );
  const onDemandFromPeriod = buildOnDemandFromSpendLimit(
    periodUsage?.spendLimitUsage,
    onDemandEnabled,
    spendCents,
  );
  const onDemandFallback = buildTeamOnDemandFallback(members, meRecord, dataRecord, onDemandEnabled);
  const onDemand = finalizeOnDemandUsage(
    mergeOnDemandUsage(onDemandFromPeriod, onDemandFallback, onDemandEnabled),
    onDemandEnabled,
  );
  const spendLimitLog = asRecord(periodUsage?.spendLimitUsage);
  apiLog(
    `On-demand state: ${onDemand.state}, enabled=${onDemandEnabled}, summary.onDemand=${usageSummaryEnabled ?? "n/a"}, period.enabled=${periodUsage?.enabled ?? "n/a"}${onDemand.breakdown?.isTeamPool ? " (team pool)" : ""}${spendLimitLog ? `, spendLimit={pooledLimit:${spendLimitLog.pooledLimit ?? "n/a"}, pooledUsed:${spendLimitLog.pooledUsed ?? "n/a"}, pooledRemaining:${spendLimitLog.pooledRemaining ?? "n/a"}}` : ""}`,
  );
  return onDemand;
}

async function enrichPayloadOnDemand(
  auth: AuthInfo,
  setup: SetupCache,
  payload: UsagePayload,
  usageSummary: Record<string, unknown> | null,
): Promise<UsagePayload> {
  const periodUsage = await fetchCurrentPeriodUsage(auth.accessToken);

  if (setup.isTeamMember && setup.teamId) {
    const teamSpendRes = await fetch("https://cursor.com/api/dashboard/get-team-spend", withTimeout({
      method: "POST",
      headers: cursorHeaders(auth.sessionToken),
      body: JSON.stringify({ teamId: setup.teamId }),
    }));
    if (!teamSpendRes.ok) {
      apiLog(`get-team-spend enrichment skipped: ${teamSpendRes.status}`);
      return payload;
    }

    const dataRecord = asRecord(await safeJson(teamSpendRes));
    if (!dataRecord) {
      apiLog("get-team-spend enrichment skipped: invalid JSON");
      return payload;
    }
    const members: unknown[] = Array.isArray(dataRecord.teamMemberSpend) ? dataRecord.teamMemberSpend : [];
    const me = members.find((member) => {
      const record = asRecord(member);
      return record ? matchesTeamMember(record, auth) : false;
    });
    if (!me) return payload;

    const meRecord = asRecord(me) ?? {};
    return {
      ...payload,
      onDemand: buildTeamOnDemand(setup, periodUsage, usageSummary, members, meRecord, dataRecord),
      resetsAt: billingCycleEndIso(periodUsage) ?? payload.resetsAt,
    };
  }

  return {
    ...payload,
    onDemand: buildSoloOnDemand(setup, periodUsage, usageSummary),
    resetsAt: billingCycleEndIso(periodUsage) ?? payload.resetsAt,
  };
}

async function fetchTeamUsage(
  auth: AuthInfo,
  headers: CursorHeaders,
  setup: SetupCache,
): Promise<UsagePayload | null> {
  const [teamSpendRes, usageRes, usageSummary, periodUsage] = await Promise.all([
    fetch("https://cursor.com/api/dashboard/get-team-spend", withTimeout({
      method: "POST",
      headers,
      body: JSON.stringify({ teamId: setup.teamId }),
    })),
    fetch(`https://cursor.com/api/usage?user=${auth.userId}`, withTimeout({ headers })),
    fetchUsageSummary(headers),
    fetchCurrentPeriodUsage(auth.accessToken),
  ]);

  if (!teamSpendRes.ok) {
    apiLog(`get-team-spend failed: ${teamSpendRes.status}`);
    return null;
  }

  let usageTotals: RequestTotals | null = null;
  if (usageRes.ok) {
    const usage = await safeJson(usageRes);
    if (!usage) {
      apiLog("Usage API failed in team mode: invalid JSON");
    } else {
      usageTotals = extractUsageTotals(usage);
    }
  } else {
    apiLog(`Usage API failed in team mode: ${usageRes.status}`);
  }

  const dataRecord = asRecord(await safeJson(teamSpendRes));
  if (!dataRecord) {
    apiLog("get-team-spend failed: invalid JSON");
    return null;
  }
  const members: unknown[] = Array.isArray(dataRecord.teamMemberSpend) ? dataRecord.teamMemberSpend : [];
  const me = members.find((member) => {
    const record = asRecord(member);
    return record ? matchesTeamMember(record, auth) : false;
  });

  if (!me) {
    apiLog(`Could not find current user in team spend (email=${auth.email}, userId=${auth.userId})`);
    return null;
  }

  const nextCycleStart = toNumber(dataRecord.nextCycleStart);
  const resetsAt = nextCycleStart !== null
    ? new Date(nextCycleStart).toISOString()
    : null;

  const meRecord = asRecord(me) ?? {};
  apiLog(`Team member keys: ${Object.keys(meRecord).join(", ") || "(none)"}`);

  const memberUsed = extractTeamUsedRequests(meRecord);
  const memberLimit = extractTeamRequestLimit(meRecord, setup.maxRequestUsage);

  const merged = mergeTeamIncludedRequests(usageTotals, memberUsed, memberLimit);
  const { used, limit, usedSource, limitSource } = merged;
  apiLog(`Team request source: used=${usedSource}, limit=${limitSource}`);

  const onDemand = buildTeamOnDemand(setup, periodUsage, usageSummary, members, meRecord, dataRecord);

  const result: UsagePayload = {
    includedRequests: {
      used,
      limit,
    },
    onDemand,
    poolUsage: extractPoolUsageFromSummary(usageSummary),
    grokBotUsage: null,
    resetsAt: billingCycleEndIso(periodUsage) ?? resetsAt,
    planInfo: null,
  };

  const spendLimitLabel = result.onDemand.state === "unlimited"
    ? "∞"
    : result.onDemand.state === "disabled"
      ? "hidden"
      : `$${(result.onDemand.limitDollars ?? 0).toFixed(2)}`;
  apiLog(
    `Result: ${result.includedRequests.used}/${result.includedRequests.limit} reqs, $${result.onDemand.spendDollars.toFixed(2)}/${spendLimitLabel}`,
  );
  return result;
}

async function fetchSoloUsage(
  auth: AuthInfo,
  headers: CursorHeaders,
  setup: SetupCache,
): Promise<UsagePayload | null> {
  const [usageRes, periodUsage, usageSummary] = await Promise.all([
    fetch(`https://cursor.com/api/usage?user=${auth.userId}`, withTimeout({ headers })),
    fetchCurrentPeriodUsage(auth.accessToken),
    fetchUsageSummary(headers),
  ]);

  if (!usageRes.ok) {
    apiLog(`Usage API failed: ${usageRes.status}`);
    return null;
  }

  const usage = await safeJson(usageRes);
  if (!usage) {
    apiLog("Usage API failed: invalid JSON");
    return null;
  }
  const totals = extractUsageTotals(usage);
  const usageRecord = asRecord(usage);
  const startOfMonth = typeof usageRecord?.startOfMonth === "string" ? usageRecord.startOfMonth : null;
  const resetsAt = startOfMonth ? nextMonth(startOfMonth) : null;
  const onDemand = buildSoloOnDemand(setup, periodUsage, usageSummary);

  const result: UsagePayload = {
    includedRequests: {
      used: totals.used,
      limit: totals.limit,
    },
    onDemand,
    poolUsage: null,
    grokBotUsage: null,
    resetsAt: billingCycleEndIso(periodUsage) ?? resetsAt,
    planInfo: null,
  };

  apiLog(`Result: ${result.includedRequests.used}/${result.includedRequests.limit} reqs`);
  return result;
}

async function finalizeUsagePayload(
  payload: UsagePayload,
  headers: CursorHeaders,
  setup: SetupCache,
): Promise<UsagePayload> {
  const grokBotUsage = await fetchGrokBotWeeklyUsage(headers);
  return withPlanInfo({ ...payload, grokBotUsage }, setup);
}

export async function fetchUsageData(): Promise<UsagePayload | null> {
  apiLog("--- Fetching usage data ---");

  const auth = await getCursorToken();
  if (!auth) {
    apiLog("Failed to get auth token");
    return null;
  }

  const headers = cursorHeaders(auth.sessionToken);
  const setup = await ensureSetup(auth.userId, auth.sessionToken, headers, auth.email);
  if (!setup) {
    apiLog("Setup failed");
    return null;
  }

  if (setup.isTeamMember) {
    const payload = await fetchTeamUsage(auth, headers, setup);
    return payload ? finalizeUsagePayload(payload, headers, setup) : null;
  }

  const summary = await fetchUsageSummary(headers);
  if (summary) {
    const fromSummary = extractUsageFromSummary(summary, setup.onDemandEnabled);
    if (fromSummary && (fromSummary.includedRequests.limit > 0 || fromSummary.includedRequests.used > 0)) {
      apiLog(
        `Using usage-summary: ${fromSummary.includedRequests.used}/${fromSummary.includedRequests.limit} reqs`,
      );
      const enriched = await enrichPayloadOnDemand(auth, setup, fromSummary, summary);
      return finalizeUsagePayload(enriched, headers, setup);
    }
    apiLog("usage-summary returned no usable plan limits; falling back to legacy endpoints");
  }

  const payload = await fetchSoloUsage(auth, headers, setup);
  return payload ? finalizeUsagePayload(payload, headers, setup) : null;
}
