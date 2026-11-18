import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeUsageEventRequests } from "../src/cursor-usage-parsing";
import { usageEvent } from "./usage-event-fixture";
import { usageEventFingerprint } from "../src/usage-event-fingerprint";
import { UsageEventStore } from "../src/usage-event-store";

describe("usageEventFingerprint", () => {
  it("produces different hashes when spend differs", () => {
    const base = usageEvent({ timestamp: 1, model: "gpt-5", kind: "Included", totalTokens: 100 });
    const a = usageEventFingerprint(base);
    const b = usageEventFingerprint({ ...base, spendCents: 12 });
    expect(a).not.toBe(b);
  });

  it("produces different hashes when cache tokens differ", () => {
    const base = usageEvent({ timestamp: 1, model: "gpt-5", kind: "Included", totalTokens: 100 });
    const a = usageEventFingerprint(base);
    const b = usageEventFingerprint({ ...base, cacheReadTokens: 500 });
    expect(a).not.toBe(b);
  });

  it("ignores derived requests field so normalization does not change identity", () => {
    const base = usageEvent({
      timestamp: 1,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 100,
      isTokenBasedCall: true,
      requests: 29_648_584,
    });
    const normalized = normalizeUsageEventRequests(base);
    expect(usageEventFingerprint(base)).toBe(usageEventFingerprint(normalized));
  });

  it("ignores derived totalTokens when component breakdown exists", () => {
    const polluted = usageEvent({
      timestamp: 1,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 58_077_533,
      inputTokens: 4089,
      outputTokens: 1442,
      cacheReadTokens: 587_296,
      isTokenBasedCall: true,
      requests: 58_077_533,
    });
    const normalized = normalizeUsageEventRequests(polluted);
    expect(normalized.totalTokens).toBe(592_827);
    expect(usageEventFingerprint(polluted)).toBe(usageEventFingerprint(normalized));
  });
});

describe("UsageEventStore", () => {
  const extensionPath = process.cwd();

  it("replaces existing events with the same fingerprint on upsert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const eventA = usageEvent({
      timestamp: 1_700_000_000_000,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 100,
      requests: 1,
      spendCents: 0,
    });
    const eventAUpdated = usageEvent({
      timestamp: 1_700_000_000_000,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 100,
      requests: 2,
      spendCents: 0,
    });

    expect(store.upsertEvents([eventA])).toBe(1);
    expect(store.upsertEvents([eventAUpdated])).toBeGreaterThan(0);
    expect(store.getEventCount()).toBe(1);

    const loaded = store.getEventsSince(0);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.requests).toBe(2);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts distinct events and ignores duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const eventA = usageEvent({
      timestamp: 1_700_000_000_000,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 100,
      spendCents: 0,
    });
    const eventB = usageEvent({
      timestamp: 1_700_000_000_000,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 100,
      spendCents: 25,
    });

    expect(store.upsertEvents([eventA])).toBe(1);
    expect(store.upsertEvents([eventA])).toBe(1);
    expect(store.upsertEvents([eventB])).toBe(1);
    expect(store.getEventCount()).toBe(2);

    const loaded = store.getEventsSince(0);
    expect(loaded).toHaveLength(2);
    expect(loaded.some((e) => e.spendCents === 25)).toBe(true);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not duplicate when requests are normalized to the same logical event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const polluted = usageEvent({
      timestamp: 1_700_000_000_000,
      model: "gpt-5",
      kind: "Included",
      totalTokens: 100,
      isTokenBasedCall: true,
      requests: 29_648_584,
      spendCents: 0,
    });
    const normalized = normalizeUsageEventRequests(polluted);

    expect(store.upsertEvents([polluted])).toBe(1);
    expect(store.upsertEvents([normalized])).toBeGreaterThan(0);
    expect(store.getEventCount()).toBe(1);

    const loaded = store.getEventsSince(0);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.requests).toBe(1);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates legacy rows with polluted requests on first init", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const legacy = new UsageEventStore(dir, extensionPath);
    await legacy.init();

    const polluted = usageEvent({
      timestamp: 1_700_000_000_001,
      model: "claude-4.6-sonnet",
      kind: "Included",
      totalTokens: 50_000,
      isTokenBasedCall: true,
      requests: 29_648_584,
      spendCents: 0,
    });
    legacy.upsertEvents([polluted]);
    legacy.close();

    const reopened = new UsageEventStore(dir, extensionPath);
    await reopened.init();
    expect(reopened.getEventCount()).toBe(1);
    const loaded = reopened.getEventsSince(0);
    expect(loaded[0]!.requests).toBe(1);

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncEventsFromApi replaces events in window and removes stale rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const oldTs = 1_600_000_000_000;
    const inWindowTs = 1_700_000_000_000;
    const sinceMs = 1_650_000_000_000;

    store.upsertEvents([
      usageEvent({ timestamp: oldTs, model: "legacy", kind: "Included", totalTokens: 1, spendCents: 0 }),
      usageEvent({ timestamp: inWindowTs, model: "stale", kind: "Included", totalTokens: 50, spendCents: 0 }),
    ]);
    expect(store.getEventCount()).toBe(2);

    const fresh = usageEvent({
      timestamp: inWindowTs,
      model: "fresh",
      kind: "Included",
      totalTokens: 200,
      spendCents: 10,
    });
    expect(store.syncEventsFromApi([fresh], sinceMs)).toBe(1);

    const all = store.getEventsSince(0);
    expect(all).toHaveLength(2);
    expect(all.some((e) => e.model === "legacy")).toBe(true);
    expect(all.some((e) => e.model === "stale")).toBe(false);
    expect(all.some((e) => e.model === "fresh" && e.spendCents === 10)).toBe(true);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncEventsFromApi does not touch events older than sinceMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const oldTs = 1_600_000_000_000;
    const sinceMs = 1_650_000_000_000;

    store.upsertEvents([
      usageEvent({ timestamp: oldTs, model: "ancient", kind: "Included", totalTokens: 1, spendCents: 0 }),
    ]);
    expect(store.syncEventsFromApi([], sinceMs, { allowEmpty: true })).toBe(0);
    expect(store.getEventCount()).toBe(1);
    expect(store.getEventsSince(0)[0]!.model).toBe("ancient");

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncEventsFromApi skips empty sync without allowEmpty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const inWindowTs = 1_700_000_000_000;
    const sinceMs = 1_650_000_000_000;
    store.upsertEvents([
      usageEvent({ timestamp: inWindowTs, model: "keep", kind: "Included", totalTokens: 1, spendCents: 0 }),
    ]);

    expect(store.syncEventsFromApi([], sinceMs)).toBe(0);
    expect(store.getEventCount()).toBe(1);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a saved day's tokens when a shorter snapshot is not total-covered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const dayTs = 1_700_000_000_000;
    const sinceMs = 1_650_000_000_000;
    store.upsertEvents([
      usageEvent({
        timestamp: dayTs,
        model: "composer-2.5",
        kind: "Included",
        totalTokens: 970_800_000,
        spendCents: 0,
      }),
      usageEvent({
        timestamp: dayTs + 1,
        model: "default",
        kind: "Included",
        totalTokens: 50,
        spendCents: 0,
      }),
    ]);

    const snapshot = usageEvent({
      timestamp: dayTs + 2,
      model: "fresh",
      kind: "Included",
      totalTokens: 10,
      spendCents: 1,
    });
    store.syncEventsFromApi([snapshot], sinceMs);

    const inWindow = store.getEventsSince(sinceMs);
    expect(inWindow).toHaveLength(3);
    expect(inWindow.some((event) => event.totalTokens === 970_800_000)).toBe(true);
    expect(inWindow.some((event) => event.model === "fresh")).toBe(true);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the window when a shorter snapshot is total-covered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const dayTs = 1_700_000_000_000;
    const sinceMs = 1_650_000_000_000;
    store.upsertEvents([
      usageEvent({
        timestamp: dayTs,
        model: "composer-2.5",
        kind: "Included",
        totalTokens: 970_800_000,
        spendCents: 0,
      }),
    ]);

    const snapshot = usageEvent({
      timestamp: dayTs + 2,
      model: "fresh",
      kind: "Included",
      totalTokens: 10,
      spendCents: 1,
    });
    expect(store.syncEventsFromApi([snapshot], sinceMs, { totalCovered: true })).toBe(1);

    const inWindow = store.getEventsSince(sinceMs);
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]!.model).toBe("fresh");
    expect(inWindow.some((event) => event.totalTokens === 970_800_000)).toBe(false);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts Grok Bot rows apart from the usage archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    store.upsertEvents([
      usageEvent({
        timestamp: 1_700_000_000_000,
        model: "composer-2.5",
        kind: "Included",
        totalTokens: 100,
        spendCents: 10,
      }),
      usageEvent({
        timestamp: 1_700_000_000_100,
        model: "grok-bot-default",
        kind: "Included",
        totalTokens: 40,
        spendCents: 8,
      }),
      usageEvent({
        timestamp: 1_700_000_000_200,
        model: "Grok-Bot-CUA",
        kind: "Included",
        totalTokens: 20,
        spendCents: 4,
      }),
    ]);

    expect(store.getEventCount()).toBe(3);
    expect(store.getGrokBotEventCount()).toBe(2);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("purges events before the cutoff, shrinks the file, and keeps the boundary row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const dbPath = join(dir, "usage-events.sqlite");
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const cutoffMs = 1_700_000_000_000;
    store.upsertEvents([
      usageEvent({
        timestamp: cutoffMs,
        model: "kept",
        kind: "Included",
        totalTokens: 10,
        spendCents: 1,
      }),
      usageEvent({
        timestamp: cutoffMs - 1,
        model: "old",
        kind: "Included",
        totalTokens: 10,
        spendCents: 1,
        conversationId: "x".repeat(80_000),
      }),
    ]);
    store.flushPersist();
    const sizeBefore = statSync(dbPath).size;

    expect(store.purgeEventsBefore(cutoffMs)).toBe(1);
    expect(statSync(dbPath).size).toBeLessThan(sizeBefore);

    store.close();
    const reopened = new UsageEventStore(dir, extensionPath);
    await reopened.init();
    const events = reopened.getEventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.model).toBe("kept");

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("bumps the store revision only when the event content changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const revInitial = store.getStoreRevision();
    const event = usageEvent({
      timestamp: 1_700_000_000_000,
      model: "revision-model",
      kind: "Included",
      totalTokens: 10,
      spendCents: 1,
    });

    store.upsertEvents([event]);
    const revAfterInsert = store.getStoreRevision();
    expect(revAfterInsert).toBeGreaterThan(revInitial);

    // Stesso payload: la revisione non deve muoversi, altrimenti ogni refresh
    // forzirebbe un nuovo invio della finestra eventi via RPC.
    store.upsertEvents([event]);
    expect(store.getStoreRevision()).toBe(revAfterInsert);

    store.upsertEvents([{ ...event, spendCents: 2 }]);
    expect(store.getStoreRevision()).toBeGreaterThan(revAfterInsert);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not bump the revision when syncEventsFromApi rewrites identical payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const sinceMs = 1_650_000_000_000;
    const events = [
      usageEvent({
        timestamp: 1_700_000_000_000,
        model: "sync-model",
        kind: "Included",
        totalTokens: 10,
        spendCents: 1,
      }),
      usageEvent({
        timestamp: 1_700_000_100_000,
        model: "sync-model-2",
        kind: "On-Demand",
        totalTokens: 5,
        spendCents: 3,
      }),
    ];
    store.syncEventsFromApi(events, sinceMs, { totalCovered: true });
    const revAfterSync = store.getStoreRevision();
    expect(revAfterSync).toBeGreaterThan(0);

    // Stesso snapshot: DELETE + INSERT identici non devono muovere la revisione,
    // altrimenti ogni sync forzirebbe il re-invio della finestra eventi via RPC.
    store.syncEventsFromApi(events, sinceMs, { totalCovered: true });
    expect(store.getStoreRevision()).toBe(revAfterSync);

    // Una riga in meno nella finestra è un cambiamento.
    store.syncEventsFromApi([events[0]!], sinceMs, { totalCovered: true });
    expect(store.getStoreRevision()).toBeGreaterThan(revAfterSync);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips vacuum and reports zero when nothing is older than the cutoff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-usage-store-"));
    const dbPath = join(dir, "usage-events.sqlite");
    const store = new UsageEventStore(dir, extensionPath);
    await store.init();

    const cutoffMs = 1_700_000_000_000;
    store.upsertEvents([
      usageEvent({
        timestamp: cutoffMs + 1,
        model: "fresh",
        kind: "Included",
        totalTokens: 10,
        spendCents: 1,
      }),
    ]);
    store.flushPersist();
    const sizeBefore = statSync(dbPath).size;

    expect(store.purgeEventsBefore(cutoffMs)).toBe(0);
    // Nessun VACUUM e nessuna riscrittura del file quando non ci sono righe obsolete.
    expect(statSync(dbPath).size).toBe(sizeBefore);
    expect(store.getEventCount()).toBe(1);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
