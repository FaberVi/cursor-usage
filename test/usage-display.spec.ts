import { describe, expect, it } from "bun:test";
import { buildPlanInfo } from "../src/plan-labels";
import { isIncludedQuotaExhausted, shouldShowPremiumRequestsQuota } from "../src/usage-display";

const teamPlan = buildPlanInfo({
  isTeamMember: true,
  limitType: "team",
  membershipType: "enterprise",
  teamMembershipType: "enterprise",
});

const personalPlan = buildPlanInfo({
  isTeamMember: false,
  membershipType: "pro",
  individualMembershipType: "pro",
});

const poolUsage = { autoPercentUsed: 50, apiPercentUsed: 100, totalPercentUsed: 75 };

describe("shouldShowPremiumRequestsQuota", () => {
  it("hides legacy request counter when pool usage is available", () => {
    expect(shouldShowPremiumRequestsQuota(personalPlan, poolUsage)).toBeFalse();
    expect(shouldShowPremiumRequestsQuota(teamPlan, poolUsage)).toBeFalse();
  });

  it("hides legacy request counter for team accounts without pool data", () => {
    expect(shouldShowPremiumRequestsQuota(teamPlan, null)).toBeFalse();
  });

  it("shows legacy request counter for personal accounts without pool data", () => {
    expect(shouldShowPremiumRequestsQuota(personalPlan, null)).toBeTrue();
    expect(shouldShowPremiumRequestsQuota(null, null)).toBeTrue();
  });
});

describe("isIncludedQuotaExhausted", () => {
  it("uses request quota for legacy personal plans", () => {
    expect(
      isIncludedQuotaExhausted(
        { includedRequests: { used: 500, limit: 500 }, poolUsage: null },
        true,
      ),
    ).toBeTrue();
    expect(
      isIncludedQuotaExhausted(
        { includedRequests: { used: 100, limit: 500 }, poolUsage: null },
        true,
      ),
    ).toBeFalse();
  });

  it("uses total pool percent for current pool-based plans", () => {
    expect(
      isIncludedQuotaExhausted(
        {
          includedRequests: { used: 2000, limit: 2000 },
          poolUsage: { autoPercentUsed: 50, apiPercentUsed: 100, totalPercentUsed: 100 },
        },
        false,
      ),
    ).toBeTrue();
    expect(
      isIncludedQuotaExhausted(
        {
          includedRequests: { used: 2000, limit: 2000 },
          poolUsage: { autoPercentUsed: 50, apiPercentUsed: 80, totalPercentUsed: 70 },
        },
        false,
      ),
    ).toBeFalse();
  });

  it("treats the displayed 100% pool total as exhausted", () => {
    expect(
      isIncludedQuotaExhausted(
        {
          includedRequests: { used: 2000, limit: 2000 },
          poolUsage: { autoPercentUsed: 60, apiPercentUsed: 99.96, totalPercentUsed: 99.97 },
        },
        false,
      ),
    ).toBeTrue();
    expect(
      isIncludedQuotaExhausted(
        {
          includedRequests: { used: 2000, limit: 2000 },
          poolUsage: { autoPercentUsed: 60, apiPercentUsed: 80, totalPercentUsed: 99.94 },
        },
        false,
      ),
    ).toBeFalse();
  });
});
