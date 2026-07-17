/**
 * Scenario: Webview file paths and the selected working directory.
 * Responsibilities: directory/search/open paths are scoped, normalized, and symlink-safe;
 * editor mentions use relative paths inside the working directory and absolute paths outside.
 * Wiring: real temporary local files plus the public handler/bridge surfaces;
 * VS Code host APIs are the only stubbed boundary.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/workspace-paths.test.ts
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Session } from "@moonshot-ai/kimi-code-sdk";
import type * as vscode from "vscode";
import { Methods } from "../shared/bridge";
import { BridgeHandler } from "../src/bridge-handler";
import { fileHandlers } from "../src/handlers/file.handler";
import type { HandlerContext } from "../src/handlers/types";
import { FileManager } from "../src/managers/file.manager";
import { SessionRuntime } from "../src/runtime/session-runtime";
import { areSameFsPath, isFsPathInsideOrEqual } from "../src/utils/fs-path";
import { relativeWorkspacePath } from "../src/utils/workspace-path";

const vscodeHost = vi.hoisted(() => {
  function normalizeUriPath(value: string): string {
    const segments: string[] = [];
    for (const segment of value.replaceAll("\\", "/").split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join("/")}`;
  }

  class Uri {
    readonly query: string;

    constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
      readonly fsPath: string,
      query = "",
    ) {
      this.query = query;
    }

    static file(fsPath: string): Uri {
      return new Uri("file", "", normalizeUriPath(fsPath), fsPath);
    }

    static remote(authority: string, fsPath: string): Uri {
      return new Uri("vscode-remote", authority, normalizeUriPath(fsPath), fsPath);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      const path = normalizeUriPath(`${base.path}/${segments.join("/")}`);
      const suffix = segments.join("/");
      const separator = base.fsPath.endsWith("/") ? "" : "/";
      return new Uri(base.scheme, base.authority, path, `${base.fsPath}${separator}${suffix}`);
    }

    static from(parts: { scheme: string; path?: string; query?: string }): Uri {
      const path = parts.path ?? "";
      return new Uri(parts.scheme, "", path, path, parts.query);
    }

    toString(): string {
      return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ""}`;
    }
  }

  class RelativePattern {
    readonly baseUri: Uri;
    readonly base: string;

    constructor(base: Uri, readonly pattern: string) {
      this.baseUri = base;
      this.base = base.fsPath;
    }
  }

  const readDirectory = vi.fn();
  const stat = vi.fn();
  const readFile = vi.fn();
  const findFiles = vi.fn();
  const executeCommand = vi.fn();
  const showWarningMessage = vi.fn();

  return {
    Uri,
    RelativePattern,
    readDirectory,
    stat,
    readFile,
    findFiles,
    executeCommand,
    showWarningMessage,
    workspaceFolders: [] as Array<{ uri: Uri }>,
  };
});

vi.mock("vscode", () => ({
  Uri: vscodeHost.Uri,
  RelativePattern: vscodeHost.RelativePattern,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  QuickPickItemKind: { Separator: -1 },
  workspace: {
    get workspaceFolders() {
      return vscodeHost.workspaceFolders;
    },
    fs: {
      readDirectory: vscodeHost.readDirectory,
      stat: vscodeHost.stat,
      readFile: vscodeHost.readFile,
    },
    findFiles: vscodeHost.findFiles,
    createFileSystemWatcher: () => ({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    }),
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    textDocuments: [],
  },
  commands: { executeCommand: vscodeHost.executeCommand },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: vscodeHost.showWarningMessage,
    showQuickPick: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}));

vi.mock("@moonshot-ai/kimi-code-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@moonshot-ai/kimi-code-sdk")>();
  return {
    ...original,
    createKimiHarness: () => ({
      homeDir: "/tmp/kimi-code-test-home",
      close: vi.fn(),
    }),
  };
});

let root: string;
let fileManager: FileManager;
let bridges: BridgeHandler[];
let sessionRuntimes: SessionRuntime[];
let extraRoots: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kimi-vscode-workspace-paths-"));
  vscodeHost.workspaceFolders.splice(0, vscodeHost.workspaceFolders.length, { uri: vscodeHost.Uri.file(root) });
  vscodeHost.readDirectory.mockImplementation(async (uri: { fsPath: string }) =>
    (await readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [
      entry.name,
      entry.isDirectory() ? 2 : entry.isSymbolicLink() ? 64 : 1,
    ]),
  );
  vscodeHost.stat.mockImplementation((uri: { fsPath: string }) => stat(uri.fsPath));
  vscodeHost.readFile.mockImplementation((uri: { fsPath: string }) => readFile(uri.fsPath));
  vscodeHost.findFiles.mockResolvedValue([]);
  fileManager = new FileManager({} as never, vi.fn());
  bridges = [];
  sessionRuntimes = [];
  extraRoots = [];
});

afterEach(async () => {
  await Promise.all(sessionRuntimes.map((runtime) => runtime.close()));
  await Promise.all(bridges.map((bridge) => bridge.dispose()));
  fileManager.dispose();
  vi.clearAllMocks();
  await Promise.all([root, ...extraRoots].map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Webview workspace paths (selected-directory containment)", () => {
  it("returns no entries when directory traversal is requested", async () => {
    const workDir = join(root, "project");
    await mkdir(workDir);

    const files = await getProjectFiles(workDir, { directory: "../" });

    expect(files).toEqual([]);
    expect(vscodeHost.readDirectory).not.toHaveBeenCalled();
  });

  it("returns no entries when an absolute directory is requested", async () => {
    const workDir = join(root, "project");
    await mkdir(workDir);

    const files = await getProjectFiles(workDir, { directory: join(root, "outside") });

    expect(files).toEqual([]);
    expect(vscodeHost.readDirectory).not.toHaveBeenCalled();
  });

  it("returns no entries when a Windows absolute directory is requested", async () => {
    const workDir = join(root, "project");
    await mkdir(workDir);

    const files = await getProjectFiles(workDir, { directory: "C:\\outside" });

    expect(files).toEqual([]);
    expect(vscodeHost.readDirectory).not.toHaveBeenCalled();
  });

  it("returns no entries when a Windows drive-relative directory is requested", async () => {
    const workDir = join(root, "project");
    await mkdir(workDir);

    const files = await getProjectFiles(workDir, { directory: "C:outside" });

    expect(files).toEqual([]);
    expect(vscodeHost.readDirectory).not.toHaveBeenCalled();
  });

  it("omits a symlink when its target is outside the selected working directory", async () => {
    const workDir = join(root, "project");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workDir), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workDir, "outside-link"));

    const files = await getProjectFiles(workDir, { directory: "." });

    expect(files).toEqual([]);
  });

  it("searches within the selected subdirectory using work-directory-relative results", async () => {
    const workDir = join(root, "project", "subproject");
    const inside = join(workDir, "src", "inside.ts");
    const sibling = join(root, "project", "sibling.ts");
    await mkdir(join(workDir, "src"), { recursive: true });
    await Promise.all([writeFile(inside, "inside"), writeFile(sibling, "sibling")]);
    vscodeHost.findFiles.mockResolvedValue([vscodeHost.Uri.file(inside), vscodeHost.Uri.file(sibling)]);

    const files = await getProjectFiles(workDir, { query: "inside" });

    const include = vscodeHost.findFiles.mock.calls[0]?.[0] as InstanceType<typeof vscodeHost.RelativePattern>;
    expect(include.baseUri.fsPath).toBe(workDir);
    expect(files).toEqual([{ path: "src/inside.ts", name: "inside.ts", isDirectory: false }]);
  });

  it("normalizes native Windows separators during directory navigation", async () => {
    const workDir = join(root, "project");
    await mkdir(join(workDir, "src", "nested"), { recursive: true });
    await writeFile(join(workDir, "src", "nested", "app.ts"), "app");

    const files = await getProjectFiles(workDir, { directory: "src\\nested" });

    expect(files).toEqual([{ path: "src/nested/app.ts", name: "app.ts", isDirectory: false }]);
  });

  it("preserves the remote workspace URI while listing a directory", async () => {
    const remoteRoot = vscodeHost.Uri.remote("ssh-remote+example", "/workspace/project");
    vscodeHost.readDirectory.mockResolvedValue([["remote.ts", 1]]);
    const ctx = createContext(remoteRoot);

    const files = await fileHandlers[Methods.GetProjectFiles]!({ directory: "." }, ctx);

    const requestedUri = vscodeHost.readDirectory.mock.calls[0]?.[0];
    expect(requestedUri).toMatchObject({ scheme: "vscode-remote", authority: "ssh-remote+example" });
    expect(files).toEqual([{ path: "remote.ts", name: "remote.ts", isDirectory: false }]);
  });

  it("refuses to open a symlink whose target lies outside the selected working directory", async () => {
    const workDir = join(root, "project");
    const outside = join(root, "outside.txt");
    await mkdir(workDir);
    await writeFile(outside, "secret");
    await symlink(outside, join(workDir, "secret.txt"));
    const ctx = createContext(vscodeHost.Uri.file(workDir));

    const result = await fileHandlers[Methods.OpenFile]!({ filePath: "secret.txt" }, ctx);

    expect(result).toEqual({ ok: false });
    expect(vscodeHost.executeCommand).not.toHaveBeenCalled();
  });

  it("omits an outside symlink when an SDK Write event requests baseline capture", async () => {
    const workDir = join(root, "project");
    const outsideRoot = await mkdtemp(join(tmpdir(), "kimi-vscode-baseline-outside-"));
    extraRoots.push(outsideRoot);
    const outside = join(outsideRoot, "outside.txt");
    const linkedFile = join(workDir, "linked.txt");
    await mkdir(workDir);
    await writeFile(outside, "secret");
    await symlink(outside, linkedFile);
    const bridge = createBridge();
    let emit!: (event: Event) => void;
    const session = {
      id: "session-1",
      workDir,
      summary: { id: "session-1", workDir },
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
      onEvent(listener: (event: Event) => void) {
        emit = listener;
        return vi.fn();
      },
      close: vi.fn(),
    } as unknown as Session;
    const runtime = new SessionRuntime({
      session,
      legacyApproval: { yolo: false, afk: false },
      broadcast: vi.fn(),
      captureBaseline: (summary, filePath, webviewIds) => {
        bridge.captureFileBaseline(summary, filePath, webviewIds);
      },
      log: vi.fn(),
    });
    sessionRuntimes.push(runtime);

    emit({
      type: "tool.call.started",
      sessionId: "session-1",
      agentId: "main",
      turnId: 1,
      toolCallId: "tool-1",
      name: "Write",
      args: { path: linkedFile },
    });

    await expect(bridge.baselineManager.getChanges({ id: "session-1", workDir })).resolves.toEqual([]);
  });

  it("builds an editor mention relative to the selected working directory", async () => {
    const workDir = join(root, "project", "subproject");
    const inside = join(workDir, "src", "inside.ts");
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(inside, "inside");
    const bridge = createBridge();
    await bridge.handle({ id: "set", method: Methods.SetWorkDir, params: { workDir } }, "view-1");

    const mention = await bridge.getEditorMention(
      "view-1",
      vscodeHost.Uri.file(inside) as vscode.Uri,
      emptySelection(),
    );

    expect(mention).toBe("@src/inside.ts");
  });

  it("builds an absolute editor mention when the file is outside the selected working directory", async () => {
    const workDir = join(root, "project", "subproject");
    const sibling = join(root, "project", "sibling.ts");
    await mkdir(workDir, { recursive: true });
    await writeFile(sibling, "sibling");
    const bridge = createBridge();
    await bridge.handle({ id: "set", method: Methods.SetWorkDir, params: { workDir } }, "view-1");

    const mention = await bridge.getEditorMention(
      "view-1",
      vscodeHost.Uri.file(sibling) as vscode.Uri,
      emptySelection(),
    );

    expect(mention).toBe(`@${sibling}`);
  });

  it("builds an absolute editor mention when the file is outside the workspace root", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "kimi-vscode-mention-outside-"));
    extraRoots.push(otherRoot);
    const outside = join(otherRoot, "App.java");
    await writeFile(outside, "class App {}");
    const bridge = createBridge();

    const mention = await bridge.getEditorMention(
      "view-1",
      vscodeHost.Uri.file(outside) as vscode.Uri,
      emptySelection(),
    );

    expect(mention).toBe(`@${outside}`);
  });

  it("quotes an absolute editor mention whose path contains spaces", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "kimi vscode mention space-"));
    extraRoots.push(otherRoot);
    const outside = join(otherRoot, "App.java");
    await writeFile(outside, "class App {}");
    const bridge = createBridge();

    const mention = await bridge.getEditorMention(
      "view-1",
      vscodeHost.Uri.file(outside) as vscode.Uri,
      emptySelection(),
    );

    expect(mention).toBe(`@"${outside}"`);
  });

  it("places the line range after the closing quote of a mention with spaces", async () => {
    const workDir = join(root, "project");
    const inside = join(workDir, "some dir", "inside.ts");
    await mkdir(join(workDir, "some dir"), { recursive: true });
    await writeFile(inside, "inside");
    const bridge = createBridge();
    await bridge.handle({ id: "set", method: Methods.SetWorkDir, params: { workDir } }, "view-1");

    const mention = await bridge.getEditorMention(
      "view-1",
      vscodeHost.Uri.file(inside) as vscode.Uri,
      { isEmpty: false, start: { line: 2 }, end: { line: 4 } } as vscode.Selection,
    );

    expect(mention).toBe('@"some dir/inside.ts":3-5');
  });

  it("omits an editor mention for a document that is not on the workspace file system", async () => {
    const bridge = createBridge();
    const untitled = vscodeHost.Uri.from({ scheme: "untitled", path: "Untitled-1" });

    const mention = await bridge.getEditorMention(
      "view-1",
      untitled as vscode.Uri,
      emptySelection(),
    );

    expect(mention).toBeNull();
  });

  it("rejects a selected working directory whose symlink target leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "kimi-vscode-outside-"));
    extraRoots.push(outside);
    const linkedWorkDir = join(root, "linked-project");
    await symlink(outside, linkedWorkDir);
    const bridge = createBridge();

    const result = await bridge.handle(
      { id: "set", method: Methods.SetWorkDir, params: { workDir: linkedWorkDir } },
      "view-1",
    );

    expect(result).toEqual({ id: "set", result: { ok: false } });
  });
});

describe("native workspace path comparison (Windows drive and UNC semantics)", () => {
  it("treats slash and casing differences as the same Windows drive path", () => {
    expect(areSameFsPath("C:\\Users\\Example User\\项目", "c:/users/example user/项目")).toBe(true);
  });

  it("keeps an in-share UNC child relative to its workspace", () => {
    const rootUri = vscodeHost.Uri.file("\\\\Server\\Share\\Workspace");
    const childUri = vscodeHost.Uri.file("\\\\server\\share\\workspace\\src\\app.ts");

    expect(relativeWorkspacePath(rootUri as vscode.Uri, childUri as vscode.Uri)).toBe("src/app.ts");
  });

  it("rejects a UNC path from another share", () => {
    expect(
      isFsPathInsideOrEqual(
        "\\\\Server\\Share\\Workspace",
        "\\\\Server\\OtherShare\\Workspace\\app.ts",
      ),
    ).toBe(false);
  });
});

async function getProjectFiles(workDir: string, params: { query?: string; directory?: string }) {
  return fileHandlers[Methods.GetProjectFiles]!(params, createContext(vscodeHost.Uri.file(workDir)));
}

function createContext(workDirUri: InstanceType<typeof vscodeHost.Uri>): HandlerContext {
  return {
    webviewId: "view-1",
    workDir: workDirUri.fsPath,
    workDirUri: workDirUri as vscode.Uri,
    workspaceRoot: root,
    workspaceRootUri: vscodeHost.workspaceFolders[0]!.uri as vscode.Uri,
    workspaceState: {} as vscode.Memento,
    requireWorkDir: () => workDirUri.fsPath,
    requireWorkDirUri: () => workDirUri as vscode.Uri,
    fileManager,
  } as HandlerContext;
}

function createBridge(): BridgeHandler {
  const bridge = new BridgeHandler(
    vi.fn(),
    { get: vi.fn(), update: vi.fn() } as unknown as vscode.Memento,
    join(root, "global-storage"),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  bridges.push(bridge);
  return bridge;
}

function emptySelection(): vscode.Selection {
  return {
    isEmpty: true,
    start: { line: 0 },
    end: { line: 0 },
  } as vscode.Selection;
}
