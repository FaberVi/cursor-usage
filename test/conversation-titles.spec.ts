import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { attachMessageModels, loadConversationMessages, nearestUsageEventModel, parseBubbleText } from "../src/conversation-messages";
import { buildConversationTitleMap, parseComposerHeaders } from "../src/conversation-titles";
import { parseComposerDataTitle } from "../src/conversation-title-parse";
import * as dbReader from "../src/cursor-db-reader";
import type { UsageEvent } from "../src/cursor-api-types";

const baseEvent: UsageEvent = {
  timestamp: 1_000_000,
  model: "claude-4.6-sonnet",
  kind: "Included",
  totalTokens: 100,
  requests: 1,
  spendCents: 0,
  maxMode: false,
  inputTokens: 50,
  outputTokens: 50,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  tokenCostCents: 0,
  cursorTokenFee: 0,
  isTokenBasedCall: true,
  isHeadless: false,
  isChargeable: true,
  conversationId: "abc",
};

describe("parseComposerHeaders", () => {
  it("maps composerId to name from allComposers", () => {
    const raw = JSON.stringify({
      allComposers: [
        { composerId: "abc-123", name: "Fix dashboard preview", subtitle: "ignored when name exists" },
        { id: "legacy-id", subtitle: "Legacy subtitle" },
      ],
    });
    const titles = parseComposerHeaders(raw);
    expect(titles.get("abc-123")).toBe("Fix dashboard preview");
    expect(titles.get("legacy-id")).toBe("Legacy subtitle");
  });
});

describe("parseComposerDataTitle", () => {
  it("prefers name over subtitle and text", () => {
    const raw = JSON.stringify({ name: "My chat", subtitle: "sub", text: "body text" });
    expect(parseComposerDataTitle(raw)).toBe("My chat");
  });

  it("falls back to subtitle, then to text truncated at 80 chars", () => {
    expect(parseComposerDataTitle(JSON.stringify({ subtitle: "Sub title" }))).toBe("Sub title");
    expect(parseComposerDataTitle(JSON.stringify({ text: "short text" }))).toBe("short text");
    const longText = "x".repeat(100);
    expect(parseComposerDataTitle(JSON.stringify({ text: longText }))).toBe(`${"x".repeat(77)}…`);
  });

  it("returns null for invalid, empty or blank payloads", () => {
    expect(parseComposerDataTitle(null)).toBeNull();
    expect(parseComposerDataTitle("not json")).toBeNull();
    expect(parseComposerDataTitle(JSON.stringify({}))).toBeNull();
    expect(parseComposerDataTitle(JSON.stringify({ name: "   ", subtitle: "  " }))).toBeNull();
  });
});

describe("parseBubbleText", () => {
  it("prefers plain text over rich text", () => {
    expect(parseBubbleText({ text: "Hello", richText: "{\"root\":{}}" })).toBe("Hello");
  });

  it("extracts text from lexical richText", () => {
    const richText = JSON.stringify({
      root: { children: [{ text: "/commit-message", type: "text" }] },
    });
    expect(parseBubbleText({ richText })).toBe("/commit-message");
  });

  it("formats tool bubbles with command detail", () => {
    const text = parseBubbleText({
      capabilityType: 15,
      toolFormerData: {
        name: "run_terminal_command_v2",
        params: JSON.stringify({ command: "git status" }),
      },
    });
    expect(text).toContain("run terminal command v2");
    expect(text).toContain("git status");
  });
});

describe("attachMessageModels", () => {
  it("matches assistant messages to the nearest usage event model", () => {
    const messages = attachMessageModels(
      [{
        id: "m1",
        role: "assistant",
        text: "Risposta",
        createdAt: new Date(1_000_500).toISOString(),
        model: null,
      }],
      [baseEvent],
    );
    expect(messages[0]?.model).toBe("claude-4.6-sonnet");
    expect(messages[0]?.modelEstimated).toBe(true);
  });

  it("keeps bubble-provided models without marking them estimated", () => {
    const messages = attachMessageModels(
      [{
        id: "m1",
        role: "user",
        text: "Ciao",
        createdAt: null,
        model: "default",
        modelEstimated: false,
      }],
      [baseEvent],
    );
    expect(messages[0]?.model).toBe("default");
    expect(messages[0]?.modelEstimated).toBe(false);
  });

  it("returns null when no event is close enough", () => {
    expect(nearestUsageEventModel(5_000_000, [baseEvent])).toBeNull();
  });
});

describe("conversation KV reads", () => {
  const conversationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const headerId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  let spy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  function createConversationDb(): string {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cursor-conv-db-")), "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [
      "composer.composerHeaders",
      JSON.stringify({ allComposers: [{ composerId: headerId, name: "From headers" }] }),
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      `composerData:${conversationId}`,
      JSON.stringify({
        name: "Composer title",
        fullConversationHeadersOnly: [
          { bubbleId: "bubble-a", type: 1 },
          { bubbleId: "bubble-b", type: 2 },
        ],
      }),
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      `bubbleId:${conversationId}:bubble-a`,
      JSON.stringify({ type: 1, text: "hello user" }),
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      `bubbleId:${conversationId}:bubble-b`,
      JSON.stringify({ type: 2, text: "hello assistant" }),
    ]);
    db.close();
    return dbPath;
  }

  it("builds titles from headers and composerData without sql.js", async () => {
    const dbPath = createConversationDb();
    spy = spyOn(dbReader, "getGlobalCursorDbPath").mockReturnValue(dbPath);
    const titles = await buildConversationTitleMap([headerId, conversationId], "/unused");
    expect(titles[headerId]).toBe("From headers");
    expect(titles[conversationId]).toBe("Composer title");
  });

  it("loads ordered conversation messages from the btree reader", async () => {
    const dbPath = createConversationDb();
    spy = spyOn(dbReader, "getGlobalCursorDbPath").mockReturnValue(dbPath);
    const messages = await loadConversationMessages(conversationId, "/unused");
    expect(messages.map((m) => m.text)).toEqual(["hello user", "hello assistant"]);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
  });
});
