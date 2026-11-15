/// <reference path="../types/bun-test.d.ts" />
import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_EUR_USD_RATE } from "../src/dashboard-locale";
import { getEurPerUsd, parseEurPerUsd, refreshEurPerUsd, setEurPerUsd } from "../src/eur-usd-rate";

describe("parseEurPerUsd", () => {
  afterEach(() => {
    setEurPerUsd(DEFAULT_EUR_USD_RATE);
  });

  it("reads a positive EUR rate from a Frankfurter payload", () => {
    expect(parseEurPerUsd({ rates: { EUR: 0.86 } })).toBe(0.86);
  });

  it("rejects a missing or non-positive rate", () => {
    expect(parseEurPerUsd({})).toBeNull();
    expect(parseEurPerUsd({ rates: { EUR: 0 } })).toBeNull();
    expect(parseEurPerUsd(null)).toBeNull();
  });

  it("stores a valid rate and ignores an invalid one", () => {
    setEurPerUsd(0.86);
    expect(getEurPerUsd()).toBe(0.86);
    setEurPerUsd(Number.NaN);
    expect(getEurPerUsd()).toBe(0.86);
  });

  it("keeps the previous rate when the request fails", async () => {
    setEurPerUsd(0.86);
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("offline"));
    try {
      expect(await refreshEurPerUsd()).toBe(0.86);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stores the rate from a successful response", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(Response.json({ rates: { EUR: 0.86 } }));
    try {
      expect(await refreshEurPerUsd()).toBe(0.86);
      expect(getEurPerUsd()).toBe(0.86);
    } finally {
      globalThis.fetch = original;
    }
  });
});
