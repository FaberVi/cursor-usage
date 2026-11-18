import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { UsageEvent } from "./cursor-api-types";
import { normalizeUsageEventRequests } from "./cursor-usage-parsing";
import { loadSqlJs, type SqlJsDatabase, type SqlJsStatement } from "./sql-js-loader";
import { usageEventFingerprint } from "./usage-event-fingerprint";

const PERSIST_DEBOUNCE_MS = 500;

export class UsageEventStore {
  private db: SqlJsDatabase | null = null;
  private readonly dbPath: string;
  private initPromise: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDirty = false;
  // Incrementa solo quando il contenuto degli eventi cambia davvero: il worker
  // lo usa per dire al client se la snapshot va rispedita o può essere riusata.
  private revision = 0;

  constructor(
    private readonly storageDir: string,
    private readonly extensionPath: string,
  ) {
    this.dbPath = join(storageDir, "usage-events.sqlite");
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    mkdirSync(this.storageDir, { recursive: true });
    const SQL = await loadSqlJs(this.extensionPath);

    this.db = existsSync(this.dbPath)
      ? new SQL.Database(readFileSync(this.dbPath))
      : new SQL.Database();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_events (
        event_key TEXT PRIMARY KEY NOT NULL,
        timestamp INTEGER NOT NULL,
        conversation_id TEXT,
        model TEXT NOT NULL,
        kind TEXT NOT NULL,
        total_tokens INTEGER NOT NULL,
        requests REAL NOT NULL,
        spend_cents REAL NOT NULL,
        max_mode INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        token_cost_cents REAL NOT NULL,
        cursor_token_fee REAL NOT NULL,
        is_token_based INTEGER NOT NULL,
        is_headless INTEGER NOT NULL,
        is_chargeable INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        synced_at INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_usage_events_conversation ON usage_events(conversation_id)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )
    `);
    this.migrateStoredEventsIfNeeded();
    this.revision = this.readRevisionMeta();
    this.persist();
  }

  private getMeta(key: string): string | null {
    if (!this.db) return null;
    const stmt = this.db.prepare("SELECT value FROM store_meta WHERE key = ?");
    stmt.bind([key]);
    let value: string | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { value?: string };
      value = typeof row.value === "string" ? row.value : null;
    }
    stmt.free();
    return value;
  }

  private setMeta(key: string, value: string): void {
    if (!this.db) return;
    this.db.run(
      "INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)",
      [key, value],
    );
  }

  private readRevisionMeta(): number {
    const raw = this.getMeta("event_store_revision");
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }

  private bumpRevision(): void {
    this.revision += 1;
    this.setMeta("event_store_revision", String(this.revision));
  }

  /** Version del contenuto: cambia solo quando le righe eventi cambiano davvero. */
  getStoreRevision(): number {
    return this.revision;
  }

  /** Dedupe rows and rewrite payloads after request/token normalization / fingerprint change. */
  private migrateStoredEventsIfNeeded(): void {
    if (!this.db || this.getMeta("event_store_schema") === "3") return;

    const select = this.db.prepare("SELECT payload_json, synced_at FROM usage_events");
    const byFingerprint = new Map<string, { event: UsageEvent; syncedAt: number }>();

    while (select.step()) {
      const row = select.getAsObject() as { payload_json?: string; synced_at?: number };
      if (typeof row.payload_json !== "string") continue;
      try {
        const event = normalizeUsageEventRequests(JSON.parse(row.payload_json) as UsageEvent);
        const fingerprint = usageEventFingerprint(event);
        const syncedAt = typeof row.synced_at === "number" ? row.synced_at : 0;
        const existing = byFingerprint.get(fingerprint);
        if (!existing || syncedAt >= existing.syncedAt) {
          byFingerprint.set(fingerprint, { event, syncedAt });
        }
      } catch {
        // skip corrupt rows
      }
    }
    select.free();

    this.db.run("DELETE FROM usage_events");

    if (byFingerprint.size > 0) {
      const insert = this.db.prepare(`
        INSERT INTO usage_events (
          event_key, timestamp, conversation_id, model, kind, total_tokens, requests, spend_cents,
          max_mode, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
          token_cost_cents, cursor_token_fee, is_token_based, is_headless, is_chargeable,
          payload_json, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [fingerprint, { event, syncedAt }] of byFingerprint) {
        insert.bind([
          fingerprint,
          event.timestamp,
          event.conversationId ?? null,
          event.model,
          event.kind,
          event.totalTokens ?? 0,
          event.requests ?? 0,
          event.spendCents ?? 0,
          event.maxMode ? 1 : 0,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          event.cacheWriteTokens ?? 0,
          event.cacheReadTokens ?? 0,
          event.tokenCostCents ?? 0,
          event.cursorTokenFee ?? 0,
          event.isTokenBasedCall ? 1 : 0,
          event.isHeadless ? 1 : 0,
          event.isChargeable ? 1 : 0,
          JSON.stringify(event),
          syncedAt,
        ]);
        insert.step();
        insert.reset();
      }
      insert.free();
    }

    this.setMeta("event_store_schema", "3");
    // La migrazione riscrive tutto l'archivio: forziamo un bump così il
    // prossimo snapshot RPC non riusa una cache pre-migrazione.
    this.setMeta("event_store_revision", String(this.readRevisionMeta() + 1));
  }

  upsertEvents(events: UsageEvent[]): number {
    if (!this.db || events.length === 0) return 0;
    const { inserted, contentChanged } = this.insertEvents(events, "INSERT OR REPLACE");
    if (contentChanged) this.bumpRevision();
    return inserted;
  }

  /** Replace all stored events in [sinceMs, ∞) with the API snapshot (manual refresh). */
  syncEventsFromApi(
    events: UsageEvent[],
    sinceMs: number,
    opts?: { allowEmpty?: boolean; totalCovered?: boolean },
  ): number {
    if (!this.db) return 0;
    if (events.length === 0 && !opts?.allowEmpty) return 0;
    const totalCovered = opts?.totalCovered === true;
    const inWindow = this.countEventsSince(sinceMs);
    if (events.length < inWindow && !totalCovered) {
      if (events.length === 0) return 0;
      const { inserted, contentChanged } = this.insertEvents(events, "INSERT OR REPLACE");
      if (contentChanged) this.bumpRevision();
      return inserted;
    }
    // I payload esistenti nella finestra servono a distinguere un reinserimento
    // identico (niente bump) da una sincronizzazione che cambia davvero i dati.
    const priorPayloads = this.payloadsSince(sinceMs);
    this.db.run("DELETE FROM usage_events WHERE timestamp >= ?", [sinceMs]);
    const deletedCount = this.db.getRowsModified();
    if (events.length === 0) {
      if (deletedCount > 0) this.bumpRevision();
      this.schedulePersist();
      return 0;
    }
    const { inserted, contentChanged } = this.insertEvents(
      events,
      "INSERT OR REPLACE",
      priorPayloads,
    );
    if (contentChanged) this.bumpRevision();
    return inserted;
  }

  /** fingerprint → payload_json delle righe nella finestra, per il delta check del sync. */
  private payloadsSince(sinceMs: number): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.db) return map;
    const stmt = this.db.prepare(
      "SELECT event_key, payload_json FROM usage_events WHERE timestamp >= ?",
    );
    stmt.bind([sinceMs]);
    while (stmt.step()) {
      const row = stmt.getAsObject() as { event_key?: string; payload_json?: string };
      if (typeof row.event_key === "string" && typeof row.payload_json === "string") {
        map.set(row.event_key, row.payload_json);
      }
    }
    stmt.free();
    return map;
  }

  private countEventsSince(sinceMs: number): number {
    if (!this.db) return 0;
    const stmt = this.db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE timestamp >= ?");
    stmt.bind([sinceMs]);
    let count = 0;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { count?: number };
      count = typeof row.count === "number" ? row.count : 0;
    }
    stmt.free();
    return count;
  }

  private insertEvents(
    events: UsageEvent[],
    insertMode: "INSERT" | "INSERT OR IGNORE" | "INSERT OR REPLACE",
    priorPayloads?: Map<string, string>,
  ): { inserted: number; contentChanged: boolean } {
    if (!this.db || events.length === 0) return { inserted: 0, contentChanged: false };

    const stmt = this.db.prepare(`
      ${insertMode} INTO usage_events (
        event_key, timestamp, conversation_id, model, kind, total_tokens, requests, spend_cents,
        max_mode, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
        token_cost_cents, cursor_token_fee, is_token_based, is_headless, is_chargeable,
        payload_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    let inserted = 0;
    let contentChanged = false;
    // Con priorPayloads il delta si confronta in memoria (le righe sono appena
    // state cancellate, una SELECT non troverebbe più nulla); anche un evento
    // nuovo o rimosso conta come cambiamento.
    const nextPayloads = priorPayloads ? new Map<string, string>() : null;
    const existingPayload = priorPayloads
      ? null
      : this.db.prepare("SELECT payload_json FROM usage_events WHERE event_key = ?");
    for (const event of events) {
      const normalized = normalizeUsageEventRequests(event);
      const fingerprint = usageEventFingerprint(normalized);
      const payloadJson = JSON.stringify(normalized);
      if (nextPayloads) {
        nextPayloads.set(fingerprint, payloadJson);
      }
      let differs = true;
      if (nextPayloads) {
        differs = priorPayloads?.get(fingerprint) !== payloadJson;
      } else if (existingPayload) {
        existingPayload.bind([fingerprint]);
        if (existingPayload.step()) {
          const row = existingPayload.getAsObject() as { payload_json?: string };
          differs = row.payload_json !== payloadJson;
        }
        existingPayload.reset();
      }
      if (differs) contentChanged = true;
      stmt.bind([
        fingerprint,
        normalized.timestamp,
        normalized.conversationId ?? null,
        normalized.model,
        normalized.kind,
        normalized.totalTokens ?? 0,
        normalized.requests ?? 0,
        normalized.spendCents ?? 0,
        normalized.maxMode ? 1 : 0,
        normalized.inputTokens ?? 0,
        normalized.outputTokens ?? 0,
        normalized.cacheWriteTokens ?? 0,
        normalized.cacheReadTokens ?? 0,
        normalized.tokenCostCents ?? 0,
        normalized.cursorTokenFee ?? 0,
        normalized.isTokenBasedCall ? 1 : 0,
        normalized.isHeadless ? 1 : 0,
        normalized.isChargeable ? 1 : 0,
        payloadJson,
        now,
      ]);
      stmt.step();
      if (this.db.getRowsModified() > 0) inserted += 1;
      stmt.reset();
    }
    existingPayload?.free();
    stmt.free();
    // I set devono coincidere per intero: una riga cancellata e non reinserita
    // (o una nuova) è un cambiamento anche se nessun payload è diverso.
    if (priorPayloads && nextPayloads && priorPayloads.size !== nextPayloads.size) {
      contentChanged = true;
    }
    this.schedulePersist();
    return { inserted, contentChanged };
  }

  getEventsSince(since: number): UsageEvent[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      "SELECT payload_json FROM usage_events WHERE timestamp >= ? ORDER BY timestamp DESC",
    );
    stmt.bind([since]);
    const events: UsageEvent[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { payload_json?: string };
      if (typeof row.payload_json === "string") {
        try {
          events.push(normalizeUsageEventRequests(JSON.parse(row.payload_json) as UsageEvent));
        } catch {
          // skip corrupt rows
        }
      }
    }
    stmt.free();
    return events;
  }

  getEventCount(): number {
    return this.countEvents("SELECT COUNT(*) AS count FROM usage_events");
  }

  /** Rows billed to the weekly Grok Bot allowance (model id prefix `grok-bot`). */
  getGrokBotEventCount(): number {
    return this.countEvents(
      "SELECT COUNT(*) AS count FROM usage_events WHERE lower(model) LIKE 'grok-bot%'",
    );
  }

  private countEvents(sql: string): number {
    if (!this.db) return 0;
    const stmt = this.db.prepare(sql);
    let count = 0;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { count?: number };
      count = typeof row.count === "number" ? row.count : 0;
    }
    stmt.free();
    return count;
  }

  /**
   * Drop rows older than `cutoffMs` and rebuild the file so the next sql.js
   * open does not reload freed pages. Ordinary upserts do not vacuum.
   */
  purgeEventsBefore(cutoffMs: number): number {
    if (!this.db) return 0;
    this.db.run("DELETE FROM usage_events WHERE timestamp < ?", [cutoffMs]);
    const removed = this.db.getRowsModified();
    // VACUUM rebuilds the whole database synchronously: skip it when the
    // purge deleted nothing, which is the common case on every refresh.
    if (removed === 0) return 0;
    this.bumpRevision();
    this.db.run("VACUUM");
    this.flushPersist();
    return removed;
  }

  /** Flush pending debounced writes immediately (e.g. after manual refresh sync). */
  flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistDirty = false;
    this.persist();
  }

  close(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
    this.db?.close();
    this.db = null;
    this.initPromise = null;
  }

  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.persistDirty) return;
      this.persistDirty = false;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persist(): void {
    if (!this.db) return;
    const tmpPath = this.dbPath + ".tmp";
    writeFileSync(tmpPath, Buffer.from(this.db.export()));
    try {
      renameSync(tmpPath, this.dbPath);
    } catch {
      if (existsSync(this.dbPath)) unlinkSync(this.dbPath);
      renameSync(tmpPath, this.dbPath);
    }
  }
}
