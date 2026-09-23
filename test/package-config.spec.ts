import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import packageJson from "../package.json";

describe("package configuration", () => {
  it("shows a friendly label for billing cycle in the usage duration setting", () => {
    const usageDurationConfig = packageJson.contributes.configuration.properties["cursorUsage.usageDuration"];

    expect(usageDurationConfig.enum).toContain("billingCycle");
    expect(usageDurationConfig.enumItemLabels).toEqual([
      "Today",
      "Last 7 days",
      "Last 30 days",
      "Current Billing Cycle",
    ]);
  });

  it("keeps the display name while using a unique VS Marketplace package id", () => {
    const packageScript = readFileSync("scripts/package-extension.mjs", "utf-8");
    const prepareVsmScript = readFileSync("scripts/prepare-vsm-package.mjs", "utf-8");

    expect(packageJson.displayName).toBe("Cursor Usage (Community)");
    expect(packageJson.publisher).toBe("fabervi");
    expect(packageScript).toContain("cursor-usage-auto");
    expect(prepareVsmScript).toContain("cursor-usage-auto");
    expect(packageJson.scripts["publish:vsm"]).toContain("publish-extension.mjs vsm");
  });

  it("exposes model table sorting settings with token-desc defaults", () => {
    const sortByConfig = packageJson.contributes.configuration.properties["cursorUsage.modelBreakdownSortBy"];
    const sortOrderConfig = packageJson.contributes.configuration.properties["cursorUsage.modelBreakdownSortOrder"];

    expect(sortByConfig.default).toBe("tokens");
    expect(sortByConfig.enum).toEqual(["model", "requests", "tokens", "spend"]);
    expect(sortByConfig.enumItemLabels).toEqual(["Model", "Requests", "Tokens", "Spend"]);

    expect(sortOrderConfig.default).toBe("desc");
    expect(sortOrderConfig.enum).toEqual(["asc", "desc"]);
    expect(sortOrderConfig.enumItemLabels).toEqual(["Ascending", "Descending"]);
  });

  it("exposes a setting to hide zero-token models in the breakdown", () => {
    const hideZeroTokenConfig = packageJson.contributes.configuration.properties["cursorUsage.excludeZeroTokenModels"];

    expect(hideZeroTokenConfig.default).toBe(false);
    expect(hideZeroTokenConfig.type).toBe("boolean");
  });

  it("exposes a setting for quota-aware event display", () => {
    const quotaAwareConfig = packageJson.contributes.configuration.properties["cursorUsage.quotaAwareEventDisplay"];

    expect(quotaAwareConfig.default).toBe(true);
    expect(quotaAwareConfig.type).toBe("boolean");
  });

  it("does not depend on external sqlite binaries or native bindings", () => {
    const vscodeIgnore = readFileSync(".vscodeignore", "utf-8").split(/\r?\n/);
    const esbuildConfig = readFileSync("esbuild.config.mjs", "utf-8");

    expect(packageJson.dependencies).toEqual({ "sql.js": "^1.14.2" });
    expect(packageJson.engines.vscode).toBe("^1.128.0");
    expect(packageJson.scripts.package).not.toContain("--no-dependencies");
    expect(packageJson.scripts["package:vsm"]).not.toContain("--no-dependencies");
    expect(vscodeIgnore).toContain("node_modules/");
    expect(vscodeIgnore).toContain("!node_modules/sql.js/");
    expect(vscodeIgnore).toContain("node-compile-cache/");
    expect(vscodeIgnore).toContain("test/");
    expect(vscodeIgnore).toContain(".github/");
    expect(vscodeIgnore).toContain("media/dashboard/modules/");
    expect(vscodeIgnore).toContain("media/dashboard/screenshot-*.html");
    expect(vscodeIgnore).toContain("**/*.map");
    expect(esbuildConfig).toContain('"sql.js"');
  });
});
