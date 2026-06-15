import * as vscode from "vscode";
import { BridgeHandler } from "./bridge-handler";

interface RpcMessage {
  id: string;
  method: string;
  params?: unknown;
}

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

  constructor(private readonly extensionUri: vscode.Uri) {
    this.bridgeHandler = new BridgeHandler(this.broadcastInternal.bind(this), this.reloadWebview.bind(this));
  }

  /**
   * Reload only this Kimi webview (re-runs the React app's init, re-reading
   * config.toml models / MCP / extension config) without reloading the whole
   * window. Re-assigning `html` reloads the page; the existing
   * `onDidReceiveMessage` listener on the same webview persists.
   */
  private reloadWebview(webviewId: string): void {
    const webview = this.webviews.get(webviewId);
    if (webview) {
      webview.html = this.getHtml(webviewId, webview);
    }
  }

  dispose(): void {
    void this.bridgeHandler.dispose().catch((err) => {
      console.warn("[webview-provider] Error disposing bridge handler:", err);
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webviewId = `sidebar_${crypto.randomUUID()}`;
    this.setupWebview(webviewId, webviewView.webview);

    webviewView.onDidDispose(() => {
      this.bridgeHandler.disposeView(webviewId);
      this.webviews.delete(webviewId);
    });
  }

  createPanel(): vscode.WebviewPanel {
    const webviewId = `panel_${crypto.randomUUID()}`;

    const panel = vscode.window.createWebviewPanel("kimiPanel", "Kimi Code", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    });

    this.setupWebview(webviewId, panel.webview);

    panel.onDidDispose(() => {
      this.bridgeHandler.disposeView(webviewId);
      this.webviews.delete(webviewId);
    });

    return panel;
  }

  broadcast(event: string, data: unknown): void {
    this.broadcastInternal(event, data);
  }

  private setupWebview(webviewId: string, webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webview.html = this.getHtml(webviewId, webview);
    this.webviews.set(webviewId, webview);

    webview.onDidReceiveMessage(async (msg: RpcMessage & { webviewId?: string }) => {
      const result = await this.bridgeHandler.handle(msg, webviewId);
      webview.postMessage(result);
    });
  }

  private broadcastInternal(event: string, data: unknown, targetWebviewId?: string): void {
    const msg = { event, data };

    if (targetWebviewId) {
      this.webviews.get(targetWebviewId)?.postMessage(msg);
    } else {
      this.webviews.forEach((w) => w.postMessage(msg));
    }
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
