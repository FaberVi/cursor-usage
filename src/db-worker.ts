/**
 * Worker thread host for the heavy synchronous work: the sql.js usage event
 * store and the Cursor state.vscdb btree reader. Keeping it off the extension
 * host thread prevents UI freezes during refresh cycles.
 */
import { parentPort, workerData } from "worker_threads";
import type { UsageEvent } from "./cursor-api-types";
import { readCursorAuthValuesFromDb, withCursorKvStore } from "./cursor-db-reader";
import type { CursorKvStore } from "./cursor-sqlite-pages";
import type { KvReadOp } from "./db-worker-protocol";
import {
  parseComposerDataTitle,
  parseComposerHeaders,
} from "./conversation-title-parse";
import { UsageEventStore } from "./usage-event-store";

type WorkerData = { storageDir: string; extensionPath: string };

const { storageDir, extensionPath } = workerData as WorkerData;

let eventStore: UsageEventStore | null = null;
let storeInitPromise: Promise<UsageEventStore> | null = null;

function ensureEventStore(): Promise<UsageEventStore> {
  if (!storeInitPromise) {
    const store = new UsageEventStore(storageDir, extensionPath);
    eventStore = store;
    // Un init fallito non deve restare in cache: la promise rejected
    // renderebbe ogni operazione successiva impossibile da ripetere.
    storeInitPromise = store
      .init()
      .then(() => store)
      .catch((err: unknown) => {
        storeInitPromise = null;
        eventStore = null;
        store.close();
        throw err;
      });
  }
  return storeInitPromise;
}

function runKvOp(store: CursorKvStore, op: KvReadOp): unknown {
  switch (op.op) {
    case "get":
      return store.get(op.table, op.key);
    case "getMany":
      return [...store.getMany(op.table, op.keys).entries()];
    case "getByPrefix":
      return store.getByPrefix(op.table, op.prefix);
  }
}

type SyncEventsOpts = { allowEmpty?: boolean; totalCovered?: boolean };

type Handler = (args: unknown[]) => unknown;

const handlers: Record<string, Handler> = {
  storeInit: () => ensureEventStore().then(() => true),
  upsertEvents: async (args) => (await ensureEventStore()).upsertEvents(args[0] as UsageEvent[]),
  syncEventsFromApi: async (args) => {
    const [events, sinceMs, opts] = args as [UsageEvent[], number, SyncEventsOpts?];
    return (await ensureEventStore()).syncEventsFromApi(events, sinceMs, opts);
  },
  // Se la revisione del contenuto è invariata rispetto a quella nota dal
  // client, torna `events: null` e il client riusa la propria copia: niente
  // serializzazione/clonazione della finestra eventi via RPC.
  getEventsSnapshot: async (args) => {
    const store = await ensureEventStore();
    const [since, knownRevision] = args as [number, number?];
    const revision = store.getStoreRevision();
    if (typeof knownRevision === "number" && knownRevision === revision) {
      return { revision, events: null };
    }
    return { revision, events: store.getEventsSince(since) };
  },
  getEventCount: async () => (await ensureEventStore()).getEventCount(),
  getGrokBotEventCount: async () => (await ensureEventStore()).getGrokBotEventCount(),
  purgeEventsBefore: async (args) => (await ensureEventStore()).purgeEventsBefore(args[0] as number),
  flushPersist: async () => {
    (await ensureEventStore()).flushPersist();
  },
  closeStore: async () => {
    eventStore?.close();
    eventStore = null;
    storeInitPromise = null;
  },
  kvBatch: (args) => {
    const [dbPath, ops] = args as [string, KvReadOp[]];
    return withCursorKvStore(dbPath, (store) => ops.map((op) => runKvOp(store, op)));
  },
  readAuthValues: (args) => readCursorAuthValuesFromDb(args[0] as string),
  // Single state.vscdb session: headers first, then composerData only for the
  // ids the headers did not cover.
  conversationTitles: (args) => {
    const [dbPath, ids] = args as [string, string[]];
    return withCursorKvStore(dbPath, (store) => {
      const map = parseComposerHeaders(store.get("ItemTable", "composer.composerHeaders"));
      const missing = ids.filter((id) => !map.has(id));
      if (missing.length > 0) {
        const composerRows = store.getMany(
          "cursorDiskKV",
          missing.map((id) => `composerData:${id}`),
        );
        for (const id of missing) {
          const title = parseComposerDataTitle(composerRows.get(`composerData:${id}`) ?? null);
          if (title) map.set(id, title);
        }
      }
      const out: Record<string, string> = {};
      for (const id of ids) {
        const title = map.get(id);
        if (title) out[id] = title;
      }
      return out;
    });
  },
};

parentPort?.on(
  "message",
  (message: { id: number; method: string; args?: unknown[] }) => {
    const { id, method, args = [] } = message;
    const respond = (payload: { ok: boolean; result?: unknown; error?: string }) => {
      parentPort?.postMessage({ id, ...payload });
    };
    const handler = handlers[method];
    if (!handler) {
      respond({ ok: false, error: `Unknown worker method: ${method}` });
      return;
    }
    Promise.resolve()
      .then(() => handler(args))
      .then(
        (result) => respond({ ok: true, result }),
        (error: unknown) =>
          respond({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  },
);
