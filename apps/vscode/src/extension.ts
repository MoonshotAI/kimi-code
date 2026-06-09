import * as vscode from "vscode";
import * as path from "node:path";
import { KimiWebviewProvider } from "./KimiWebviewProvider";
import { onSettingsChange, VSCodeSettings } from "./config/vscode-settings";
import { initCLIManager, getCLIManager, GitManager } from "./managers";
import { Events } from "../shared/bridge";

let outputChannel: vscode.OutputChannel;
let provider: KimiWebviewProvider;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Kimi Code");

  const remoteInfo = vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : "";
  log(`Kimi Code extension activating...${remoteInfo}`);

  initCLIManager();

  provider = new KimiWebviewProvider(context.extensionUri);

  // Login state is unknown at activation; it is driven by runtime auth
  // signals — a completed turn sets it true, an AUTH_REQUIRED error sets it
  // false (see chat.handler.ts). Default to logged-out so the Login command
  // is offered until a turn succeeds.
  vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", false);

  context.subscriptions.push(provider);
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("kimi-baseline", {
      provideTextDocumentContent: async (uri: vscode.Uri) => {
        const params = new URLSearchParams(uri.query);
        const workDir = params.get("workDir");
        const sessionId = params.get("sessionId");
        if (!workDir || !sessionId) {
          return "";
        }
        const relativePath = uri.path.slice(1);
        const absolutePath = path.join(workDir, relativePath);
        const content = await GitManager.getBaselineContent(workDir, sessionId, absolutePath);
        return content ?? "";
      },
    }),
  );

  context.subscriptions.push(
    onSettingsChange((changedKeys) => {
      provider.broadcast(Events.ExtensionConfigChanged, {
        config: VSCodeSettings.getExtensionConfig(),
        changedKeys,
      });
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("kimi.webview", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const commands: Record<string, () => void | Promise<void>> = {
    "kimi.clearAllState": async () => {
      await context.globalState.update("kimi.config", undefined);
      await context.globalState.update("kimi.mcpServers", undefined);
      await context.workspaceState.update("kimi.mcpEnabled", undefined);
      vscode.window.showInformationMessage("Kimi: All state cleared!");
    },
    "kimi.openInTab": () => {
      log("Opening Kimi in new tab");
      provider.createPanel();
    },
    "kimi.openInSideBar": async () => {
      log("Opening Kimi in side bar");
      await vscode.commands.executeCommand("kimi.webview.focus");
    },
    "kimi.focusInput": async () => {
      log("Focusing Kimi input");
      await vscode.commands.executeCommand("kimi.webview.focus");
      provider.broadcast(Events.FocusInput, {});
    },
    "kimi.insertMention": async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor");
        return;
      }
      const document = editor.document;
      const selection = editor.selection;
      const relativePath = vscode.workspace.asRelativePath(document.uri);

      let mention: string;
      if (selection.isEmpty) {
        mention = `@${relativePath}`;
      } else {
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        mention = startLine === endLine ? `@${relativePath}:${startLine}` : `@${relativePath}:${startLine}-${endLine}`;
      }

      log(`Inserting mention: ${mention}`);
      await vscode.commands.executeCommand("kimi.webview.focus");
      provider.broadcast(Events.InsertMention, { mention });
    },
    "kimi.newConversation": async () => {
      log("Starting new conversation");
      await vscode.commands.executeCommand("kimi.webview.focus");
      provider.broadcast(Events.NewConversation, {});
    },
    "kimi.showLogs": () => {
      outputChannel.show();
    },
    "kimi.login": async () => {
      log("Login requested");
      const executable = getCLIManager().getExecutablePath();
      const terminal = vscode.window.createTerminal("Kimi Code Login");
      terminal.show();
      terminal.sendText(`${quoteShellArg(executable)} acp --login`);
    },
    "kimi.logout": async () => {
      log("Logout requested");
      vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", false);
      vscode.window.showInformationMessage("Kimi Code logout is managed by the CLI token store.");
    },
  };

  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  log("Kimi extension activated");
}

export function deactivate() {
  log("Kimi extension deactivating...");
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  outputChannel?.appendLine(`[${timestamp}] ${message}`);
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export { log };
