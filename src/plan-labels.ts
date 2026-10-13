export type TeamSeatType = "standard" | "premium" | "unpaid";

export type BillingProgram = "cursor" | "x_subscription";

export type PlanInfo = {
  accountType: "team" | "personal";
  planKind: "teams" | "enterprise" | "personal";
  seatType: TeamSeatType | null;
  tier: string;
  priceLabel: string | null;
  displayName: string;
  billingProgram?: BillingProgram;
};

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  hobby: "Hobby",
  pro: "Pro",
  "pro-plus": "Pro+",
  proplus: "Pro+",
  ultra: "Ultra",
  business: "Business",
  enterprise: "Enterprise",
  team: "Teams",
  teams: "Teams",
  "self-serve": "Self Serve",
  self_serve: "Self Serve",
};

/** The X Subscription tier slugs (unverified against live API until probe fixtures exist). */
const X_SUBSCRIPTION_TIER_SLUGS = new Set([
  "x-plus",
  "x-premium",
  "x-super",
  "x-ultra",
  "x-subscription",
  "the-x-subscription",
]);

const X_SUBSCRIPTION_TIER_LABELS: Record<string, string> = {
  "x-plus": "Plus",
  "x-premium": "Premium",
  "x-super": "Super",
  "x-ultra": "Ultra",
  "x-subscription": "The X Subscription",
  "the-x-subscription": "The X Subscription",
};

export function isXSubscriptionMembership(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  return X_SUBSCRIPTION_TIER_SLUGS.has(key);
}

function formatXSubscriptionTier(key: string): string | null {
  const short = X_SUBSCRIPTION_TIER_LABELS[key];
  if (!short) return null;
  if (short === "The X Subscription") return short;
  return `The X · ${short}`;
}

export function formatMembershipTier(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  const xLabel = formatXSubscriptionTier(key);
  if (xLabel) return xLabel;
  if (TIER_LABELS[key]) return TIER_LABELS[key]!;
  return raw
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function personalDisplayName(tierRaw: string | null, tier: string): string {
  if (!isXSubscriptionMembership(tierRaw)) {
    return tier !== "Unknown" ? `Personal · ${tier}` : "Personal";
  }
  if (tier === "The X Subscription") return "The X Subscription";
  const short = tier.startsWith("The X · ") ? tier.slice("The X · ".length) : tier;
  return `The X Subscription · ${short}`;
}

export function parseTeamSeatType(input: {
  billingTier?: string | null;
  role?: string | null;
  includedLimit?: number | null;
}): TeamSeatType | null {
  const role = (input.role ?? "").toUpperCase();
  if (role.includes("UNPAID")) return "unpaid";

  const tierAmount = extractBillingTierAmount(input.billingTier);
  if (tierAmount !== null) {
    // Self-serve Teams (June 2026+): TIER_5000 = Premium (5x pool), TIER_1000 = Standard (1x).
    if (tierAmount >= 5000) return "premium";
    if (tierAmount >= 1000 || tierAmount <= 200) return "standard";
  }

  // Only infer from usage limits when billingTier is missing. Post-2026 Standard seats
  // can report plan limits well above 1500, so avoid treating those as Premium.
  if (tierAmount === null) {
    const limit = input.includedLimit ?? 0;
    if (limit >= 5000) return "premium";
    if (limit >= 300) return "standard";
  }

  return null;
}

function extractBillingTierAmount(billingTier: string | null | undefined): number | null {
  if (!billingTier) return null;
  const matches = [...billingTier.toUpperCase().matchAll(/TIER[_-]?(\d+)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  const amount = Number(last);
  return Number.isFinite(amount) ? amount : null;
}

export function formatTeamSeatLabel(
  seatType: TeamSeatType,
  isYearlyPlan = false,
): { tier: string; priceLabel: string } {
  switch (seatType) {
    case "premium":
      return {
        tier: "Premium",
        priceLabel: isYearlyPlan ? "$96/mo (annual billing)" : "$120/mo",
      };
    case "standard":
      return {
        tier: "Standard",
        priceLabel: isYearlyPlan ? "$32/mo (annual billing)" : "$40/mo",
      };
    case "unpaid":
      return { tier: "Unpaid Admin", priceLabel: "Free" };
  }
}

function resolveTeamPlanKind(
  teamMembershipType: string | null | undefined,
): PlanInfo["planKind"] {
  if (!teamMembershipType || teamMembershipType.toUpperCase() === "SELF_SERVE") {
    return "teams";
  }
  return "enterprise";
}

export function buildPlanInfo(input: {
  isTeamMember: boolean;
  limitType?: string | null;
  membershipType?: string | null;
  individualMembershipType?: string | null;
  teamMembershipType?: string | null;
  billingTier?: string | null;
  role?: string | null;
  includedLimit?: number | null;
  isYearlyPlan?: boolean;
}): PlanInfo {
  const accountType: PlanInfo["accountType"] =
    input.isTeamMember || input.limitType === "team" ? "team" : "personal";

  if (accountType === "team") {
    const planKind = resolveTeamPlanKind(input.teamMembershipType);
    const seatType = parseTeamSeatType({
      billingTier: input.billingTier,
      role: input.role,
      includedLimit: input.includedLimit,
    });

    if (planKind === "enterprise") {
      return {
        accountType: "team",
        planKind: "enterprise",
        seatType: null,
        tier: "Enterprise",
        priceLabel: null,
        displayName: "Enterprise",
        billingProgram: "cursor",
      };
    }

    if (seatType === "unpaid") {
      const seat = formatTeamSeatLabel(seatType, input.isYearlyPlan);
      return {
        accountType: "team",
        planKind: "teams",
        seatType,
        tier: seat.tier,
        priceLabel: seat.priceLabel,
        displayName: `Teams · ${seat.tier}`,
        billingProgram: "cursor",
      };
    }

    if (seatType) {
      const seat = formatTeamSeatLabel(seatType, input.isYearlyPlan);
      return {
        accountType: "team",
        planKind: "teams",
        seatType,
        tier: seat.tier,
        priceLabel: seat.priceLabel,
        displayName: `Teams · ${seat.tier} (${seat.priceLabel})`,
        billingProgram: "cursor",
      };
    }

    return {
      accountType: "team",
      planKind: "teams",
      seatType: null,
      tier: "Teams",
      priceLabel: null,
      displayName: "Teams",
      billingProgram: "cursor",
    };
  }

  const tierRaw = input.individualMembershipType ?? input.membershipType ?? null;
  const tier = formatMembershipTier(tierRaw);
  const xSub = isXSubscriptionMembership(tierRaw);
  return {
    accountType: "personal",
    planKind: "personal",
    seatType: null,
    tier,
    priceLabel: null,
    displayName: personalDisplayName(tierRaw, tier),
    billingProgram: xSub ? "x_subscription" : "cursor",
  };
}
