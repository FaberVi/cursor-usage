import type { ConversationMessage, UsageEvent } from "./cursor-api-types";
import { getGlobalCursorDbPath, withCursorKvStore } from "./cursor-db-reader";

type BubbleHeader = {
  bubbleId?: string;
  type?: number;
  createdAt?: string;
};

type BubbleRecord = {
  type?: number;
  text?: string;
  richText?: string;
  capabilityType?: number;
  modelInfo?: { modelName?: string };
  toolFormerData?: {
    name?: string;
    params?: string;
    status?: string;
  };
  createdAt?: string;
};

const USAGE_MATCH_WINDOW_MS = 3 * 60_000;

function extractLexicalText(richText: string): string {
  try {
    const parsed = JSON.parse(richText) as { root?: { text?: string; children?: unknown[] } };
    return extractLexicalNode(parsed.root);
  } catch {
    return "";
  }
}

function extractLexicalNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { text?: string; children?: unknown[] };
  if (typeof n.text === "string") return n.text;
  return (n.children ?? []).map(extractLexicalNode).join("");
}

function truncate(text: string, max = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatToolBubble(bubble: BubbleRecord): string {
  const data = bubble.toolFormerData;
  if (!data?.name) return "(tool activity)";

  let detail = "";
  if (data.params) {
    try {
      const params = JSON.parse(data.params) as {
        command?: string;
        description?: string;
        toolName?: string;
      };
      detail = params.command ?? params.description ?? params.toolName ?? "";
    } catch {
      detail = data.params.slice(0, 160);
    }
  }

  const label = data.name.replace(/_/g, " ");
  return truncate(detail ? `${label}: ${detail}` : label, 500);
}

function bubbleRole(type: number | undefined): ConversationMessage["role"] {
  if (type === 1) return "user";
  return "assistant";
}

export function bubbleModelName(bubble: BubbleRecord): string | null {
  const name = bubble.modelInfo?.modelName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export function messageMillis(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nearestUsageEventModel(messageTime: number, events: UsageEvent[]): string | null {
  let best: UsageEvent | null = null;
  let bestDelta = Infinity;

  for (const event of events) {
    const delta = Math.abs(event.timestamp - messageTime);
    if (delta > USAGE_MATCH_WINDOW_MS || delta >= bestDelta) continue;
    bestDelta = delta;
    best = event;
  }

  return best?.model ?? null;
}

export function attachMessageModels(
  messages: ConversationMessage[],
  events: UsageEvent[],
): ConversationMessage[] {
  if (!events.length) return messages;

  return messages.map((message) => {
    if (message.model) return message;
    if (message.role !== "assistant") return message;
    const ms = messageMillis(message.createdAt);
    if (ms == null) return message;
    const model = nearestUsageEventModel(ms, events);
    return model ? { ...message, model, modelEstimated: true } : message;
  });
}

export function parseBubbleText(bubble: BubbleRecord): string {
  if (typeof bubble.text === "string" && bubble.text.trim()) {
    return truncate(bubble.text);
  }
  if (typeof bubble.richText === "string" && bubble.richText.trim()) {
    const fromRich = extractLexicalText(bubble.richText).trim();
    if (fromRich) return truncate(fromRich);
  }
  if (bubble.capabilityType != null || bubble.toolFormerData) {
    return formatToolBubble(bubble);
  }
  return "";
}

function parseConversationOrder(raw: string | null): BubbleHeader[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { fullConversationHeadersOnly?: BubbleHeader[] };
    return parsed.fullConversationHeadersOnly ?? [];
  } catch {
    return [];
  }
}

export async function loadConversationMessages(
  conversationId: string,
  _extensionPath: string,
  usageEvents: UsageEvent[] = [],
): Promise<ConversationMessage[]> {
  if (!conversationId) return [];

  const messages = withCursorKvStore(getGlobalCursorDbPath(), (store) => {
    const composerRaw = store.get("cursorDiskKV", `composerData:${conversationId}`);
    const order = parseConversationOrder(composerRaw);
    const prefix = `bubbleId:${conversationId}:`;
    const bubbleById = new Map<string, BubbleRecord>();

    for (const row of store.getByPrefix("cursorDiskKV", prefix)) {
      const bubbleId = row.key.slice(prefix.length);
      try {
        bubbleById.set(bubbleId, JSON.parse(row.value) as BubbleRecord);
      } catch {
        continue;
      }
    }

    const headers: BubbleHeader[] = order.length > 0
      ? order
      : [...bubbleById.keys()].map((bubbleId): BubbleHeader => ({ bubbleId }));

    const out: ConversationMessage[] = [];
    for (const header of headers) {
      const bubbleId = header.bubbleId;
      if (!bubbleId) continue;
      const bubble = bubbleById.get(bubbleId);
      if (!bubble) continue;
      const text = parseBubbleText(bubble);
      if (!text) continue;
      const bubbleModel = bubbleModelName(bubble);
      out.push({
        id: bubbleId,
        role: bubbleRole(header.type ?? bubble.type),
        text,
        createdAt: header.createdAt ?? bubble.createdAt ?? null,
        model: bubbleModel,
        modelEstimated: false,
      });
    }
    return out;
  });

  return attachMessageModels(messages ?? [], usageEvents);
}
