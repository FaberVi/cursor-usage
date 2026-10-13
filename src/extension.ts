import * as vscode from "vscode";
import { configure } from "./cursor-api";
import { resolveConfiguredUsageDuration } from "./duration-options";
import { DashboardPanel, OPEN_DASHBOARD_COMMAND } from "./dashboard-panel";
import { getDashboardLocale } from "./dashboard-locale-state";
import { OPEN_DURATION_SETTING_COMMAND } from "./tooltip";
import { t, tf } from "./i18n";
import {
  cleanupExtensionRefresh,
  getDashboardState,
  handleConversationPreviewChange,
  initExtensionRefresh,
  log,
  refreshOnFocus,
  refreshPricingCatalog,
  refreshStatusBarFromLastData,
  scheduleRefresh,
  showDetails,
  isUsageRefreshBusy,
  updateUsage,
} from "./extension-refresh";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Cursor Usage");
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = OPEN_DASHBOARD_COMMAND;
  statusBarItem.text = `$(loading~spin) ${t(getDashboardLocale(context), "statusBarUsage")}`;
  statusBarItem.show();

  initExtensionRefresh(context, statusBarItem, outputChannel);

  configure({ logger: log });
  log("Extension activating...");

  const showDetailsCmd = vscode.commands.registerCommand("cursor-usage.showDetails", showDetails);
  const refreshCmd = vscode.commands.registerCommand("cursor-usage.refresh", () => updateUsage({ force: true }));
  const refreshPricingCmd = vscode.commands.registerCommand("cursor-usage.refreshPricingCatalog", async () => {
    const locale = getDashboardLocale(context);
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t(locale, "pricingSyncProgress"),
          cancellable: false,
        },
        () => refreshPricingCatalog(),
      );
      void vscode.window.showInformationMessage(
        tf(locale, "pricingSyncSuccess", { updated: result.updated, added: result.added }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Pricing catalog sync failed: ${message}`);
      void vscode.window.showErrorMessage(tf(locale, "pricingSyncFailed", { error: message }));
    }
  });
  const openDurationSettingCmd = vscode.commands.registerCommand(
    OPEN_DURATION_SETTING_COMMAND,
    () => vscode.commands.executeCommand("workbench.action.openSettings", "cursorUsage.usageDuration"),
  );
  const openDashboardCmd = vscode.commands.registerCommand(OPEN_DASHBOARD_COMMAND, () => {
    DashboardPanel.createOrShow(
      context,
      updateUsage,
      getDashboardState,
      refreshStatusBarFromLastData,
      handleConversationPreviewChange,
      isUsageRefreshBusy,
    );
    DashboardPanel.currentPanel?.postState(getDashboardState());
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("cursorUsage.minimalMode")
      || e.affectsConfiguration("cursorUsage.usageDuration")
      || e.affectsConfiguration("cursorUsage.modelBreakdownSortBy")
      || e.affectsConfiguration("cursorUsage.modelBreakdownSortOrder")
      || e.affectsConfiguration("cursorUsage.excludeZeroTokenModels")
      || e.affectsConfiguration("cursorUsage.quotaAwareEventDisplay")
    ) {
      refreshStatusBarFromLastData();
      DashboardPanel.currentPanel?.postState(getDashboardState());
    }
    if (e.affectsConfiguration("cursorUsage.usageDuration")) {
      const state = getDashboardState();
      const hasBillingCycle = Boolean(state?.resetsAt);
      const range = resolveConfiguredUsageDuration(
        vscode.workspace.getConfiguration("cursorUsage").get("usageDuration"),
        hasBillingCycle,
      );
      DashboardPanel.currentPanel?.postRangePreference(range);
    }
  });

  const docChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme === "file") {
      scheduleRefresh();
    }
  });

  const focusListener = vscode.window.onDidChangeWindowState(refreshOnFocus);

  const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
    refreshStatusBarFromLastData();
  });

  context.subscriptions.push(
    statusBarItem,
    showDetailsCmd,
    refreshCmd,
    refreshPricingCmd,
    openDurationSettingCmd,
    openDashboardCmd,
    configListener,
    docChangeListener,
    focusListener,
    themeListener,
    outputChannel,
  );

  log("Extension activated, fetching initial usage...");
  updateUsage();
}

export function deactivate() {
  cleanupExtensionRefresh();
}
