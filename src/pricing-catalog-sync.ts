import type { ModelPricingCatalog, ModelPricingCatalogOverlay, ModelPricingEntry, ParsedPlanPricingInfo } from "./model-pricing-types";
import { getBundledModelPricingCatalog, validateCatalog } from "./model-pricing-resolve";
import { mergeCatalogsWithStats } from "./pricing-catalog-merge";
import { PricingCatalogStore, type PricingCatalogOverlay } from "./pricing-catalog-store";
import { withTimeout } from "./cursor-api-utils";

export const PRICING_DOCS_URL = "https://cursor.com/docs/models-and-pricing.md";

export type ParsedPricingRow = {
  displayName: string;
  provider: string;
  rates: ModelPricingEntry["rates"];
  hidden?: boolean;
  notes?: string;
};

export type PricingSyncResult = {
  updated: number;
  added: number;
  warnings: string[];
  syncedAt: number;
  runtimeOnlyModelIds: string[];
};

function normalizeDisplayName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseDollarCell(cell: string): number | undefined {
  const trimmed = cell.trim();
  if (!trimmed || trimmed === "-") return undefined;
  const match = trimmed.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : undefined;
}

function parseModelCell(cell: string): string {
  const linkMatch = cell.match(/^\[([^\]]+)\]/);
  return (linkMatch?.[1] ?? cell).trim();
}

function isTableSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

function extractSection(markdown: string, heading: string): string {
  const pattern = new RegExp(`###\\s+${heading}[\\s\\S]*?(?=\\n##\\s|\\n###\\s|$)`, "i");
  const match = markdown.match(pattern);
  return match?.[0] ?? "";
}

function parseMarkdownTable(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!cells.length || isTableSeparator(cells)) continue;
    rows.push(cells);
  }
  return rows;
}

function parsePricingRowsFromSection(section: string): ParsedPricingRow[] {
  const rows = parseMarkdownTable(section);
  if (rows.length < 2) return [];

  const header = rows[0]!.map((cell) => cell.toLowerCase());
  const modelIdx = header.findIndex((cell) => cell.includes("model"));
  const providerIdx = header.findIndex((cell) => cell.includes("provider"));
  const inputIdx = header.findIndex((cell) => cell === "input");
  const cacheWriteIdx = header.findIndex((cell) => cell.includes("cache write"));
  const cacheReadIdx = header.findIndex((cell) => cell.includes("cache read"));
  const outputIdx = header.findIndex((cell) => cell === "output");
  const notesIdx = header.findIndex((cell) => cell.includes("notes"));

  if (modelIdx < 0 || providerIdx < 0 || outputIdx < 0) return [];

  const parsed: ParsedPricingRow[] = [];
  for (const row of rows.slice(1)) {
    const displayName = parseModelCell(row[modelIdx] ?? "");
    if (!displayName) continue;
    const notes = notesIdx >= 0 ? row[notesIdx]?.trim() : undefined;
    parsed.push({
      displayName,
      provider: row[providerIdx] ?? "",
      rates: {
        input: inputIdx >= 0 ? parseDollarCell(row[inputIdx] ?? "") : undefined,
        cacheWrite: cacheWriteIdx >= 0 ? parseDollarCell(row[cacheWriteIdx] ?? "") : undefined,
        cacheRead: cacheReadIdx >= 0 ? parseDollarCell(row[cacheReadIdx] ?? "") : undefined,
        output: parseDollarCell(row[outputIdx] ?? ""),
      },
      hidden: notes?.toLowerCase().includes("hidden by default") ? true : undefined,
      notes: notes || undefined,
    });
  }
  return parsed;
}

export function parseMarkdownPricingTable(markdown: string): ParsedPricingRow[] {
  return parsePricingRowsFromSection(extractSection(markdown, "Model pricing"));
}

/** Base first-party models from `## Cursor Models` (skips Fast variant rows). */
export function parseCursorModelsTable(markdown: string): ParsedPricingRow[] {
  // Current docs: table under "### Cursor models" (Included usage). Legacy stub: "## Cursor Models".
  const modernSection =
    markdown.match(/###\s+Cursor models[\s\S]*?(?=\n##\s|$)/i)?.[0] ?? "";
  const legacySection =
    markdown.match(/##\s+Cursor Models[\s\S]*?(?=\n##\s|\n###\s|$)/i)?.[0] ?? "";
  const section = modernSection || legacySection;
  return parsePricingRowsFromSection(section).filter(
    (row) => !/\(\s*fast\s*\)/i.test(row.displayName),
  );
}

function findExistingByDisplayName(
  byDisplayName: Map<string, ModelPricingEntry>,
  displayName: string,
): ModelPricingEntry | undefined {
  const normalized = normalizeDisplayName(displayName);
  const direct = byDisplayName.get(normalized);
  if (direct) return direct;
  // Docs often omit the "Cursor " prefix (e.g. "Grok 4.6" vs "Cursor Grok 4.6").
  const withCursor = byDisplayName.get(normalizeDisplayName(`Cursor ${displayName}`));
  if (withCursor) return withCursor;
  if (normalized.startsWith("cursor ")) {
    return byDisplayName.get(normalized.slice("cursor ".length));
  }
  return undefined;
}

function parsePlanId(nameCell: string): string | null {
  const bold = nameCell.match(/\*\*([^*]+)\*\*/);
  const raw = (bold?.[1] ?? nameCell).trim().toLowerCase();
  if (raw.includes("start")) return "start";
  if (raw.includes("pro plus")) return "pro-plus";
  if (raw === "pro") return "pro";
  if (raw.includes("ultra")) return "ultra";
  return null;
}

function parsePlanPrice(priceCell: string): number {
  const inr = priceCell.match(/₹([0-9]+)/);
  if (inr) return Number(inr[1]);
  const usd = priceCell.match(/\$([0-9]+)/);
  return usd ? Number(usd[1]) : 0;
}

/** Returns undefined when the cell has no explicit dollar amount (e.g. "Included"). */
function parseApiUsageIncluded(cell: string): number | undefined {
  const match = cell.match(/\$([0-9]+)/);
  if (match) return Number(match[1]);
  if (cell.trim().toLowerCase().includes("not included")) return 0;
  return undefined;
}

export type { ParsedPlanPricingInfo } from "./model-pricing-types";

export function parseMarkdownPlans(markdown: string): ParsedPlanPricingInfo[] {
  const plansSection = markdown.match(/## Plans[\s\S]*?(?=\n##\s|$)/i)?.[0] ?? "";
  const rows = parseMarkdownTable(plansSection);
  if (rows.length < 2) return [];

  const header = rows[0]!.map((cell) => cell.toLowerCase());
  const planIdx = header.findIndex((cell) => cell.includes("plan"));
  const priceIdx = header.findIndex((cell) => cell.includes("price"));
  const usageIdx = header.findIndex(
    (cell) => cell.includes("other models") || cell.includes("third-party"),
  );

  if (planIdx < 0 || priceIdx < 0 || usageIdx < 0) return [];

  const plans: ParsedPlanPricingInfo[] = [];
  for (const row of rows.slice(1)) {
    const id = parsePlanId(row[planIdx] ?? "");
    if (!id) continue;
    const name = parseModelCell(row[planIdx] ?? "").replace(/\*\*/g, "").trim();
    const apiUsageIncluded = parseApiUsageIncluded(row[usageIdx] ?? "");
    plans.push({
      id,
      name: id === "start" ? "Start (India)" : name.replace(/\s*\(.*\)\s*$/, "").trim(),
      priceMonthly: parsePlanPrice(row[priceIdx] ?? ""),
      ...(apiUsageIncluded !== undefined ? { apiUsageIncluded } : {}),
    });
  }
  return plans;
}

export function parseCursorTokenRate(markdown: string): number | undefined {
  const match = markdown.match(/Cursor Token Rate[^$\n]*\$([0-9.]+)\s+per million/i);
  return match ? Number(match[1]) : undefined;
}

function slugFromDisplayName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildDisplayNameIndex(catalog: ModelPricingCatalog): Map<string, ModelPricingEntry> {
  const index = new Map<string, ModelPricingEntry>();
  for (const entry of catalog.models) {
    index.set(normalizeDisplayName(entry.displayName), entry);
  }
  return index;
}

function isBundledModel(entry: ModelPricingEntry, bundled: ModelPricingCatalog): boolean {
  const name = normalizeDisplayName(entry.displayName);
  return bundled.models.some(
    (model) => model.id === entry.id || normalizeDisplayName(model.displayName) === name,
  );
}

export function buildOverlayFromMarkdown(
  markdown: string,
  baseCatalog: ModelPricingCatalog = getBundledModelPricingCatalog(),
): {
  overlay: ModelPricingCatalogOverlay;
  warnings: string[];
  updated: number;
  added: number;
  runtimeOnlyModelIds: string[];
} {
  const warnings: string[] = [];
  const otherRows = parseMarkdownPricingTable(markdown);
  const cursorRows = parseCursorModelsTable(markdown);
  if (!otherRows.length && !cursorRows.length) {
    warnings.push("No model pricing rows found in markdown");
  }

  const byDisplayName = buildDisplayNameIndex(baseCatalog);
  const overlayModels: ModelPricingEntry[] = [];
  const seenIds = new Set<string>();
  let updated = 0;
  let added = 0;

  const pushRow = (row: ParsedPricingRow, defaultPool: "firstParty" | "api") => {
    const existing = findExistingByDisplayName(byDisplayName, row.displayName);
    if (existing) {
      if (seenIds.has(existing.id)) return;
      seenIds.add(existing.id);
      overlayModels.push({
        id: existing.id,
        displayName: existing.displayName,
        provider: row.provider || existing.provider,
        pool: existing.pool,
        rates: row.rates,
        hidden: row.hidden,
        notes: row.notes,
      });
      updated += 1;
      return;
    }

    const id = slugFromDisplayName(row.displayName);
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const displayName =
      defaultPool === "firstParty" && !/^cursor\s+/i.test(row.displayName)
        ? `Cursor ${row.displayName}`
        : row.displayName;
    overlayModels.push({
      id,
      displayName,
      provider: row.provider,
      pool: defaultPool,
      rates: row.rates,
      hidden: row.hidden,
      notes: row.notes,
      aliases: [id],
    });
    added += 1;
    warnings.push(`New model from docs not in bundled catalog: ${displayName}`);
  };

  for (const row of cursorRows) pushRow(row, "firstParty");
  for (const row of otherRows) pushRow(row, "api");

  const plans = parseMarkdownPlans(markdown);
  const cursorTokenRatePerMillion = parseCursorTokenRate(markdown);
  const today = new Date().toISOString().slice(0, 10);

  const overlay: ModelPricingCatalogOverlay = {
    sourceUrl: baseCatalog.sourceUrl,
    lastUpdated: today,
    models: overlayModels,
  };
  if (plans.length) overlay.plans = plans;
  if (cursorTokenRatePerMillion !== undefined) {
    overlay.cursorTokenRatePerMillion = cursorTokenRatePerMillion;
  }

  const runtimeOnlyModelIds = overlayModels
    .filter((entry) => !isBundledModel(entry, baseCatalog))
    .map((entry) => entry.id);

  const merged = mergeCatalogsWithStats(baseCatalog, overlay);
  try {
    validateCatalog(merged.catalog);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Merged catalog validation failed: ${message}`);
  }

  return { overlay, warnings, updated, added, runtimeOnlyModelIds };
}

export async function fetchPricingDocsMarkdown(
  url: string = PRICING_DOCS_URL,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchFn(url, withTimeout());
  if (!response.ok) {
    throw new Error(`Failed to fetch pricing docs (${response.status})`);
  }
  return response.text();
}

export async function syncPricingCatalogFromMarkdown(
  markdown: string,
  store?: PricingCatalogStore,
  sourceUrl: string = PRICING_DOCS_URL,
): Promise<PricingSyncResult> {
  const { overlay, warnings, updated, added, runtimeOnlyModelIds } = buildOverlayFromMarkdown(markdown);
  const syncedAt = Date.now();
  const saved: PricingCatalogOverlay = { syncedAt, sourceUrl, catalog: overlay, runtimeOnlyModelIds };

  if (store) {
    store.save(saved);
  }

  return { updated, added, warnings, syncedAt, runtimeOnlyModelIds };
}

export async function syncPricingCatalog(
  store: PricingCatalogStore,
  fetchFn: typeof fetch = fetch,
): Promise<PricingSyncResult> {
  const markdown = await fetchPricingDocsMarkdown(PRICING_DOCS_URL, fetchFn);
  return syncPricingCatalogFromMarkdown(markdown, store);
}
