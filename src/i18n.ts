import type { UsageDuration } from "./model-breakdown";
import type { DashboardLocale } from "./dashboard-locale";

export function getDateLocale(locale: DashboardLocale): string {
  return locale === "it" ? "it-IT" : "en-US";
}

const MESSAGES = {
  en: {
    title: "Cursor Usage",
    included: "Included",
    onDemand: "On-demand",
    unlimited: "Unlimited",
    spendUnavailable: "Spend unavailable",
    includedPool: "Included pool",
    poolFirstParty: "First-party models",
    poolApi: "API",
    grokBotWeekly: "Weekly Grok pool",
    grokBotWeeklyUsed: "{pct}% weekly allowance used",
    grokBotWeeklyResetUnknown: "Resets weekly",
    totalUsed: "{pct}% total used",
    dailyBudget: "Daily budget",
    evenSpreadUntilReset: "Even spread until reset",
    poolTargetShort: "target",
    budgetPct: "{pct}% budget",
    onBudget: "On budget",
    leftToday: "{pct}% left today",
    overBudget: "{pct}% over budget",
    dailyBudgetResetIn: "Resets in {hours}h {minutes}m ({time})",
    dailyBudgetResetInMinutes: "Resets in {minutes}m ({time})",
    dailyBudgetResetNow: "Resetting now ({time})",
    usageByModel: "Usage by Model",
    change: "Change",
    duration1d: "Today",
    duration7d: "7 days",
    duration30d: "30 days",
    durationBilling: "Current Billing Cycle",
    colModel: "Model",
    colRequests: "Requests",
    colTokens: "Tokens",
    colSpend: "Spend",
    total: "Total",
    noUsageInPeriod: "No usage in this period",
    openDashboard: "Open Dashboard",
    refresh: "Refresh",
    fetchError: "Could not fetch Cursor usage data. Click to see options.",
    usageUnavailable: "Usage unavailable",
    errorPrefix: "Error",
    warningEventsFetchFailed: "Usage events could not be refreshed; charts and activity may be outdated.",
    warningEventsIncomplete: "Partial event sync — data beyond the page limit may be missing.",
    warningSpendFetchFailed: "Daily spend breakdown could not be refreshed.",
    warningEventStoreSyncFailed: "Could not save usage events locally; showing the latest API snapshot.",
    showLogs: "Show Logs",
    usageUnavailableDetail: "Cursor usage unavailable: {error}",
    usageNotAvailableYet: "Cursor usage data is not available yet.",
    pricingSyncProgress: "Cursor Usage: syncing pricing catalog…",
    pricingSyncSuccess: "Pricing catalog updated ({updated} models refreshed, {added} new).",
    pricingSyncFailed: "Pricing catalog sync failed: {error}",
    fetchUsageFailed: "Could not fetch usage data",
    errorDetailUsageDataUnavailable:
      "Cursor could not load usage (sign-in, account setup, or API unavailable). See the Output panel “Cursor Usage” for request logs.",
    statusBarUsage: "Usage",
  },
  it: {
    title: "Utilizzo Cursor",
    included: "Incluso",
    onDemand: "On-Demand",
    unlimited: "Illimitato",
    spendUnavailable: "Spesa non disponibile",
    includedPool: "Pool incluso",
    poolFirstParty: "Modelli first-party",
    poolApi: "API",
    grokBotWeekly: "Pool Grok settimanale",
    grokBotWeeklyUsed: "{pct}% quota settimanale consumata",
    grokBotWeeklyResetUnknown: "Reset settimanale",
    totalUsed: "{pct}% totale usato",
    dailyBudget: "Budget giornaliero",
    evenSpreadUntilReset: "Distribuzione uniforme fino al reset",
    poolTargetShort: "obiettivo",
    budgetPct: "{pct}% budget",
    onBudget: "Nei limiti",
    leftToday: "{pct}% rimasti oggi",
    overBudget: "{pct}% oltre soglia",
    dailyBudgetResetIn: "Reset tra {hours}h {minutes}m ({time})",
    dailyBudgetResetInMinutes: "Reset tra {minutes}m ({time})",
    dailyBudgetResetNow: "Reset in corso ({time})",
    usageByModel: "Utilizzo per modello",
    change: "Modifica",
    duration1d: "Oggi",
    duration7d: "Ultimi 7 giorni",
    duration30d: "Ultimi 30 giorni",
    durationBilling: "Ciclo di fatturazione corrente",
    colModel: "Modello",
    colRequests: "Richieste",
    colTokens: "Token",
    colSpend: "Spesa",
    total: "Totale",
    noUsageInPeriod: "Nessun utilizzo in questo periodo",
    openDashboard: "Apri dashboard",
    refresh: "Aggiorna",
    fetchError: "Impossibile recuperare i dati di utilizzo. Clicca per le opzioni.",
    usageUnavailable: "Utilizzo non disponibile",
    errorPrefix: "Errore",
    warningEventsFetchFailed: "Impossibile aggiornare gli eventi di utilizzo; grafici e attività potrebbero essere obsoleti.",
    warningEventsIncomplete: "Sincronizzazione eventi parziale — i dati oltre il limite di pagine potrebbero mancare.",
    warningSpendFetchFailed: "Impossibile aggiornare il breakdown della spesa giornaliera.",
    warningEventStoreSyncFailed: "Impossibile salvare gli eventi in locale; mostrato l'ultimo snapshot API.",
    showLogs: "Mostra log",
    usageUnavailableDetail: "Utilizzo Cursor non disponibile: {error}",
    usageNotAvailableYet: "I dati di utilizzo Cursor non sono ancora disponibili.",
    pricingSyncProgress: "Cursor Usage: sincronizzazione catalogo prezzi…",
    pricingSyncSuccess: "Catalogo prezzi aggiornato ({updated} modelli aggiornati, {added} nuovi).",
    pricingSyncFailed: "Sincronizzazione catalogo prezzi non riuscita: {error}",
    fetchUsageFailed: "Impossibile recuperare i dati di utilizzo",
    errorDetailUsageDataUnavailable:
      "Cursor non ha potuto caricare l'utilizzo (accesso, configurazione account o API non disponibile). Controlla il pannello Output “Cursor Usage” per i log delle richieste.",
    statusBarUsage: "Utilizzo",
  },
} as const;

type MessageKey = keyof typeof MESSAGES.en;

export function t(locale: DashboardLocale, key: MessageKey): string {
  return MESSAGES[locale][key] ?? MESSAGES.en[key];
}

export function tf(locale: DashboardLocale, key: MessageKey, vars: Record<string, string | number>): string {
  let text = t(locale, key);
  for (const [name, value] of Object.entries(vars)) {
    text = text.replace(`{${name}}`, String(value));
  }
  return text;
}

export function getDurationLabel(duration: UsageDuration, locale: DashboardLocale): string {
  if (duration === "1d") return t(locale, "duration1d");
  if (duration === "7d") return t(locale, "duration7d");
  if (duration === "30d") return t(locale, "duration30d");
  return t(locale, "durationBilling");
}

export function formatResetCountdown(iso: string, locale: DashboardLocale, now = Date.now()): string {
  const reset = new Date(iso);
  const days = Math.max(0, Math.ceil((reset.getTime() - now) / 86_400_000));
  const formatted = reset.toLocaleDateString(getDateLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (locale === "it") {
    return `Reset tra ${days} ${days === 1 ? "giorno" : "giorni"} il ${formatted}`;
  }
  return `Resets in ${days} day${days === 1 ? "" : "s"} on ${formatted}`;
}
