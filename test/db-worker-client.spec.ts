/// <reference types="node" />
/// <reference path="../types/bun-test.d.ts" />
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  activeDbWorker,
  configureDbWorker,
  kvReadBatch,
  lookupConversationTitles,
  readCursorAuthValues,
  shutdownDbWorker,
  usageEventStoreApi,
} from "../src/db-worker-client";
import type { KvReadOp } from "../src/db-worker-protocol";
import { usageEvent } from "./usage-event-fixture";

const storageDir = mkdtempSync(join(tmpdir(), "cursor-usage-dbworker-"));
configureDbWorker({ storageDir, extensionPath: process.cwd() });

function createCursorDb(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-worker-db-")), "state.vscdb");
  const db = new Database(dbPath);
  db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.run("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/accessToken", "sealed-token"]);
  db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/cachedEmail", "worker@example.com"]);
  db.run("INSERT INTO ItemTable VALUES (?, ?)", [
    "composer.composerHeaders",
    JSON.stringify({ allComposers: [{ composerId: "conv-a", name: "From headers" }] }),
  ]);
  db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
    "composerData:conv-b",
    JSON.stringify({ name: "Composer fallback" }),
  ]);
  db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
    "bubbleId:conv-a:b1",
    JSON.stringify({ type: 1, text: "hi" }),
  ]);
  db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
    "bubbleId:conv-a:b2",
    JSON.stringify({ type: 2, text: "yo" }),
  ]);
  db.close();
  return dbPath;
}

const cursorDbPath = createCursorDb();

afterAll(() => {
  shutdownDbWorker();
});

describe("db worker client", () => {
  // Questo test deve restare il primo: verifica il rifiuto delle richieste
  // pendenti quando il worker viene terminato durante storeInit.
  it("rejects in-flight requests when the worker is shut down", async () => {
    const api = usageEventStoreApi();
    const initPromise = api.init();
    expect(activeDbWorker()).not.toBeNull();

    shutdownDbWorker();

    await expect(initPromise).rejects.toThrow("db worker shut down");
    expect(activeDbWorker()).toBeNull();
  });

  it("respawns the worker and serves calls again after a shutdown", async () => {
    const api = usageEventStoreApi();
    await api.init();
    await expect(api.getEventCount()).resolves.toBeGreaterThanOrEqual(0);

    const result = await kvReadBatch(cursorDbPath, [
      { op: "get", table: "ItemTable", key: "cursorAuth/accessToken" },
    ]);
    expect(result?.[0]).toBe("sealed-token");
    expect(activeDbWorker()).not.toBeNull();
  });

  it("runs get/getMany/getByPrefix ops in a single batch", async () => {
    const result = await kvReadBatch(cursorDbPath, [
      { op: "get", table: "ItemTable", key: "cursorAuth/accessToken" },
      { op: "getMany", table: "cursorDiskKV", keys: ["composerData:conv-b", "missing-key"] },
      { op: "getByPrefix", table: "cursorDiskKV", prefix: "bubbleId:conv-a:" },
    ]);

    expect(result).not.toBeNull();
    expect(result![0]).toBe("sealed-token");

    const many = result![1] as [string, string][];
    expect(many).toHaveLength(1);
    expect(many[0]![0]).toBe("composerData:conv-b");
    expect(many[0]![1]).toContain("Composer fallback");

    const bubbles = result![2] as { key: string; value: string }[];
    expect(bubbles.map((row) => row.key).sort()).toEqual([
      "bubbleId:conv-a:b1",
      "bubbleId:conv-a:b2",
    ]);
  });

  it("returns null when the state.vscdb file does not exist", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "cursor-worker-missing-")), "state.vscdb");
    const ops: KvReadOp[] = [{ op: "get", table: "ItemTable", key: "anything" }];
    await expect(kvReadBatch(missing, ops)).resolves.toBeNull();
  });

  it("propagates worker-side errors to the caller", async () => {
    // withCursorKvStore ingoia gli errori e restituisce null, quindi il percorso
    // di errore si verifica su readAuthValues con un file non SQLite.
    const garbage = join(mkdtempSync(join(tmpdir(), "cursor-worker-garbage-")), "state.vscdb");
    writeFileSync(garbage, "this is not a sqlite database");
    await expect(readCursorAuthValues(garbage)).rejects.toThrow();
  });

  it("reads auth values through the worker", async () => {
    await expect(readCursorAuthValues(cursorDbPath)).resolves.toEqual({
      "cursorAuth/accessToken": "sealed-token",
      "cursorAuth/cachedEmail": "worker@example.com",
    });
  });

  it("resolves conversation titles in a single worker-side session", async () => {
    const titles = await lookupConversationTitles(cursorDbPath, [
      "conv-a",
      "conv-b",
      "conv-missing",
    ]);
    expect(titles).toEqual({
      "conv-a": "From headers",
      "conv-b": "Composer fallback",
    });
  });

  it("persists events and survives a worker-side store close", async () => {
    const api = usageEventStoreApi();
    await api.init();
    const before = await api.getEventCount();

    const event = usageEvent({
      timestamp: Date.now(),
      model: "worker-model",
      kind: "Included",
      totalTokens: 42,
      spendCents: 0,
    });
    await api.upsertEvents([event]);
    expect(await api.getEventCount()).toBe(before + 1);
    expect(await api.getGrokBotEventCount()).toBe(0);

    const recent = await api.getEventsSince(Date.now() - 60_000);
    expect(recent.some((e) => e.model === "worker-model" && e.totalTokens === 42)).toBeTrue();

    // purgeEventsBefore rimuove la riga e persiste di conseguenza.
    expect(await api.purgeEventsBefore(Date.now() + 60_000)).toBe(1);
    expect(await api.getEventCount()).toBe(before);

    // closeStore nel worker + nuova init: i dati vengono riletti da disco.
    await api.flushPersist();
    await api.close();
    expect(await api.getEventCount()).toBe(before);
  });

  it("reuses the events snapshot until the store content changes", async () => {
    const api = usageEventStoreApi();
    await api.init();
    const since = Date.now() - 60_000;

    const first = await api.getEventsSince(since);
    const second = await api.getEventsSince(since);
    expect(second).toEqual(first);

    const event = usageEvent({
      timestamp: Date.now(),
      model: "snapshot-model",
      kind: "Included",
      totalTokens: 7,
      spendCents: 0,
    });
    await api.upsertEvents([event]);
    const afterInsert = await api.getEventsSince(since);
    expect(afterInsert.some((e) => e.model === "snapshot-model")).toBeTrue();

    // Una finestra più vecchia eccede la cache e forza un refetch completo.
    const wider = await api.getEventsSince(since - 60_000);
    expect(wider.length).toBeGreaterThanOrEqual(afterInsert.length);

    // purge cambia la revisione: la cache non deve servire dati stale.
    await api.purgeEventsBefore(Date.now() + 60_000);
    const afterPurge = await api.getEventsSince(since);
    expect(afterPurge.some((e) => e.model === "snapshot-model")).toBeFalse();
  });
});
