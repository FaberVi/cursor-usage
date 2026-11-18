/// <reference types="node" />
/// <reference path="../types/bun-test.d.ts" />
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCursorAuthValuesFromDb, withCursorKvStore } from "../src/cursor-api";

describe("Cursor auth database reader", () => {
  it("reads auth values from ItemTable without sqlite CLI or native bindings", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-auth-db-")), "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/accessToken", "jwt-token"]);
    db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/cachedEmail", "user@example.com"]);
    db.close();

    expect(readCursorAuthValuesFromDb(dbPath)).toEqual({
      "cursorAuth/accessToken": "jwt-token",
      "cursorAuth/cachedEmail": "user@example.com",
    });
  });

  it("reads auth values committed to a WAL file", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-auth-wal-db-")), "state.vscdb");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/accessToken", "wal-jwt-token"]);
    db.run("INSERT INTO ItemTable VALUES (?, ?)", ["cursorAuth/cachedEmail", "wal@example.com"]);

    expect(existsSync(`${dbPath}-wal`)).toBeTrue();
    expect(readCursorAuthValuesFromDb(dbPath)).toEqual({
      "cursorAuth/accessToken": "wal-jwt-token",
      "cursorAuth/cachedEmail": "wal@example.com",
    });

    db.close();
  });
});

describe("Cursor KV database reader", () => {
  function createKvDb(dirPrefix: string): string {
    const dbPath = join(mkdtempSync(join(tmpdir(), dirPrefix)), "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [
      "composer.composerHeaders",
      JSON.stringify({ allComposers: [{ composerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "From headers" }] }),
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", ["composerData:11111111-1111-4111-8111-111111111111", JSON.stringify({ name: "Composer title" })]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      "bubbleId:11111111-1111-4111-8111-111111111111:bubble-a",
      JSON.stringify({ type: 1, text: "hello" }),
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      "bubbleId:11111111-1111-4111-8111-111111111111:bubble-b",
      JSON.stringify({ type: 2, text: "world" }),
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      "bubbleId:22222222-2222-4222-8222-222222222222:other",
      JSON.stringify({ type: 1, text: "skip" }),
    ]);
    const overflow = JSON.stringify({ name: "x".repeat(9000) });
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", ["composerData:overflow-key", overflow]);
    db.close();
    return dbPath;
  }

  it("reads exact keys and prefix rows without sql.js", () => {
    const dbPath = createKvDb("cursor-kv-db-");
    const result = withCursorKvStore(dbPath, (store) => ({
      headers: store.get("ItemTable", "composer.composerHeaders"),
      composer: store.get("cursorDiskKV", "composerData:11111111-1111-4111-8111-111111111111"),
      bubbles: store.getByPrefix("cursorDiskKV", "bubbleId:11111111-1111-4111-8111-111111111111:"),
      many: store.getMany("cursorDiskKV", [
        "composerData:11111111-1111-4111-8111-111111111111",
        "missing",
      ]),
    }));

    expect(result?.headers).toContain("From headers");
    expect(result?.composer).toContain("Composer title");
    expect(result?.bubbles).toHaveLength(2);
    expect(result?.many.get("composerData:11111111-1111-4111-8111-111111111111")).toContain("Composer title");
    expect(result?.many.has("missing")).toBe(false);
  });

  it("reads WAL-committed KV rows", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-kv-wal-")), "state.vscdb");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", ["composerData:wal-id", JSON.stringify({ name: "Wal title" })]);
    expect(existsSync(`${dbPath}-wal`)).toBeTrue();
    const title = withCursorKvStore(dbPath, (store) => store.get("cursorDiskKV", "composerData:wal-id"));
    expect(title).toContain("Wal title");
    db.close();
  });

  it("reads overflow payloads of at least 8 KiB", () => {
    const dbPath = createKvDb("cursor-kv-overflow-");
    const raw = withCursorKvStore(dbPath, (store) => store.get("cursorDiskKV", "composerData:overflow-key"));
    expect(raw?.length).toBeGreaterThan(8000);
    expect(JSON.parse(raw ?? "{}").name.length).toBe(9000);
  });

  it("reads KV rows when the WAL spans multiple index chunks", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-kv-bigwal-")), "state.vscdb");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA wal_autocheckpoint = 0");
    db.run("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    // Abbastanza commit singoli da superare il chunk di 256 frame dell'indice WAL.
    for (let i = 0; i < 600; i++) {
      db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [`bulk-${i}`, `value-${i}`]);
    }
    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBeTrue();
    // 24 byte di header frame + pagina da 4 KiB per ogni frame WAL.
    expect(statSync(walPath).size).toBeGreaterThan(256 * (24 + 4096));

    // La riga finale vive negli ultimi frame: verifica l'indicizzazione dei chunk di coda.
    const raw = withCursorKvStore(dbPath, (store) => store.get("cursorDiskKV", "bulk-599"));
    expect(raw).toBe("value-599");
    const first = withCursorKvStore(dbPath, (store) => store.get("cursorDiskKV", "bulk-0"));
    expect(first).toBe("value-0");

    db.close();
  });
});
