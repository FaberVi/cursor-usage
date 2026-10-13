import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildPlanInfo,
  formatMembershipTier,
  formatTeamSeatLabel,
  isXSubscriptionMembership,
  parseTeamSeatType,
} from "../src/plan-labels";

const fixturesDir = join(import.meta.dir, "fixtures");

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(join(fixturesDir, `${name}.json`), "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("formatMembershipTier", () => {
  it("maps known membership slugs to friendly labels", () => {
    expect(formatMembershipTier("enterprise")).toBe("Enterprise");
    expect(formatMembershipTier("pro")).toBe("Pro");
    expect(formatMembershipTier("ultra")).toBe("Ultra");
  });

  // Slugs below are hypothetical until verified with probe-cursor-api on a live X Subscription account.
  it("maps The X Subscription tier slugs", () => {
    expect(formatMembershipTier("x_premium")).toBe("The X · Premium");
    expect(formatMembershipTier("x-plus")).toBe("The X · Plus");
    expect(formatMembershipTier("x_subscription")).toBe("The X Subscription");
    expect(isXSubscriptionMembership("x_super")).toBeTrue();
    expect(isXSubscriptionMembership("pro")).toBeFalse();
  });
});

describe("parseTeamSeatType", () => {
  it("maps billingTier TIER_5000 to premium", () => {
    expect(
      parseTeamSeatType({ billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_5000" }),
    ).toBe("premium");
  });

  it("maps billingTier TIER_1000 to standard", () => {
    expect(
      parseTeamSeatType({ billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_1000" }),
    ).toBe("standard");
  });

  it("maps billingTier TIER_200 to standard", () => {
    expect(parseTeamSeatType({ billingTier: "TIER_200" })).toBe("standard");
  });

  it("infers premium from high included limits only when billingTier is missing", () => {
    expect(parseTeamSeatType({ includedLimit: 6000 })).toBe("premium");
    expect(parseTeamSeatType({ includedLimit: 2000 })).toBe("standard");
    expect(parseTeamSeatType({ includedLimit: 400 })).toBe("standard");
  });

  it("prefers billingTier over includedLimit when both are present", () => {
    expect(
      parseTeamSeatType({
        billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_1000",
        includedLimit: 2000,
      }),
    ).toBe("standard");
  });
});

describe("buildPlanInfo", () => {
  it("builds Teams Standard from real fixtures and billingTier TIER_1000", () => {
    const stripeFixture = loadFixture("stripe");
    const usageSummaryFixture = loadFixture("usage-summary");
    const plan = buildPlanInfo({
      isTeamMember: Boolean(stripeFixture.isTeamMember),
      limitType: typeof usageSummaryFixture.limitType === "string" ? usageSummaryFixture.limitType : null,
      membershipType:
        typeof usageSummaryFixture.membershipType === "string" ? usageSummaryFixture.membershipType : null,
      individualMembershipType:
        typeof stripeFixture.individualMembershipType === "string"
          ? stripeFixture.individualMembershipType
          : null,
      teamMembershipType:
        typeof stripeFixture.teamMembershipType === "string" ? stripeFixture.teamMembershipType : null,
      billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_1000",
      role: "TEAM_ROLE_OWNER",
      includedLimit: 2000,
      isYearlyPlan: false,
    });

    expect(plan.planKind).toBe("teams");
    expect(plan.seatType).toBe("standard");
    expect(plan.tier).toBe("Standard");
    expect(plan.priceLabel).toBe("$40/mo");
    expect(plan.displayName).toBe("Teams · Standard ($40/mo)");
  });

  it("builds Teams Premium for TIER_5000", () => {
    const plan = buildPlanInfo({
      isTeamMember: true,
      limitType: "team",
      teamMembershipType: "SELF_SERVE",
      billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_5000",
      includedLimit: 2000,
    });

    expect(plan.seatType).toBe("premium");
    expect(plan.tier).toBe("Premium");
    expect(plan.priceLabel).toBe("$120/mo");
    expect(plan.displayName).toBe("Teams · Premium ($120/mo)");
  });

  it("builds Teams Standard for TIER_200", () => {
    const plan = buildPlanInfo({
      isTeamMember: true,
      limitType: "team",
      teamMembershipType: "SELF_SERVE",
      billingTier: "TIER_200",
      includedLimit: 400,
    });

    expect(plan.seatType).toBe("standard");
    expect(plan.tier).toBe("Standard");
    expect(plan.priceLabel).toBe("$40/mo");
    expect(plan.displayName).toBe("Teams · Standard ($40/mo)");
  });

  it("builds a personal pro label", () => {
    const plan = buildPlanInfo({
      isTeamMember: false,
      membershipType: "pro",
      individualMembershipType: "pro",
    });

    expect(plan.accountType).toBe("personal");
    expect(plan.tier).toBe("Pro");
    expect(plan.displayName).toBe("Personal · Pro");
    expect(plan.billingProgram).toBe("cursor");
  });

  it("builds The X Subscription personal label from hypothetical slug", () => {
    const plan = buildPlanInfo({
      isTeamMember: false,
      membershipType: "x_premium",
      individualMembershipType: "x_premium",
    });

    expect(plan.tier).toBe("The X · Premium");
    expect(plan.displayName).toBe("The X Subscription · Premium");
    expect(plan.billingProgram).toBe("x_subscription");
  });
});

describe("formatTeamSeatLabel", () => {
  it("shows annual pricing when isYearlyPlan is true", () => {
    expect(formatTeamSeatLabel("premium", true).priceLabel).toBe("$96/mo (annual billing)");
    expect(formatTeamSeatLabel("standard", true).priceLabel).toBe("$32/mo (annual billing)");
  });
});
