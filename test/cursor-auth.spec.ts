/// <reference path="../types/bun-test.d.ts" />
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getCursorToken, resetCursorAuthCache } from "../src/cursor-auth";

const authDir = mkdtempSync(join(tmpdir(), "cursor-auth-spec-"));
const existingDbPath = join(authDir, "state.vscdb");
writeFileSync(existingDbPath, "");
const missingDbPath = join(authDir, "missing.vscdb");

let dbPath = existingDbPath;
let authValues: Record<string, string> = {};

const readCursorAuthValuesMock = mock(async (_path: string) => authValues);
const invalidateSetupCacheMock = mock(() => {});
const openCursorAuthSecretMock = mock(async (stored: string) => stored);

mock.module("../src/cursor-db-reader", () => ({
  getGlobalCursorDbPath: () => dbPath,
}));

mock.module("../src/db-worker-client", () => ({
  readCursorAuthValues: readCursorAuthValuesMock,
}));

mock.module("../src/cursor-safe-storage", () => ({
  openCursorAuthSecret: openCursorAuthSecretMock,
}));

mock.module("../src/cursor-setup-cache", () => ({
  invalidateSetupCache: invalidateSetupCacheMock,
}));

function fakeJwt(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub })}.sig`;
}

const jwtUser1 = fakeJwt("team|user-1");
const jwtUser2 = fakeJwt("team|user-2");

const FAKE_NOW_BASE = Date.UTC(2026, 0, 1);
// Oltre AUTH_CACHE_TTL (5s): forza una rilettura del DB.
const PAST_TTL_MS = 6_000;

let fakeNow = FAKE_NOW_BASE;
let nowSpy: ReturnType<typeof spyOn>;

describe("getCursorToken", () => {
  beforeEach(() => {
    // Ogni test parte da cache e clock puliti: niente dipendenza dall'ordine.
    resetCursorAuthCache();
    fakeNow = FAKE_NOW_BASE;
    dbPath = existingDbPath;
    authValues = {};
    // mockImplementation (non mockReturnValue) così legge fakeNow aggiornato a ogni chiamata.
    nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    readCursorAuthValuesMock.mockClear();
    invalidateSetupCacheMock.mockClear();
    openCursorAuthSecretMock.mockClear();
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("returns null when the Cursor database file is missing", async () => {
    dbPath = missingDbPath;
    await expect(getCursorToken()).resolves.toBeNull();
    expect(readCursorAuthValuesMock).not.toHaveBeenCalled();
  });

  it("does not serve the cached token after the database file is removed", async () => {
    authValues = {
      "cursorAuth/accessToken": jwtUser1,
      "cursorAuth/cachedEmail": "user1@example.com",
    };

    const first = await getCursorToken();
    expect(first?.userId).toBe("user-1");
    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(1);

    // Il DB sparisce entro il TTL: il token cached non va servito.
    dbPath = missingDbPath;
    await expect(getCursorToken()).resolves.toBeNull();
    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the worker-side auth read fails", async () => {
    authValues = { "cursorAuth/accessToken": jwtUser1 };
    readCursorAuthValuesMock.mockImplementationOnce(() =>
      Promise.reject(new Error("worker exploded")),
    );
    await expect(getCursorToken()).resolves.toBeNull();
  });

  it("serves the token from cache without re-reading the DB within the TTL", async () => {
    authValues = {
      "cursorAuth/accessToken": jwtUser1,
      "cursorAuth/cachedEmail": "user1@example.com",
    };

    const first = await getCursorToken();
    const second = await getCursorToken();

    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(1);
    expect(first?.userId).toBe("user-1");
    expect(first?.email).toBe("user1@example.com");
    expect(first?.sessionToken).toContain("user-1");
    expect(second).toEqual(first);
  });

  it("re-reads auth values after the TTL and keeps the setup cache on the same token", async () => {
    authValues = { "cursorAuth/accessToken": jwtUser1 };

    await getCursorToken();
    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(1);
    // Il primo fetch invalida la setup cache (sessionToken da null): si
    // azzera il mock per contare solo le chiamate successive.
    invalidateSetupCacheMock.mockClear();

    fakeNow += PAST_TTL_MS;
    const info = await getCursorToken();

    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(2);
    expect(info?.userId).toBe("user-1");
    expect(invalidateSetupCacheMock).not.toHaveBeenCalled();
  });

  it("invalidates the setup cache when the token changes", async () => {
    authValues = { "cursorAuth/accessToken": jwtUser1 };
    await getCursorToken();
    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(1);
    invalidateSetupCacheMock.mockClear();

    authValues = {
      "cursorAuth/accessToken": jwtUser2,
      "cursorAuth/cachedEmail": "user2@example.com",
    };
    fakeNow += PAST_TTL_MS;

    const info = await getCursorToken();

    expect(readCursorAuthValuesMock).toHaveBeenCalledTimes(2);
    expect(info?.userId).toBe("user-2");
    expect(invalidateSetupCacheMock).toHaveBeenCalledTimes(1);
  });
});
