import type { DashboardCurrency, DashboardLocale } from "./dashboard-locale";
import { getEurPerUsd } from "./eur-usd-rate";
import type { OnDemandUsage } from "./on-demand";
import { getOnDemandDisplaySpend } from "./on-demand";

function getIntlLocale(locale: DashboardLocale): string {
  return locale === "it" ? "it-IT" : "en-US";
}

export function formatMoney(
  amountUsd: number,
  currency: DashboardCurrency,
  locale: DashboardLocale,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number },
): string {
  const minFrac = options?.minimumFractionDigits ?? 2;
  const maxFrac = options?.maximumFractionDigits ?? 2;
  const intlLocale = getIntlLocale(locale);

  if (currency === "eur") {
    const eur = (amountUsd || 0) * getEurPerUsd();
    return new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    }).format(eur);
  }

  return new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  }).format(amountUsd || 0);
}

export function formatMoneyFromCents(
  cents: number,
  currency: DashboardCurrency,
  locale: DashboardLocale,
): string {
  if (!Number.isFinite(cents) || cents === 0) {
    return formatMoney(0, currency, locale);
  }
  const dollars = cents / 100;
  if (dollars > 0 && dollars < 1) {
    return formatMoney(dollars, currency, locale, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }
  return formatMoney(dollars, currency, locale);
}

export function formatOnDemandSpend(
  onDemand: OnDemandUsage,
  currency: DashboardCurrency,
  locale: DashboardLocale,
): string {
  const spendDollars = getOnDemandDisplaySpend(onDemand);
  if (
    onDemand.state === "unlimited" ||
    onDemand.onDemandEnabled === false ||
    onDemand.breakdown?.isTeamPool
  ) {
    return formatMoney(spendDollars, currency, locale);
  }
  return `${formatMoney(spendDollars, currency, locale)} / ${formatMoney(onDemand.limitDollars ?? 0, currency, locale)}`;
}

export function formatOnDemandStatus(
  onDemand: OnDemandUsage,
  currency: DashboardCurrency,
  locale: DashboardLocale,
): string {
  const spendDollars = getOnDemandDisplaySpend(onDemand);
  if (onDemand.state === "unlimited") {
    return formatMoney(spendDollars, currency, locale);
  }
  return `${formatMoney(spendDollars, currency, locale)}/${formatMoney(onDemand.limitDollars ?? 0, currency, locale)}`;
}
