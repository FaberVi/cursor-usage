import type * as vscode from "vscode";
import type { GrokBotUsage } from "./grok-bot-usage";

const CACHE_KEY = "cursorUsage.grokBotWeeklyCache";

export type StoredGrokBotUsage = GrokBotUsage & {
  cachedAtIso: string;
};

export type GrokBotUsageResolveResult = {
  usage: GrokBotUsage | null;
  /** True when live API failed and a still-valid cache entry was used. */
  stale: boolean;
};

function parseStored(raw: unknown): StoredGrokBotUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const percentUsed = record.percentUsed;
  if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed)) return null;
  const cachedAtIso = typeof record.cachedAtIso === "string" ? record.cachedAtIso : null;
  if (!cachedAtIso) return null;
  return {
    percentUsed: Math.min(Math.max(percentUsed, 0), 100),
    periodStartIso: typeof record.periodStartIso === "string" ? record.periodStartIso : null,
    resetsAtIso: typeof record.resetsAtIso === "string" ? record.resetsAtIso : null,
    cachedAtIso,
  };
}

export function loadGrokBotUsageCache(memento: vscode.Memento): StoredGrokBotUsage | null {
  return parseStored(memento.get(CACHE_KEY));
}

export function saveGrokBotUsageCache(
  memento: vscode.Memento,
  usage: GrokBotUsage,
  now = Date.now(),
): void {
  const stored: StoredGrokBotUsage = {
    ...usage,
    cachedAtIso: new Date(now).toISOString(),
  };
  void memento.update(CACHE_KEY, stored);
}

/** Weekly window still open, or cache is recent enough to treat as same week. */
export function isGrokBotUsageCacheValid(stored: StoredGrokBotUsage, now = Date.now()): boolean {
  if (stored.resetsAtIso) {
    const resetMs = Date.parse(stored.resetsAtIso);
    if (Number.isFinite(resetMs) && now < resetMs) return true;
  }
  const cachedMs = Date.parse(stored.cachedAtIso);
  if (!Number.isFinite(cachedMs)) return false;
  const maxAgeMs = 8 * 24 * 60 * 60 * 1000;
  return now - cachedMs <= maxAgeMs;
}

export function resolveGrokBotUsageWithCache(
  memento: vscode.Memento,
  live: GrokBotUsage | null,
  now = Date.now(),
): GrokBotUsageResolveResult {
  if (live) {
    saveGrokBotUsageCache(memento, live, now);
    return { usage: live, stale: false };
  }

  const cached = loadGrokBotUsageCache(memento);
  if (cached && isGrokBotUsageCacheValid(cached, now)) {
    const { cachedAtIso: _drop, ...usage } = cached;
    return { usage, stale: true };
  }

  return { usage: null, stale: false };
}
