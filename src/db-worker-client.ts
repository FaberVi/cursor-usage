/**
 * Main-thread client for the db worker. All store and state.vscdb operations
 * become async RPC calls so the synchronous sql.js / btree work never blocks
 * the extension host.
 */
import { existsSync } from "fs";
import { join } from "path";
import { Worker } from "worker_threads";
import type { CursorAuthValues } from "./cursor-db-reader";
import type { UsageEvent } from "./cursor-api-types";
import type { KvBatchResult, KvReadOp } from "./db-worker-protocol";

export interface UsageEventStoreApi {
  init(): Promise<void>;
  upsertEvents(events: UsageEvent[]): Promise<number>;
  syncEventsFromApi(
    events: UsageEvent[],
    sinceMs: number,
    opts?: { allowEmpty?: boolean; totalCovered?: boolean },
  ): Promise<number>;
  getEventsSince(since: number): Promise<UsageEvent[]>;
  getEventCount(): Promise<number>;
  getGrokBotEventCount(): Promise<number>;
  purgeEventsBefore(cutoffMs: number): Promise<number>;
  flushPersist(): Promise<void>;
  close(): Promise<void>;
}

type WorkerConfig = { storageDir: string; extensionPath: string };

let config: WorkerConfig | null = null;
let worker: Worker | null = null;
let nextRequestId = 1;
let storeReady: Promise<void> | null = null;
// Ultima finestra eventi ricevuta dal worker: se la revisione del contenuto
// non è cambiata la stessa richiesta non deve più attraversare l'RPC.
let eventsSnapshotCache: { revision: number; since: number; events: UsageEvent[] } | null = null;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    owner: Worker;
  }
>();

export function configureDbWorker(next: WorkerConfig): void {
  config = next;
  // workerData is fixed at spawn time: a running worker keeps the old paths,
  // so restart it and let the next call respawn with the new config.
  if (worker) {
    const stale = worker;
    worker = null;
    storeReady = null;
    eventsSnapshotCache = null;
    failAllPending(new Error("db worker reconfigured"));
    void stale.terminate();
  }
}

function workerEntryPath(): string {
  // Bundled: dist/db-worker.js next to dist/extension.js.
  // Sources (bun test / bun run watch before a fresh build): src/db-worker.ts.
  const candidates = [join(__dirname, "db-worker.js"), join(__dirname, "db-worker.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function failAllPending(reason: Error): void {
  for (const { reject } of pending.values()) {
    reject(reason);
  }
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  // KV reads do not need real paths; the event store fails inside the worker
  // if it is ever used before configureDbWorker() provides real ones.
  const workerConfig = config ?? { storageDir: "", extensionPath: process.cwd() };

  const spawned = new Worker(workerEntryPath(), { workerData: workerConfig });
  worker = spawned;

  spawned.on(
    "message",
    (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        entry.reject(new Error(message.error ?? "db worker request failed"));
      }
    },
  );

  const dropWorker = (reason: Error) => dropWorkerInstance(spawned, reason);
  spawned.on("error", (error) =>
    dropWorker(error instanceof Error ? error : new Error(String(error))),
  );
  spawned.on("exit", (code) => dropWorker(new Error(`db worker exited with code ${code}`)));

  // The worker must not keep the extension host process alive on its own.
  spawned.unref();
  return spawned;
}

function call<T>(method: string, args: unknown[] = []): Promise<T> {
  const active = ensureWorker();
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      const reason = new Error(`db worker call ${method} timed out`);
      // Termina sempre `active`, anche se nel frattempo è subentrato un worker
      // nuovo: può essere bloccato in un'operazione sincrona e il terminate è
      // l'unico modo per scioglierlo.
      dropWorkerInstance(active, reason);
      reject(reason);
    }, DB_WORKER_CALL_TIMEOUT_MS);
    pending.set(id, {
      owner: active,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      active.postMessage({ id, method, args });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function ensureStoreReady(): Promise<void> {
  if (!storeReady) {
    const ready = call<unknown>("storeInit").then(() => undefined);
    storeReady = ready;
    // A failed init must not poison every later call.
    ready.catch(() => {
      if (storeReady === ready) storeReady = null;
    });
  }
  return storeReady;
}

let api: UsageEventStoreApi | null = null;

// Una chiamata che non risponde (worker bloccato in I/O su state.vscdb)
// deve fallire e liberare la coda: altrimenti ogni operazione successiva
// resterebbe in attesa a tempo indeterminato.
const DB_WORKER_CALL_TIMEOUT_MS = 60_000;

function dropWorkerInstance(target: Worker, reason: Error): void {
  const isCurrent = worker === target;
  if (isCurrent) {
    worker = null;
    storeReady = null;
    eventsSnapshotCache = null;
  }
  // Rifiuta le request pendenti del worker scartato anche quando nel frattempo
  // ne è stato spawnato uno nuovo: altrimenti resterebbero appese fino al
  // timeout di 60s. Se è il worker corrente, tutte le pendenti sono sue.
  for (const [id, entry] of pending) {
    if (!isCurrent && entry.owner !== target) continue;
    pending.delete(id);
    entry.reject(reason);
  }
  // Termina sempre il worker scartato: su 'error' potrebbe restare vivo e
  // continuare a persistere lo stesso sqlite file della nuova istanza.
  void target.terminate();
}

export function usageEventStoreApi(): UsageEventStoreApi {
  if (!api) {
    api = {
      init: ensureStoreReady,
      upsertEvents: async (events) => {
        await ensureStoreReady();
        return call("upsertEvents", [events]);
      },
      syncEventsFromApi: async (events, sinceMs, opts) => {
        await ensureStoreReady();
        return call("syncEventsFromApi", [events, sinceMs, opts]);
      },
      getEventsSince: async (since) => {
        await ensureStoreReady();
        const cached = eventsSnapshotCache;
        // La cache è riusabile solo se la nuova finestra è contenuta in quella
        // già scaricata: un `since` più piccolo richiederebbe righe mai lette.
        const knownRevision = cached && since >= cached.since ? cached.revision : null;
        const snapshot = await call<{ revision: number; events: UsageEvent[] | null }>(
          "getEventsSnapshot",
          [since, knownRevision],
        );
        if (snapshot.events !== null) {
          eventsSnapshotCache = { revision: snapshot.revision, since, events: snapshot.events };
          return snapshot.events;
        }
        if (!cached) {
          throw new Error("db worker returned an unchanged snapshot without a cached copy");
        }
        return cached.events.filter((event) => event.timestamp >= since);
      },
      getEventCount: async () => {
        await ensureStoreReady();
        return call("getEventCount");
      },
      getGrokBotEventCount: async () => {
        await ensureStoreReady();
        return call("getGrokBotEventCount");
      },
      purgeEventsBefore: async (cutoffMs) => {
        await ensureStoreReady();
        return call("purgeEventsBefore", [cutoffMs]);
      },
      flushPersist: async () => {
        await ensureStoreReady();
        await call("flushPersist");
      },
      close: async () => {
        if (!worker) return;
        eventsSnapshotCache = null;
        await call("closeStore").catch(() => undefined);
      },
    };
  }
  return api;
}

/** Run read ops against state.vscdb inside a single worker-side session. */
export async function kvReadBatch(dbPath: string, ops: KvReadOp[]): Promise<KvBatchResult | null> {
  return call<KvBatchResult | null>("kvBatch", [dbPath, ops]);
}

export async function readCursorAuthValues(dbPath: string): Promise<CursorAuthValues> {
  return call<CursorAuthValues>("readAuthValues", [dbPath]);
}

/** Resolve conversation titles in one worker-side state.vscdb session. */
export async function lookupConversationTitles(
  dbPath: string,
  conversationIds: string[],
): Promise<Record<string, string> | null> {
  return call<Record<string, string> | null>("conversationTitles", [dbPath, conversationIds]);
}

/** Live worker handle, exposed so tests can exercise the crash/respawn path. */
export function activeDbWorker(): Worker | null {
  return worker;
}

/** Terminate the worker (extension deactivation). */
export function shutdownDbWorker(): void {
  const active = worker;
  worker = null;
  storeReady = null;
  eventsSnapshotCache = null;
  if (!active) return;
  failAllPending(new Error("db worker shut down"));
  void active.terminate();
}
