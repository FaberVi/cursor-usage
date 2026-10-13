/** SQLite btree and WAL page reader used to open Cursor state.vscdb without a native binding. */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "fs";

type Varint = { value: number; nextOffset: number };
export type SqliteValue = number | string | null;
type DecodedField = { value: SqliteValue; byteLength: number };
export type WalIndex = { fd: number; pages: Map<number, number> };
type PageReader = (pageNumber: number) => Buffer | null;

export type CursorKvRow = { key: string; value: string };

export type CursorKvStore = {
  get(tableName: string, key: string): string | null;
  getMany(tableName: string, keys: Iterable<string>): Map<string, string>;
  getByPrefix(tableName: string, prefix: string): CursorKvRow[];
};

export type OpenSqlite = {
  fd: number;
  walIndex: WalIndex | null;
  pageSize: number;
  usableSize: number;
  readDbPage: PageReader;
};

function decodeVarint(buffer: Buffer, offset: number, limit = buffer.length): Varint | null {
  let value = 0;
  for (let i = 0; i < 8 && offset + i < limit; i++) {
    const byte = buffer[offset + i];
    if (byte === undefined) return null;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset + i + 1 };
    }
  }

  if (offset + 8 < limit) {
    const byte = buffer[offset + 8];
    return byte === undefined ? null : { value: value * 256 + byte, nextOffset: offset + 9 };
  }
  return null;
}

function sqliteFieldByteLength(serialType: number): number | null {
  if (serialType === 0 || serialType === 8 || serialType === 9) return 0;
  if (serialType >= 1 && serialType <= 4) return serialType;
  if (serialType === 5) return 6;
  if (serialType === 6 || serialType === 7) return 8;
  if (serialType >= 12) return Math.floor((serialType - 12) / 2);
  return null;
}

function readSignedInt(buffer: Buffer, offset: number, byteLength: number): number | null {
  if (byteLength === 0) return 0;
  if (offset + byteLength > buffer.length) return null;

  let value = 0;
  for (let i = 0; i < byteLength; i++) {
    const byte = buffer[offset + i];
    if (byte === undefined) return null;
    value = value * 256 + byte;
  }

  const signBit = 2 ** (byteLength * 8 - 1);
  return value >= signBit ? value - 2 ** (byteLength * 8) : value;
}

function readSqliteField(buffer: Buffer, offset: number, serialType: number): DecodedField | null {
  const byteLength = sqliteFieldByteLength(serialType);
  if (byteLength === null || offset + byteLength > buffer.length) return null;
  if (serialType === 0) return { value: null, byteLength };
  if (serialType === 8) return { value: 0, byteLength };
  if (serialType === 9) return { value: 1, byteLength };
  if (serialType >= 1 && serialType <= 6) {
    const value = readSignedInt(buffer, offset, byteLength);
    return value === null ? null : { value, byteLength };
  }
  if (serialType === 7) return { value: null, byteLength };
  if (serialType >= 12) {
    return {
      value: buffer.toString("utf8", offset, offset + byteLength),
      byteLength,
    };
  }
  return { value: null, byteLength };
}

function readSqliteRecord(payload: Buffer): SqliteValue[] | null {
  const headerSizeVarint = decodeVarint(payload, 0, payload.length);
  if (!headerSizeVarint) return null;

  const headerEnd = headerSizeVarint.value;
  if (headerEnd > payload.length) return null;

  const serialTypes: number[] = [];
  let serialOffset = headerSizeVarint.nextOffset;
  while (serialOffset < headerEnd) {
    const serialType = decodeVarint(payload, serialOffset, headerEnd);
    if (!serialType) return null;
    serialTypes.push(serialType.value);
    serialOffset = serialType.nextOffset;
  }

  const values: SqliteValue[] = [];
  let fieldOffset = headerEnd;
  for (const serialType of serialTypes) {
    const field = readSqliteField(payload, fieldOffset, serialType);
    if (!field) return null;
    values.push(field.value);
    fieldOffset += field.byteLength;
  }
  return values;
}

function tableLeafLocalPayload(payloadSize: number, usableSize: number): { local: number; hasOverflow: boolean } {
  const maxLocal = usableSize - 35;
  const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
  if (payloadSize <= maxLocal) return { local: payloadSize, hasOverflow: false };
  let local = minLocal + ((payloadSize - minLocal) % (usableSize - 4));
  if (local > maxLocal) local = minLocal;
  return { local, hasOverflow: true };
}

function readOverflowChain(
  readDbPage: PageReader,
  firstPage: number,
  remainingBytes: number,
  pageSize: number,
): Buffer | null {
  const chunks: Buffer[] = [];
  let pageNumber = firstPage;
  let left = remainingBytes;
  const seen = new Set<number>();

  while (pageNumber > 0 && left > 0) {
    if (seen.has(pageNumber)) return null;
    seen.add(pageNumber);
    const page = readDbPage(pageNumber);
    if (!page || page.length < 4) return null;
    const nextPage = page.readUInt32BE(0);
    const data = page.subarray(4, Math.min(page.length, 4 + left));
    chunks.push(data);
    left -= data.length;
    pageNumber = nextPage;
  }

  if (left > 0) return null;
  return Buffer.concat(chunks);
}

function readTableLeafRecord(
  page: Buffer,
  cellOffset: number,
  readDbPage: PageReader,
  usableSize: number,
  pageSize: number,
): SqliteValue[] | null {
  if (cellOffset >= page.length) return null;
  const payloadSize = decodeVarint(page, cellOffset);
  if (!payloadSize) return null;

  const rowId = decodeVarint(page, payloadSize.nextOffset);
  if (!rowId) return null;

  const { local, hasOverflow } = tableLeafLocalPayload(payloadSize.value, usableSize);
  const payloadStart = rowId.nextOffset;
  if (payloadStart + local > page.length) return null;

  const localBytes = page.subarray(payloadStart, payloadStart + local);
  if (!hasOverflow) {
    return readSqliteRecord(localBytes);
  }

  if (payloadStart + local + 4 > page.length) return null;
  const overflowPage = page.readUInt32BE(payloadStart + local);
  const overflow = readOverflowChain(readDbPage, overflowPage, payloadSize.value - local, pageSize);
  if (!overflow) return null;
  return readSqliteRecord(Buffer.concat([localBytes, overflow]));
}

export function getSqlitePageSize(header: Buffer, walPageSize?: number): number {
  if (walPageSize && walPageSize > 0) return walPageSize;

  const pageSize = header.readUInt16BE(16);
  return pageSize === 1 ? 65_536 : pageSize;
}

export function indexWalFile(dbPath: string, pageSize: number): WalIndex | null {
  const walPath = `${dbPath}-wal`;
  if (!existsSync(walPath)) return null;

  const fd = openSync(walPath, "r");
  const size = fstatSync(fd).size;
  if (size < 32) return { fd, pages: new Map() };

  const header = Buffer.alloc(32);
  readSync(fd, header, 0, header.length, 0);
  const magic = header.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    closeSync(fd);
    return null;
  }

  const pages = new Map<number, number>();
  const frameSize = 24 + pageSize;
  for (let frameOffset = 32; frameOffset + frameSize <= size; frameOffset += frameSize) {
    const frameHeader = Buffer.alloc(4);
    readSync(fd, frameHeader, 0, frameHeader.length, frameOffset);
    const pageNumber = frameHeader.readUInt32BE(0);
    if (pageNumber > 0) {
      pages.set(pageNumber, frameOffset + 24);
    }
  }

  return { fd, pages };
}

function getCellPointerOffset(pageType: number, btreeHeaderOffset: number): number {
  return btreeHeaderOffset + (pageType === 0x05 ? 12 : 8);
}

export function readPage(
  dbFd: number,
  walIndex: WalIndex | null,
  pageNumber: number,
  pageSize: number,
): Buffer | null {
  const page = Buffer.alloc(pageSize);
  const walOffset = walIndex?.pages.get(pageNumber);
  const bytesRead = walOffset === undefined || !walIndex
    ? readSync(dbFd, page, 0, pageSize, (pageNumber - 1) * pageSize)
    : readSync(walIndex.fd, page, 0, pageSize, walOffset);

  if (bytesRead <= 0) return null;
  return bytesRead === pageSize ? page : page.subarray(0, bytesRead);
}

export function collectTableLeafRecords(
  readDbPage: PageReader,
  rootPage: number,
  usableSize: number,
  pageSize: number,
  onRecord: (record: SqliteValue[]) => boolean,
  seenPages = new Set<number>(),
): void {
  if (seenPages.has(rootPage)) return;
  seenPages.add(rootPage);

  const page = readDbPage(rootPage);
  if (!page) return;

  const btreeHeaderOffset = rootPage === 1 ? 100 : 0;
  const pageType = page[btreeHeaderOffset];
  if (pageType !== 0x05 && pageType !== 0x0d) return;

  const cellCount = page.readUInt16BE(btreeHeaderOffset + 3);
  const cellPointerOffset = getCellPointerOffset(pageType, btreeHeaderOffset);

  if (pageType === 0x05) {
    for (let i = 0; i < cellCount; i++) {
      const pointerOffset = cellPointerOffset + i * 2;
      if (pointerOffset + 2 > page.length) break;
      const cellOffset = page.readUInt16BE(pointerOffset);
      if (cellOffset + 4 > page.length) continue;
      collectTableLeafRecords(
        readDbPage,
        page.readUInt32BE(cellOffset),
        usableSize,
        pageSize,
        onRecord,
        seenPages,
      );
    }

    const rightMostPage = page.readUInt32BE(btreeHeaderOffset + 8);
    collectTableLeafRecords(readDbPage, rightMostPage, usableSize, pageSize, onRecord, seenPages);
    return;
  }

  for (let i = 0; i < cellCount; i++) {
    const pointerOffset = cellPointerOffset + i * 2;
    if (pointerOffset + 2 > page.length) break;
    const record = readTableLeafRecord(
      page,
      page.readUInt16BE(pointerOffset),
      readDbPage,
      usableSize,
      pageSize,
    );
    if (record && !onRecord(record)) return;
  }
}

export function findTableRootPage(ctx: OpenSqlite, tableName: string): number | null {
  let rootPage: number | null = null;
  collectTableLeafRecords(ctx.readDbPage, 1, ctx.usableSize, ctx.pageSize, (record) => {
    const [type, name, , page] = record;
    if (type === "table" && name === tableName && typeof page === "number" && page > 0) {
      rootPage = page;
      return false;
    }
    return true;
  });
  return rootPage;
}
