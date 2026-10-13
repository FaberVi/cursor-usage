import * as vscode from "vscode";
import {
  CONVERSATION_PREVIEW_KEY,
  DASHBOARD_CURRENCY_KEY,
  DASHBOARD_LOCALE_KEY,
  isDashboardCurrency,
  isDashboardLocale,
  type DashboardCurrency,
  type DashboardLocale,
} from "./dashboard-locale";
import { getDashboardLocale } from "./dashboard-locale-state";
import { getDashboardCurrency } from "./dashboard-currency-state";
import { loadConversationMessages } from "./conversation-messages";
import {
  loadDashboardUiPreferences,
  saveDashboardUiPreferences,
  type DashboardUiPreferences,
} from "./dashboard-ui-state";
import { normalizeUsageDuration, resolveConfiguredUsageDuration, syncUsageDurationToSettings } from "./duration-options";
import type { UsageDuration } from "./model-breakdown";
import type { DashboardState, UsageFilter } from "./dashboard-state";
import type { UpdateUsageOptions } from "./extension-refresh";
import { refreshPricingCatalog } from "./pricing-catalog-refresh";
import { makeDashboardNonce, renderDashboardHtml } from "./dashboard/dashboard-html";

type RefreshFn = (opts?: UpdateUsageOptions) => Promise<void>;
type StateProvider = () => DashboardState | null;
type LocaleChangeFn = (locale: DashboardLocale) => void;
type PreviewChangeFn = (enabled: boolean) => void | Promise<void>;
type RefreshBusyFn = () => boolean;
type ConversationMessages = Awaited<ReturnType<typeof loadConversationMessages>>;

type DashboardEventFilter = {
  range: UsageDuration;
  usageFilter: UsageFilter;
};

function isUsageDuration(value: unknown): value is UsageDuration {
  return value === "1d" || value === "7d" || value === "30d" || value === "billingCycle";
}

function isUsageFilter(value: unknown): value is UsageFilter {
  return value === "all" || value === "included" || value === "ondemand";
}

export function isSafeConversationId(id: string): boolean {
  const trimmed = id.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return false;
  return /^[0-9a-fA-F-]+$/.test(trimmed);
}

export const OPEN_DASHBOARD_COMMAND = "cursor-usage.openDashboard";

export class DashboardPanel {
  static currentPanel: DashboardPanel | undefined;

  static createOrShow(
    context: vscode.ExtensionContext,
    onRefresh: RefreshFn,
    getState: StateProvider,
    onLocaleChange?: LocaleChangeFn,
    onPreviewChange?: PreviewChangeFn,
    getRefreshBusy?: RefreshBusyFn,
  ): DashboardPanel {
  if (DashboardPanel.currentPanel) {
    DashboardPanel.currentPanel.updateCallbacks(onLocaleChange, onPreviewChange, getRefreshBusy);
    if (getRefreshBusy?.()) {
      DashboardPanel.currentPanel.postLoading(true);
    }
    DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
    return DashboardPanel.currentPanel;
  }

    const panel = vscode.window.createWebviewPanel(
      "cursorUsageDashboard",
      "Cursor Usage",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel,
      context,
      onRefresh,
      getState,
      onLocaleChange,
      onPreviewChange,
      getRefreshBusy,
    );
    return DashboardPanel.currentPanel;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private onLocaleChange?: LocaleChangeFn;
  private onPreviewChange?: PreviewChangeFn;
  private getRefreshBusy?: RefreshBusyFn;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly getState: StateProvider;
  private dashboardPrefs: DashboardEventFilter = {
    range: "billingCycle",
    usageFilter: "all",
  };
  private readonly conversationLoads = new Map<string, Promise<ConversationMessages>>();

  static getDashboardEventFilter(): DashboardEventFilter | null {
    return DashboardPanel.currentPanel?.dashboardPrefs ?? null;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    onRefresh: RefreshFn,
    getState: StateProvider,
    onLocaleChange?: LocaleChangeFn,
    onPreviewChange?: PreviewChangeFn,
    getRefreshBusy?: RefreshBusyFn,
  ) {
    this.panel = panel;
    this.context = context;
    this.getState = getState;
    this.onLocaleChange = onLocaleChange;
    this.onPreviewChange = onPreviewChange;
    this.getRefreshBusy = getRefreshBusy;
    this.panel.webview.html = this.renderHtml(panel.webview, context.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ready") {
          const state = getState();
          const hasBillingCycle = Boolean(state?.resetsAt);
          const prefs = loadDashboardUiPreferences(this.context);
          const cfgRange = resolveConfiguredUsageDuration(
            vscode.workspace.getConfiguration("cursorUsage").get("usageDuration"),
            hasBillingCycle,
          );
          const mergedPrefs = {
            ...prefs,
            range: prefs.range ?? cfgRange,
          };
          if (!prefs.range) {
            await saveDashboardUiPreferences(this.context, { range: cfgRange });
          }
          this.postUiPreferences(mergedPrefs);
          const savedLocale = this.context.globalState.get<DashboardLocale>(DASHBOARD_LOCALE_KEY);
          if (isDashboardLocale(savedLocale)) {
            this.panel.webview.postMessage({ type: "init", locale: savedLocale });
          }
          const savedCurrency = this.context.globalState.get<DashboardCurrency>(DASHBOARD_CURRENCY_KEY);
          if (isDashboardCurrency(savedCurrency)) {
            this.panel.webview.postMessage({ type: "initCurrency", currency: savedCurrency });
          }
          const previewEnabled = this.context.globalState.get<boolean>(CONVERSATION_PREVIEW_KEY) === true;
          this.panel.webview.postMessage({ type: "initPreview", enabled: previewEnabled });
          if (state) this.postState(state);
          if (this.getRefreshBusy?.()) {
            this.postLoading(true);
          }
        } else if (msg.type === "setLocale" && isDashboardLocale(msg.locale)) {
          await this.context.globalState.update(DASHBOARD_LOCALE_KEY, msg.locale);
          this.onLocaleChange?.(msg.locale);
        } else if (msg.type === "setCurrency" && isDashboardCurrency(msg.currency)) {
          await this.context.globalState.update(DASHBOARD_CURRENCY_KEY, msg.currency);
          this.onLocaleChange?.(getDashboardLocale(this.context));
        } else if (msg.type === "setConversationPreview" && typeof msg.enabled === "boolean") {
          this.panel.webview.postMessage({ type: "previewLoading", on: true });
          try {
            if (this.onPreviewChange) {
              await this.onPreviewChange(msg.enabled);
            } else {
              this.panel.webview.postMessage({
                type: "previewStatus",
                enabled: msg.enabled,
                titleCount: 0,
                conversationCount: 0,
                error: "handler_unavailable",
              });
            }
          } finally {
            this.panel.webview.postMessage({ type: "previewLoading", on: false });
          }
        } else if (msg.type === "saveUiPreferences") {
          const patch = msg.preferences as DashboardUiPreferences | undefined;
          if (patch && typeof patch === "object") {
            await saveDashboardUiPreferences(this.context, patch);
          }
        } else if (msg.type === "syncRangeToSettings" && isUsageDuration(msg.range)) {
          const state = getState();
          const hasBillingCycle = Boolean(state?.resetsAt);
          const normalized = normalizeUsageDuration(msg.range, hasBillingCycle);
          await syncUsageDurationToSettings(msg.range, hasBillingCycle);
          this.dashboardPrefs.range = normalized;
        } else if (msg.type === "syncDashboardPrefs") {
          if (isUsageDuration(msg.range)) {
            const hasBillingCycle = Boolean(getState()?.resetsAt);
            this.dashboardPrefs.range = normalizeUsageDuration(msg.range, hasBillingCycle);
          }
          if (isUsageFilter(msg.usageFilter)) this.dashboardPrefs.usageFilter = msg.usageFilter;
          // Webview already filters charts/tables locally from the full event list.
        } else if (msg.type === "getConversationMessages" && typeof msg.conversationId === "string") {
          const conversationId = msg.conversationId.trim();
          if (!isSafeConversationId(conversationId)) {
            this.panel.webview.postMessage({
              type: "conversationMessages",
              conversationId,
              messages: [],
              error: "invalid conversation id",
            });
            return;
          }
          const inFlight = this.conversationLoads.get(conversationId);
          const loadPromise = inFlight ?? this.loadConversationMessagesFor(conversationId);
          if (!inFlight) this.conversationLoads.set(conversationId, loadPromise);
          try {
            const messages = await loadPromise;
            this.panel.webview.postMessage({
              type: "conversationMessages",
              conversationId,
              messages,
            });
          } catch (err: unknown) {
            this.panel.webview.postMessage({
              type: "conversationMessages",
              conversationId,
              messages: [],
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            if (this.conversationLoads.get(conversationId) === loadPromise) {
              this.conversationLoads.delete(conversationId);
            }
          }
        } else if (msg.type === "refresh") {
          await onRefresh({ force: true });
        } else if (msg.type === "refreshPricingCatalog") {
          this.panel.webview.postMessage({ type: "pricingSyncLoading", on: true });
          try {
            const result = await refreshPricingCatalog();
            this.panel.webview.postMessage({
              type: "pricingSyncStatus",
              ok: true,
              updated: result.updated,
              added: result.added,
              warnings: result.warnings,
            });
            const state = getState();
            if (state) this.postState(state);
          } catch (err: unknown) {
            this.panel.webview.postMessage({
              type: "pricingSyncStatus",
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            this.panel.webview.postMessage({ type: "pricingSyncLoading", on: false });
          }
        }
      },
      null,
      this.disposables,
    );
  }

  private loadConversationMessagesFor(conversationId: string): Promise<ConversationMessages> {
    const conversationEvents = this.getState()?.events.filter(
      (event) => event.conversationId === conversationId,
    ) ?? [];
    return loadConversationMessages(
      conversationId,
      this.context.extensionPath,
      conversationEvents,
    );
  }

  postState(state: DashboardState): void {
    this.panel.webview.postMessage({
      type: "state",
      state,
      locale: getDashboardLocale(this.context),
      currency: getDashboardCurrency(this.context),
    });
  }

  postUiPreferences(preferences: DashboardUiPreferences): void {
    this.panel.webview.postMessage({ type: "uiPreferences", preferences });
  }

  postRangePreference(range: UsageDuration): void {
    this.panel.webview.postMessage({ type: "rangePreference", range });
  }

  postLoading(on: boolean): void {
    this.panel.webview.postMessage({ type: "loading", on });
  }

  postPreviewStatus(enabled: boolean, titleCount: number, conversationCount: number): void {
    this.panel.webview.postMessage({
      type: "previewStatus",
      enabled,
      titleCount,
      conversationCount,
    });
  }

  updateCallbacks(
    onLocaleChange?: LocaleChangeFn,
    onPreviewChange?: PreviewChangeFn,
    getRefreshBusy?: RefreshBusyFn,
  ): void {
    if (onLocaleChange) this.onLocaleChange = onLocaleChange;
    if (onPreviewChange) this.onPreviewChange = onPreviewChange;
    if (getRefreshBusy) this.getRefreshBusy = getRefreshBusy;
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "dashboard", file));

    return renderDashboardHtml(
      webview,
      {
        cssUri: mediaUri("dashboard.css"),
        jsUri: mediaUri("dashboard.js"),
        chartUri: mediaUri("chart.umd.js"),
      },
      makeDashboardNonce(),
    );
  }
}
