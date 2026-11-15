import { withTimeout } from "./cursor-api-utils";
import { DEFAULT_EUR_USD_RATE } from "./dashboard-locale";

/** ECB reference rate via Frankfurter. Not Cursor's invoice currency. */
const FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=USD&to=EUR";

let eurPerUsd = DEFAULT_EUR_USD_RATE;

export function getEurPerUsd(): number {
  return eurPerUsd;
}

export function setEurPerUsd(rate: number): void {
  if (Number.isFinite(rate) && rate > 0) eurPerUsd = rate;
}

export function parseEurPerUsd(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const rates = (payload as { rates?: unknown }).rates;
  if (!rates || typeof rates !== "object") return null;
  const eur = (rates as { EUR?: unknown }).EUR;
  return typeof eur === "number" && Number.isFinite(eur) && eur > 0 ? eur : null;
}

/** Refresh the USD→EUR rate. A failed request keeps the previous rate. */
export async function refreshEurPerUsd(): Promise<number> {
  try {
    const res = await fetch(FRANKFURTER_URL, withTimeout());
    if (!res.ok) return eurPerUsd;
    const rate = parseEurPerUsd(await res.json());
    if (rate !== null) eurPerUsd = rate;
  } catch {
    // Offline or blocked: keep the last rate, including the bundled fallback.
  }
  return eurPerUsd;
}
