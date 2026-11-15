/// <reference path="../types/bun-test.d.ts" />
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";

describe("billing cycle card", () => {
  it("uses the UTC billing cutoff instead of a local month shift", () => {
    const source = readFileSync(
      join(import.meta.dir, "../media/dashboard/modules/summary-cards.js"),
      "utf8",
    );
    expect(source).toContain("getBillingCycleCutoff(");
    expect(source).not.toContain("setMonth(");
  });
});
