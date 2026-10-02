/**
 * Scenario: the Kimi sidebar and one or more editor-tab panels are open at the same time.
 * Responsibilities: an action owned by the sidebar's view/title must reach the sidebar alone —
 * panels hold independent sessions — while genuinely global notifications still reach every view.
 * Wiring: the real KimiWebviewProvider and BridgeHandler; VS Code and the public Node SDK harness
 * boundary are replaced.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/webview-provider.test.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { KimiWebviewProvider } from "../src/KimiWebviewProvider";

const host = vi.hoisted(() => {
  const watcher = {
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  };
  const harness = {
    homeDir: "/tmp/kimi-code-test-home",
    close: vi.fn(async () => undefined),
    getConfig: vi.fn(async () => ({ models: {} })),
    setConfig: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    resumeSession: vi.fn(),
    forkSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
  };

  class Uri {
    readonly scheme = "file";
    readonly authority = "";
    readonly path: string;

    constructor(readonly fsPath: string) {
      this.path = fsPath;
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(join(base.fsPath, ...segments));
    }

    toString(): string {
      return `file://${this.path}`;
    }
  }

  return {
    Uri,
    watcher,
    harness,
    createWebviewPanel: vi.fn(),
    workspaceFolders: [] as Array<{ uri: Uri }>,
  };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  ViewColumn: { One: 1 },
  workspace: {
    get workspaceFolders() {
      return host.workspaceFolders;
    },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    createFileSystemWatcher: () => host.watcher,
    textDocuments: [],
  },
  window: {
    showWarningMessage: vi.fn(async () => undefined),
    createWebviewPanel: (...args: unknown[]) => host.createWebviewPanel(...args),
  },
}));

vi.mock("@moonshot-ai/kimi-code-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@moonshot-ai/kimi-code-sdk")>();
  return {
    ...original,
    createKimiHarness: () => host.harness,
    createKimiHarnessV2: () => host.harness,
  };
});

interface FakeView {
  readonly posted: Array<{ event?: string; data?: unknown }>;
  readonly webview: vscode.Webview;
  /** Captures the provider's onDidDispose callback so a test can close the view like VS Code does. */
  register: (handler: () => void) => void;
  dispose: () => void;
}

function createFakeView(): FakeView {
  const posted: Array<{ event?: string; data?: unknown }> = [];
  let disposeHandler: () => void = () => undefined;

  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (uri: { toString: () => string }) => uri,
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    postMessage: async (message: { event?: string; data?: unknown }) => {
      posted.push(message);
      return true;
    },
  } as unknown as vscode.Webview;

  return {
    posted,
    webview,
    register: (handler) => {
      disposeHandler = handler;
    },
    dispose: () => {
      disposeHandler();
    },
  };
}

function asWebviewView(view: FakeView): vscode.WebviewView {
  return {
    webview: view.webview,
    onDidDispose: (handler: () => void) => {
      view.register(handler);
      return { dispose: () => undefined };
    },
  } as unknown as vscode.WebviewView;
}

function asWebviewPanel(view: FakeView): vscode.WebviewPanel {
  return {
    webview: view.webview,
    onDidDispose: (handler: () => void) => {
      view.register(handler);
      return { dispose: () => undefined };
    },
  } as unknown as vscode.WebviewPanel;
}

let provider: KimiWebviewProvider;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kimi-vscode-provider-"));
  host.workspaceFolders.splice(0, host.workspaceFolders.length, { uri: new host.Uri(root) });
  const context = {
    workspaceState: { get: vi.fn((_key: string, fallback: unknown) => fallback), update: vi.fn() },
    globalStorageUri: new host.Uri(join(root, "global-storage")),
  } as unknown as vscode.ExtensionContext;

  provider = new KimiWebviewProvider(
    new host.Uri(root) as unknown as vscode.Uri,
    context,
    () => undefined,
    () => undefined,
  );
});

afterEach(async () => {
  await provider.shutdown();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("Webview broadcast scope (sidebar actions must not reset editor-tab panels)", () => {
  it("delivers a sidebar-scoped event to the sidebar view only", () => {
    const sidebar = createFakeView();
    const panel = createFakeView();
    host.createWebviewPanel.mockReturnValue(asWebviewPanel(panel));

    provider.resolveWebviewView(asWebviewView(sidebar));
    provider.createPanel();

    provider.broadcastToSidebar("newConversation", {});

    expect(sidebar.posted).toEqual([{ event: "newConversation", data: {} }]);
    expect(panel.posted).toEqual([]);
  });

  it("still delivers an unscoped broadcast to every view", () => {
    const sidebar = createFakeView();
    const panel = createFakeView();
    host.createWebviewPanel.mockReturnValue(asWebviewPanel(panel));

    provider.resolveWebviewView(asWebviewView(sidebar));
    provider.createPanel();

    provider.broadcast("extensionConfigChanged", { config: {} });

    expect(sidebar.posted).toHaveLength(1);
    expect(panel.posted).toHaveLength(1);
  });

  it("drops a sidebar-scoped event when no sidebar view is registered", () => {
    const panel = createFakeView();
    host.createWebviewPanel.mockReturnValue(asWebviewPanel(panel));

    provider.createPanel();

    provider.broadcastToSidebar("newConversation", {});

    expect(panel.posted).toEqual([]);
  });

  it("stops targeting the sidebar view after it is disposed", () => {
    const sidebar = createFakeView();
    const panel = createFakeView();
    host.createWebviewPanel.mockReturnValue(asWebviewPanel(panel));

    provider.resolveWebviewView(asWebviewView(sidebar));
    provider.createPanel();
    sidebar.dispose();

    provider.broadcastToSidebar("newConversation", {});

    expect(sidebar.posted).toEqual([]);
    expect(panel.posted).toEqual([]);
  });
});
