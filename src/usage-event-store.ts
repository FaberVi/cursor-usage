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
  }

  upsertEvents(events: UsageEvent[]): number {
    if (!this.db || events.length === 0) return 0;
    return this.insertEvents(events, "INSERT OR REPLACE");
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
      return this.insertEvents(events, "INSERT OR REPLACE");
    }
    this.db.run("DELETE FROM usage_events WHERE timestamp >= ?", [sinceMs]);
    if (events.length === 0) {
      this.schedulePersist();
      return 0;
    }
    return this.insertEvents(events, "INSERT OR REPLACE");
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
  ): number {
    if (!this.db || events.length === 0) return 0;

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
    for (const event of events) {
      const normalized = normalizeUsageEventRequests(event);
      stmt.bind([
        usageEventFingerprint(normalized),
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
        JSON.stringify(normalized),
        now,
      ]);
      stmt.step();
      if (this.db.getRowsModified() > 0) inserted += 1;
      stmt.reset();
    }
    stmt.free();
    this.schedulePersist();
    return inserted;
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
