import { getGlobalCursorDbPath } from "./cursor-db-reader";
import { lookupConversationTitles } from "./db-worker-client";

export { getGlobalCursorDbPath };
export { parseComposerHeaders } from "./conversation-title-parse";

export async function buildConversationTitleMap(
  conversationIds: string[],
  _extensionPath: string,
): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(conversationIds.filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const titles = await lookupConversationTitles(getGlobalCursorDbPath(), uniqueIds);
  return titles ?? {};
}
