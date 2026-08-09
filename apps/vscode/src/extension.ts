import * as vscode from "vscode";

import { Events } from "../shared/bridge";
import { KimiWebviewProvider } from "./KimiWebviewProvider";
import { onSettingsChange, VSCodeSettings } from "./config/vscode-settings";
import {
  LegacyMigrationManager,
  type LegacyMigrationDiscovery,
  type LegacyMigrationRunResult,
} from "./migration";
import { updateLoginContext } from "./utils/context";

let outputChannel: vscode.OutputChannel | undefined;
let provider: KimiWebviewProvider | undefined;

const LEGACY_REAUTH_NOTICE_KEY = "kimi.legacyMigration.reauthNotice.v1";
const LEGACY_WARNING_NOTICE_KEY = "kimi.legacyMigration.warningNotice.v1";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Kimi Code");
  const remoteInfo = vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : "";
  log(`Kimi Code ${VSCodeSettings.getExtensionConfig().version} activating${remoteInfo}`);

  provider = new KimiWebviewProvider(
    context.extensionUri,
    context,
    () => outputChannel?.show(),
    (message) => log(message),
  );
  context.subscriptions.push(provider, outputChannel);

  let isLoggedIn = false;
  try {
    isLoggedIn = await updateLoginContext(provider.harness);
  } catch (error) {
    logError("Unable to determine login status", error);
  }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("kimi-baseline", {
      provideTextDocumentContent: async (uri) => {
        const sessionId = new URLSearchParams(uri.query).get("sessionId");
        if (!sessionId || !provider) return "";
        const relativePath = decodeURIComponent(uri.path.replace(/^\//, ""));
        try {
          return await provider.getBaselineContent(sessionId, relativePath);
        } catch (error) {
          logError("Unable to open baseline content", error);
          return "";
        }
      },
    }),
  );

  context.subscriptions.push(
    onSettingsChange((changedKeys) => {
      provider?.broadcast(Events.ExtensionConfigChanged, {
        config: VSCodeSettings.getExtensionConfig(),
        changedKeys,
      });
      if (changedKeys.includes("yoloMode")) {
        void provider
          ?.setYoloModeForActiveSessions(VSCodeSettings.yoloMode)
          .catch((error) => logError("Unable to update session permission", error));
      }
    }),
    vscode.window.registerWebviewViewProvider("kimi.webview", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const migrationManager = new LegacyMigrationManager({
    targetHome: provider.harness.homeDir,
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    legacyEnvironmentVariables: vscode.workspace
      .getConfiguration("kimi")
      .get<unknown>("environmentVariables"),
  });
  let migrationInFlight: Promise<void> | undefined;
  const runMigration = (retry: boolean): Promise<void> => {
    if (migrationInFlight !== undefined) return migrationInFlight;
    migrationInFlight = performMigration(migrationManager, retry).finally(() => {
      migrationInFlight = undefined;
    });
    return migrationInFlight;
  };

  const commands: Record<string, () => void | Promise<void>> = {
    "kimi.clearAllState": async () => {
      await context.globalState.update("kimi.config", undefined);
      await context.globalState.update("kimi.mcpServers", undefined);
      await context.workspaceState.update("kimi.mcpEnabled", undefined);
      await vscode.window.showInformationMessage("Kimi: Extension UI state cleared.");
    },
    "kimi.openInTab": () => {
      provider?.createPanel();
    },
    "kimi.openInSideBar": async () => {
      await vscode.commands.executeCommand("kimi.webview.focus");
    },
    "kimi.focusInput": async () => {
      await vscode.commands.executeCommand("kimi.webview.focus");
      provider?.broadcast(Events.FocusInput, {});
    },
    "kimi.insertMention": async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showWarningMessage("No active editor");
        return;
      }
      await vscode.commands.executeCommand("kimi.webview.focus");
      if (!(await provider?.insertEditorMention(editor.document.uri, editor.selection))) {
        await vscode.window.showWarningMessage("The active file is outside the selected working directory.");
      }
    },
    "kimi.newConversation": async () => {
      await vscode.commands.executeCommand("kimi.webview.focus");
      provider?.broadcast(Events.NewConversation, {});
    },
    "kimi.showLogs": () => outputChannel?.show(),
    "kimi.resetKimi": () => provider?.resetAllWebviews(),
    "kimi.logout": async () => {
      await vscode.commands.executeCommand("kimi.webview.focus");
      await vscode.window.showInformationMessage("Use the logout button in Kimi settings.");
    },
    "kimi.migrateLegacyData": () => runMigration(true),
  };

  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  void offerLegacyMigration(
    migrationManager,
    () => runMigration(false),
    context.globalState,
    isLoggedIn,
  ).catch((error) => {
    logError("Unable to check for legacy Kimi data", error);
  });
  log("Kimi Code activated");
}

export async function deactivate(): Promise<void> {
  log("Kimi Code deactivating");
  await provider?.shutdown();
  provider = undefined;
}

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log(`${message}: ${detail}`);
}

async function offerLegacyMigration(
  manager: LegacyMigrationManager,
  migrate: () => Promise<void>,
  globalState: vscode.Memento,
  isLoggedIn: boolean,
): Promise<void> {
  const discovery = await manager.discover();
  logMigrationDiscovery(discovery);
  const reauthNotice = legacyReauthNotice(discovery, isLoggedIn);
  const warningNotice =
    discovery.warnings.length === 0
      ? null
      : "Some legacy Kimi data could not be inspected. Use “Kimi Code: Migrate Legacy Data” to retry.";
  if (discovery.prompt === null) {
    if (reauthNotice !== null && !globalState.get<boolean>(LEGACY_REAUTH_NOTICE_KEY, false)) {
      await vscode.window.showWarningMessage(reauthNotice);
      await globalState.update(LEGACY_REAUTH_NOTICE_KEY, true);
    }
    if (
      discovery.warnings.length > 0 &&
      !globalState.get<boolean>(LEGACY_WARNING_NOTICE_KEY, false)
    ) {
      const action = await vscode.window.showWarningMessage(
        warningNotice ?? "Some legacy Kimi data could not be inspected.",
        "Show Logs",
      );
      await globalState.update(LEGACY_WARNING_NOTICE_KEY, true);
      if (action === "Show Logs") outputChannel?.show();
    }
    return;
  }

  const action = await vscode.window.showInformationMessage(
    [discovery.prompt.message, reauthNotice, warningNotice]
      .filter((message) => message !== null)
      .join(" "),
    ...discovery.prompt.actions.map(({ label }) => label),
  );
  if (reauthNotice !== null) await globalState.update(LEGACY_REAUTH_NOTICE_KEY, true);
  if (warningNotice !== null) await globalState.update(LEGACY_WARNING_NOTICE_KEY, true);
  if (action === "Migrate Now") await migrate();
}

function legacyReauthNotice(
  discovery: LegacyMigrationDiscovery,
  isLoggedIn: boolean,
): string | null {
  const kimiLogins = isLoggedIn ? 0 : discovery.notices.oauthLoginsRequiringRelogin.length;
  const mcpLogins = discovery.notices.mcpOauthServersRequiringReauth.length;
  if (kimiLogins === 0 && mcpLogins === 0) return null;
  if (kimiLogins > 0 && mcpLogins > 0) {
    return "Legacy OAuth credentials are not copied. Sign in to Kimi Code and authorize your MCP servers again.";
  }
  return kimiLogins > 0
    ? "Legacy OAuth credentials are not copied. Sign in to Kimi Code again."
    : "Legacy MCP OAuth credentials are not copied. Authorize those MCP servers again.";
}

async function performMigration(
  manager: LegacyMigrationManager,
  retry: boolean,
): Promise<void> {
  log(`${retry ? "Retrying" : "Starting"} legacy Kimi data migration`);
  const result = retry ? await manager.retry() : await manager.migrateNow();
  logMigrationResult(result);

  if (result.status === "completed" || result.status === "partial") {
    try {
      await provider?.harness.getConfig({ reload: true });
      await provider?.resetAllWebviews();
    } catch (error) {
      logError("Migration finished, but the runtime config could not be reloaded", error);
    }
  }

  const reauthCount =
    result.notices.oauthLoginsRequiringRelogin.length +
    result.notices.mcpOauthServersRequiringReauth.length;
  const reauthNotice =
    reauthCount === 0
      ? ""
      : ` ${reauthCount} OAuth connection(s) must be signed in again.`;
  const message = `${result.message}${reauthNotice}`;
  const needsLogs =
    result.status === "partial" ||
    result.status === "failed" ||
    result.warnings.length > 0 ||
    result.manualActions.length > 0;

  if (result.status === "failed") {
    const action = await vscode.window.showErrorMessage(message, "Show Logs");
    if (action === "Show Logs") outputChannel?.show();
  } else if (needsLogs) {
    const action = await vscode.window.showWarningMessage(message, "Show Logs");
    if (action === "Show Logs") outputChannel?.show();
  } else {
    await vscode.window.showInformationMessage(message);
  }
}

function logMigrationDiscovery(discovery: LegacyMigrationDiscovery): void {
  for (const warning of discovery.warnings) log(`Legacy migration warning: ${warning.message}`);
  for (const source of discovery.suppressedSources) {
    log(`Legacy migration already completed for ${source.sourceHome}`);
  }
}

function logMigrationResult(result: LegacyMigrationRunResult): void {
  const { totals } = result;
  log(
    `Legacy migration ${result.status}: config=${totals.configFiles} mcp=${totals.mcpServers} history=${totals.userHistoryEntries} skills=${totals.skills} sessions=${totals.sessions} alreadyMigrated=${totals.alreadyMigratedSessions} skipped=${totals.skippedItems} conflicts=${totals.conflicts} failures=${totals.failures}`,
  );
  for (const warning of result.warnings) log(`Legacy migration warning: ${warning.message}`);
  for (const source of result.sources) {
    for (const failure of source.failures) {
      log(`Legacy migration failure (${failure.sourceHome}): ${failure.message}`);
    }
  }
  for (const action of result.manualActions) log(`Legacy migration action: ${action}`);
}

export { log };
