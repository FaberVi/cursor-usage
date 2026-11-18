import type { CursorKvRow } from "./cursor-sqlite-pages";

/**
 * Read operations the db worker can run inside a single state.vscdb session.
 * Kept serializable so they can cross the worker boundary.
 */
export type KvReadOp =
  | { op: "get"; table: string; key: string }
  | { op: "getMany"; table: string; keys: string[] }
  | { op: "getByPrefix"; table: string; prefix: string };

/**
 * One result per op, in order:
 * - get → string | null
 * - getMany → Array<[key, value]>
 * - getByPrefix → CursorKvRow[]
 */
export type KvBatchResult = Array<string | null | Array<[string, string]> | CursorKvRow[]>;
