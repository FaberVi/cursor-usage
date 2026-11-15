import { describe, expect, it } from "bun:test";
import { getBillingCycleCutoff, matchesTeamMember, nextMonth, safeJson, shiftUtcMonth } from "../src/cursor-api-utils";

describe("shiftUtcMonth", () => {
  it("clamps end-of-month days instead of overflowing into the next month", () => {
    expect(shiftUtcMonth(Date.parse("2026-03-31T15:37:46.000Z"), -1)).toBe("2026-02-28T15:37:46.000Z");
    expect(shiftUtcMonth(Date.parse("2026-01-31T12:00:00.000Z"), 1)).toBe("2026-02-28T12:00:00.000Z");
  });

  it("keeps mid-month days stable across UTC month shifts", () => {
    expect(shiftUtcMonth(Date.parse("2026-08-02T15:37:46.000Z"), -1)).toBe("2026-07-02T15:37:46.000Z");
  });
});

describe("getBillingCycleCutoff", () => {
  it("subtracts one UTC month from the reset timestamp", () => {
    const cutoff = getBillingCycleCutoff("2026-08-02T15:37:46.000Z", Date.UTC(2026, 6, 5));
    expect(cutoff).toBe(Date.parse("2026-07-02T15:37:46.000Z"));
  });

  it("does not collapse March 31 resets into early March", () => {
    const cutoff = getBillingCycleCutoff("2026-03-31T15:37:46.000Z", Date.UTC(2026, 2, 15));
    expect(cutoff).toBe(Date.parse("2026-02-28T15:37:46.000Z"));
  });

  it("clamps a midnight March 31 reset to February 28", () => {
    const cutoff = getBillingCycleCutoff("2026-03-31T00:00:00.000Z", Date.UTC(2026, 3, 1));
    expect(cutoff).toBe(Date.parse("2026-02-28T00:00:00.000Z"));
  });
});

describe("nextMonth", () => {
  it("advances by one UTC month with day clamping", () => {
    expect(nextMonth("2026-01-31T12:00:00.000Z")).toBe("2026-02-28T12:00:00.000Z");
    expect(nextMonth("2026-07-02T15:37:46.000Z")).toBe("2026-08-02T15:37:46.000Z");
  });
});

describe("safeJson", () => {
  it("parses a JSON body", async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
    expect(await safeJson(res)).toEqual({ ok: true });
  });

  it("returns null for an HTML body instead of throwing", async () => {
    const res = new Response("<html>error</html>", {
      headers: { "content-type": "text/html" },
    });
    expect(await safeJson(res)).toBeNull();
  });
});

describe("matchesTeamMember", () => {
  const auth = { email: "me@example.com", userId: "auth-uuid" };

  it("matches on authId when email and numeric userId differ", () => {
    expect(
      matchesTeamMember(
        { email: "other@example.com", authId: "auth-uuid", userId: 4242 },
        { email: null, userId: "auth-uuid" },
      ),
    ).toBe(true);
  });

  it("matches on email alone", () => {
    expect(
      matchesTeamMember(
        { email: "me@example.com", authId: "someone-else", userId: 99 },
        auth,
      ),
    ).toBe(true);
  });

  it("does not match a JWT uuid against a numeric userId without email or authId", () => {
    expect(
      matchesTeamMember(
        { email: "other@example.com", userId: 4242 },
        { email: null, userId: "auth-uuid" },
      ),
    ).toBe(false);
  });
});
