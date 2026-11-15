import { describe, expect, it } from "bun:test";
import type { UsagePayload } from "../src/cursor-api";
import { formatModelLabel } from "../src/model-labels";
import { buildPoolUsageMarkdown, formatStatusBarUsageText } from "../src/pool-usage";

describe("formatModelLabel", () => {
  it("maps default to Auto", () => {
    expect(formatModelLabel("default")).toBe("Auto");
  });

  it("resolves effort-tier slugs to catalog display names", () => {
    expect(formatModelLabel("gpt-5.5-high")).toBe("GPT-5.5");
    expect(formatModelLabel("claude-4-sonnet-thinking-high")).toBe("Claude 4 Sonnet");
    expect(formatModelLabel("composer-2.5-fast")).toBe("Composer 2.5");
    expect(formatModelLabel("cursor-grok-4.6")).toBe("Cursor Grok 4.6");
    expect(formatModelLabel("cursor-grok-4.6-fast")).toBe("Cursor Grok 4.6");
  });
});

describe("buildPoolUsageMarkdown", () => {
  it("renders First-party models and API pool bars", () => {
    const markdown = buildPoolUsageMarkdown(
      { autoPercentUsed: 46.1, apiPercentUsed: 3.7, totalPercentUsed: 30.8 },
      { html: (ratio) => `<bar:${ratio.toFixed(2)}>` },
      "en",
    );

    expect(markdown).toContain("30.8% total used");
    expect(markdown).toContain("First-party models");
    expect(markdown).toContain("46.1%");
    expect(markdown).toContain("API");
    expect(markdown).toContain("3.7%");
    expect(markdown).toContain("<bar:0.46>");
    expect(markdown).toContain("<bar:0.04>");
  });
});

describe("formatStatusBarUsageText", () => {
  const base: Pick<UsagePayload, "includedRequests" | "onDemand" | "poolUsage" | "grokBotUsage"> = {
    includedRequests: { used: 2000, limit: 2000 },
    onDemand: { state: "limited", onDemandEnabled: true, spendDollars: 0, limitDollars: 50 },
    poolUsage: { autoPercentUsed: 33, apiPercentUsed: 12, totalPercentUsed: 31 },
    grokBotUsage: null,
  };

  it("includes First-party models and API percentages after requests", () => {
    expect(formatStatusBarUsageText(base, { onDemandVisible: true })).toBe(
      "2000/2000, 33% First-party models, 12% API, $0.00/$50.00",
    );
  });

  it("omits legacy request counter when showPremiumRequests is false", () => {
    expect(formatStatusBarUsageText(base, { onDemandVisible: true, showPremiumRequests: false })).toBe(
      "33% First-party models, 12% API, $0.00/$50.00",
    );
  });

  it("omits pool percentages when poolUsage is null", () => {
    expect(
      formatStatusBarUsageText({ ...base, poolUsage: null }, { onDemandVisible: true }),
    ).toBe("2000/2000, $0.00/$50.00");
  });

  it("omits on-demand when not visible", () => {
    expect(formatStatusBarUsageText(base, { onDemandVisible: false })).toBe(
      "2000/2000, 33% First-party models, 12% API",
    );
  });

  it("formats on-demand spend in EUR", () => {
    expect(
      formatStatusBarUsageText(
        {
          ...base,
          onDemand: { state: "limited", onDemandEnabled: true, spendDollars: 10, limitDollars: 50 },
        },
        { onDemandVisible: true, currency: "eur", locale: "en" },
      ),
    ).toBe("2000/2000, 33% First-party models, 12% API, €9.20/€46.00");
  });
});
