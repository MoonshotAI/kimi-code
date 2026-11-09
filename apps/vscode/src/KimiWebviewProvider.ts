import * as vscode from "vscode";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";
import { Events, Methods } from "../shared/bridge";
import type { PanelSessionTarget } from "../shared/types";
import { BridgeHandler } from "./bridge-handler";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * Manages webview instances (sidebar and panels).
 * Each webview gets a unique viewId for session isolation.
 */
export class KimiWebviewProvider implements vscode.WebviewViewProvider {
  private webviews = new Map<string, vscode.Webview>();
  private bridgeHandler: BridgeHandler;
  private activeWebviewId: string | undefined;
  private sidebarWebviewId: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    showLogs: () => void,
    writeLog: (message: string) => void,
  ) {
    this.bridgeHandler = new BridgeHandler(
      this.broadcastInternal.bind(this),
      context.workspaceState,
      context.globalStorageUri.fsPath,
      this.reloadWebview.bind(this),
      showLogs,
      writeLog,
    );
  }

  dispose(): void {
    void this.bridgeHandler.dispose();
  }

  shutdown(): Promise<void> {
    return this.bridgeHandler.dispose();
  }

  get harness(): KimiHarness {
    return this.bridgeHandler.runtime.harness;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewId = `sidebar_${crypto.randomUUID()}`;
    this.sidebarWebviewId = webviewId;
    if (webviewView.visible) this.activeWebviewId = webviewId;
    this.setupWebview(webviewId, webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.activeWebviewId = webviewId;
    });

    webviewView.onDidDispose(() => {
      void this.bridgeHandler.disposeView(webviewId);
      this.removeWebview(webviewId);
    });
  }

  createPanel(target?: PanelSessionTarget): vscode.WebviewPanel {
    const webviewId = `panel_${crypto.randomUUID()}`;

    const panel = vscode.window.createWebviewPanel("kimiPanel", "Kimi Code", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    });

    if (target !== undefined) this.bridgeHandler.setPanelSessionTarget(webviewId, target);
    this.setupWebview(webviewId, panel.webview);
    this.activeWebviewId = webviewId;

    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) this.activeWebviewId = webviewId;
    });

    panel.onDidDispose(() => {
      void this.bridgeHandler.disposeView(webviewId);
      this.removeWebview(webviewId);
    });

    return panel;
  }

  broadcast(event: string, data: unknown): void {
    this.broadcastInternal(event, data);
  }

  broadcastToActive(event: string, data: unknown): boolean {
    const webviewId = this.activeTarget();
    if (webviewId === undefined) return false;
    this.broadcastInternal(event, data, webviewId);
    return true;
  }

  activateSidebar(): void {
    if (this.sidebarWebviewId !== undefined) this.activeWebviewId = this.sidebarWebviewId;
  }

  async insertEditorMention(documentUri: vscode.Uri, selection: vscode.Selection): Promise<boolean> {
    const webviewId = this.activeTarget();
    if (webviewId === undefined) return false;
    const mention = await this.bridgeHandler.getEditorMention(webviewId, documentUri, selection);
    if (mention === null) return false;
    this.broadcastInternal(Events.InsertMention, { mention }, webviewId);
    return true;
  }

  private setupWebview(webviewId: string, webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webview.html = this.getHtml(webviewId, webview);
    this.webviews.set(webviewId, webview);

    webview.onDidReceiveMessage(async (msg: unknown) => {
      if (
        typeof msg === "object"
        && msg !== null
        && "method" in msg
        && msg.method === Methods.MarkViewActive
      ) {
        this.activeWebviewId = webviewId;
      }
      const result = await this.bridgeHandler.handle(msg, webviewId);
      webview.postMessage(result);
    });
  }

  private activeTarget(): string | undefined {
    if (this.activeWebviewId !== undefined && this.webviews.has(this.activeWebviewId)) {
      return this.activeWebviewId;
    }
    if (this.sidebarWebviewId !== undefined && this.webviews.has(this.sidebarWebviewId)) {
      return this.sidebarWebviewId;
    }
    return this.webviews.keys().next().value;
  }

  private removeWebview(webviewId: string): void {
    this.webviews.delete(webviewId);
    if (this.sidebarWebviewId === webviewId) this.sidebarWebviewId = undefined;
    if (this.activeWebviewId === webviewId) this.activeWebviewId = this.activeTarget();
  }

  private broadcastInternal(event: string, data: unknown, targetWebviewId?: string): void {
    const msg = { event, data };

    if (targetWebviewId) {
      void this.webviews.get(targetWebviewId)?.postMessage(msg);
    } else {
      this.webviews.forEach((webview) => {
        void webview.postMessage(msg);
      });
    }
  }

  private reloadWebview(webviewId: string): void {
    const webview = this.webviews.get(webviewId);
    if (webview) {
      webview.html = this.getHtml(webviewId, webview);
    }
  }

  reloadAllWebviews(): void {
    this.webviews.forEach((webview, webviewId) => {
      webview.html = this.getHtml(webviewId, webview);
    });
  }

  async resetAllWebviews(): Promise<void> {
    await Promise.all(
      [...this.webviews.keys()].map((webviewId) => this.bridgeHandler.disposeView(webviewId)),
    );
    this.reloadAllWebviews();
  }

  getBaselineContent(sessionId: string, filePath: string): Promise<string> {
    return this.bridgeHandler.getBaselineContent(sessionId, filePath);
  }

  async setYoloModeForActiveSessions(enabled: boolean): Promise<void> {
    await this.bridgeHandler.runtime.setYoloModeForActiveSessions(enabled);
  }

  private getHtml(webviewId: string, webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const baseUri = webview.asWebviewUri(this.extensionUri).toString();
    const nonce = getNonce();

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      `media-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`,
      `worker-src ${webview.cspSource} blob:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Kimi Code</title>
</head>
<body data-baseuri="${baseUri}" data-webviewid="${webviewId}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
