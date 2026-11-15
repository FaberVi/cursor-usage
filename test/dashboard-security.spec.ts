import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { renderDashboardHtml } from "../src/dashboard/dashboard-html";
import { isSafeConversationId } from "../src/dashboard-panel";

describe("dashboard security hardening", () => {
  it("guards CSV exports against spreadsheet formula injection", () => {
    const dashboardScript = readFileSync("media/dashboard/modules/tables-export.js", "utf-8");

    expect(dashboardScript).toContain("/^\\s*[=+\\-@]/");
    expect(dashboardScript).toContain("\"'\" + s");
  });

  it("escapes event kind in the usage events table", () => {
    const eventsScript = readFileSync("media/dashboard/modules/tables-events.js", "utf-8");
    expect(eventsScript).toContain("escapeHtml(e.kind)");
    expect(eventsScript).toContain("kind-Unknown");
    expect(eventsScript).not.toContain("e.kind.replace(/[^A-Za-z]/g, \"\")");
  });

  it("embeds a CSP nonce on dashboard scripts", () => {
    const uri = (path: string) => ({ toString: () => path });
    const html = renderDashboardHtml(
      { cspSource: "https://test-csp" },
      {
        cssUri: uri("css") as never,
        jsUri: uri("js") as never,
        chartUri: uri("chart") as never,
      },
      "test-nonce",
    );
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce' https://test-csp");
    expect(html).toContain('<script nonce="test-nonce" src="chart">');
    expect(html).toContain('<script nonce="test-nonce" src="js">');
  });

  it("accepts hex UUID conversation ids and rejects unsafe values", () => {
    expect(isSafeConversationId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(isSafeConversationId("")).toBe(false);
    expect(isSafeConversationId("abc%def")).toBe(false);
    expect(isSafeConversationId("abc_def")).toBe(false);
    expect(isSafeConversationId("id with space")).toBe(false);
    expect(isSafeConversationId("a".repeat(129))).toBe(false);
  });
});
