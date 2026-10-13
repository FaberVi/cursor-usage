import { closeSync, existsSync, openSync, readSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { apiLog } from "./cursor-api-logger";
import {
  collectTableLeafRecords,
  findTableRootPage,
  getSqlitePageSize,
  indexWalFile,
  readPage,
  type OpenSqlite,
  type SqliteValue,
  type WalIndex,
} from "./cursor-sqlite-pages";

export function getGlobalCursorDbPath(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "Cursor/User/globalStorage/state.vscdb");
    default:
      return join(homedir(), ".config/Cursor/User/globalStorage/state.vscdb");
  }
}

const CURSOR_AUTH_KEYS = ["cursorAuth/accessToken", "cursorAuth/cachedEmail"] as const;
type CursorAuthKey = (typeof CURSOR_AUTH_KEYS)[number];
export type CursorAuthValues = Partial<Record<CursorAuthKey, string>>;


function kvFromRecord(record: SqliteValue[]): CursorKvRow | null {
  if (record.length < 2) return null;
  const [recordKey, value] = record;
  if (typeof recordKey !== "string" || typeof value !== "string") return null;
  return { key: recordKey, value };
}

function collectMatchingRows(
  ctx: OpenSqlite,
  tableName: string,
  onRow: (row: CursorKvRow) => boolean,
): void {
  const rootPage = findTableRootPage(ctx, tableName);
  if (rootPage === null) return;
  collectTableLeafRecords(ctx.readDbPage, rootPage, ctx.usableSize, ctx.pageSize, (record) => {
    const row = kvFromRecord(record);
    if (!row) return true;
    return onRow(row);
  });
}

function openSqlite(dbPath: string): OpenSqlite {
  const fd = openSync(dbPath, "r");
  const header = Buffer.alloc(100);
  readSync(fd, header, 0, header.length, 0);
  if (header.toString("utf8", 0, 16) !== "SQLite format 3\0") {
    closeSync(fd);
    throw new Error("Invalid SQLite database header");
  }

  const pageSize = getSqlitePageSize(header);
  const reserved = header[20] ?? 0;
  const usableSize = pageSize - reserved;
  const walIndex = indexWalFile(dbPath, pageSize);
  const readDbPage = (pageNumber: number) => readPage(fd, walIndex, pageNumber, pageSize);
  return { fd, walIndex, pageSize, usableSize, readDbPage };
}

function closeSqlite(ctx: OpenSqlite): void {
  if (ctx.walIndex) closeSync(ctx.walIndex.fd);
  closeSync(ctx.fd);
}

function createKvStore(ctx: OpenSqlite): CursorKvStore {
  return {
    get(tableName, key) {
      let found: string | null = null;
      collectMatchingRows(ctx, tableName, (row) => {
        if (row.key === key) {
          found = row.value;
          return false;
        }
        return true;
      });
      return found;
    },
    getMany(tableName, keys) {
      const remaining = new Set([...keys].filter(Boolean));
      const values = new Map<string, string>();
      if (remaining.size === 0) return values;
      collectMatchingRows(ctx, tableName, (row) => {
        if (!remaining.has(row.key)) return true;
        values.set(row.key, row.value);
        remaining.delete(row.key);
        return remaining.size > 0;
      });
      return values;
    },
    getByPrefix(tableName, prefix) {
      const rows: CursorKvRow[] = [];
      if (!prefix) return rows;
      collectMatchingRows(ctx, tableName, (row) => {
        if (row.key.startsWith(prefix)) rows.push(row);
        return true;
      });
      return rows;
    },
  };
}

export function withCursorKvStore<T>(dbPath: string, fn: (store: CursorKvStore) => T): T | null {
  if (!existsSync(dbPath)) return null;
  let ctx: OpenSqlite | null = null;
  try {
    ctx = openSqlite(dbPath);
    return fn(createKvStore(ctx));
  } catch {
    apiLog("Cursor KV read failed");
    return null;
  } finally {
    if (ctx) closeSqlite(ctx);
  }
}

export function readTableKeyValue(dbPath: string, tableName: string, key: string): string | null {
  return withCursorKvStore(dbPath, (store) => store.get(tableName, key));
}

export function readCursorAuthValuesFromDb(dbPath: string): CursorAuthValues {
  const fd = openSync(dbPath, "r");
  let walIndex: WalIndex | null = null;
  try {
    const header = Buffer.alloc(100);
    readSync(fd, header, 0, header.length, 0);

    if (header.toString("utf8", 0, 16) !== "SQLite format 3\0") {
      throw new Error("Invalid SQLite database header");
    }

    const pageSize = getSqlitePageSize(header);
    const reserved = header[20] ?? 0;
    const usableSize = pageSize - reserved;
    walIndex = indexWalFile(dbPath, pageSize);
    const readDbPage = (pageNumber: number) => readPage(fd, walIndex, pageNumber, pageSize);
    const ctx: OpenSqlite = { fd, walIndex, pageSize, usableSize, readDbPage };
    const itemTableRootPage = findTableRootPage(ctx, "ItemTable");
    if (itemTableRootPage === null) {
      throw new Error("Could not find ItemTable root page");
    }

    const remainingKeys = new Set<CursorAuthKey>(CURSOR_AUTH_KEYS);
    const values: CursorAuthValues = {};

    collectTableLeafRecords(readDbPage, itemTableRootPage, usableSize, pageSize, (record) => {
      if (record.length < 2) return true;
      const [key, value] = record;
      if (typeof key === "string" && typeof value === "string" && remainingKeys.has(key as CursorAuthKey)) {
        const authKey = key as CursorAuthKey;
        values[authKey] = value;
        remainingKeys.delete(authKey);
      }
      return remainingKeys.size > 0;
    });

    return values;
  } finally {
    if (walIndex) closeSync(walIndex.fd);
    closeSync(fd);
  }
}

