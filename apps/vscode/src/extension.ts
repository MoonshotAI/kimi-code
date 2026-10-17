import * as vscode from 'vscode';

import { ensureServer, type EnsuredServer } from './server-manager';
import { buildErrorHtml, buildWebviewHtml } from './webview-html';

const VIEW_ID = 'kimi.webview';

let serverPromise: Promise<EnsuredServer> | undefined;
let spawned: EnsuredServer['spawned'];
let panel: vscode.WebviewPanel | undefined;

interface KimiConfig {
  readonly serverUrl: string;
  readonly serverToken: string;
  readonly cliPath: string;
}

function readConfig(): KimiConfig {
  const config = vscode.workspace.getConfiguration('kimi');
  return {
    serverUrl: config.get<string>('serverUrl', ''),
    serverToken: config.get<string>('serverToken', ''),
    cliPath: config.get<string>('cliPath', ''),
  };
}

function resolveServer(): Promise<EnsuredServer> {
  serverPromise ??= ensureServer(readConfig()).catch((error: unknown) => {
    serverPromise = undefined;
    throw error;
  });
  return serverPromise;
}

async function loadInto(webview: vscode.Webview): Promise<void> {
  try {
    const server = await resolveServer();
    spawned = server.spawned;
    webview.html = buildWebviewHtml({ origin: server.origin, token: server.token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Kimi Code: could not reach a Kimi server — ${message}`);
    webview.html = buildErrorHtml(message);
  }
}

class KimiSidebarProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    void loadInto(view.webview);
  }
}

function openInTab(): void {
  if (panel !== undefined) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel(VIEW_ID, 'Kimi Code', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => {
    panel = undefined;
  });
  void loadInto(panel.webview);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, new KimiSidebarProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('kimi.openInTab', openInTab),
    vscode.commands.registerCommand('kimi.openInSideBar', () => {
      void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
  );
}

export function deactivate(): void {
  spawned?.child.kill();
  spawned = undefined;
}
