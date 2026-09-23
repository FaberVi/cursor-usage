import { apiLog } from "./cursor-api-logger";
import type { CursorHeaders } from "./cursor-api-types";
import { asRecord, parseTimestamp, safeJson, toNumber, withTimeout } from "./cursor-api-utils";

export type GrokBotUsage = {
  /** Included weekly allowance consumed (0–100). */
  percentUsed: number;
  periodStartIso: string | null;
  resetsAtIso: string | null;
};

const SAND_USAGE_URL = "https://cursor.com/api/dashboard/get-sand-usage-status";

function parseResetIso(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) {
    const ms = parseTimestamp(raw);
    return ms > 0 ? new Date(ms).toISOString() : raw;
  }
  const num = toNumber(raw);
  if (num !== null && num > 0) {
    return new Date(num).toISOString();
  }
  return null;
}

/** Parses POST /api/dashboard/get-sand-usage-status (Cursor "Sand" / Grok Bot weekly meter). */
export function parseSandUsageStatus(raw: unknown): GrokBotUsage | null {
  const record = asRecord(raw);
  if (!record) return null;

  if (record.usesPooledEnterpriseAllowance === true) {
    apiLog("sand-usage: pooled enterprise allowance — no personal Grok Bot meter");
    return null;
  }
  if (record.includedLimitZero === true) {
    apiLog("sand-usage: includedLimitZero — plan has no Grok Bot allowance");
    return null;
  }
  if (record.hasNonZeroIncludedLimit !== true) {
    apiLog("sand-usage: hasNonZeroIncludedLimit is not true — Grok Bot not included on plan");
    return null;
  }

  const usagePercent = toNumber(record.usagePercent);
  if (usagePercent === null) {
    apiLog("sand-usage: usagePercent absent");
    return null;
  }

  const periodStart =
    typeof record.currentPeriodStart === "string" ? record.currentPeriodStart : null;
  const resetsAt =
    parseResetIso(record.nextResetTimestampUtc) ??
    parseResetIso(record.nextResetAt) ??
    null;

  return {
    percentUsed: Math.min(Math.max(usagePercent, 0), 100),
    periodStartIso: periodStart,
    resetsAtIso: resetsAt,
  };
}

export async function fetchGrokBotWeeklyUsage(
  headers: CursorHeaders,
): Promise<GrokBotUsage | null> {
  try {
    const res = await fetch(
      SAND_USAGE_URL,
      withTimeout({
        method: "POST",
        headers,
        body: "{}",
      }),
    );
    if (!res.ok) {
      apiLog(`get-sand-usage-status failed: ${res.status}`);
      return null;
    }
    const data = await safeJson(res);
    const parsed = parseSandUsageStatus(data);
    if (parsed) {
      apiLog(`Grok Bot weekly: ${parsed.percentUsed.toFixed(1)}% used`);
    }
    return parsed;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    apiLog(`get-sand-usage-status error: ${message}`);
    return null;
  }
}
